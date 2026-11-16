import { describe, expect, it } from "vitest";
import {
  type Candidate, type DialPreset, type Entity, type PlaceholderId, type PrivacyCategory, EgressGate, EntityMap, GateBlocked, PatternDetector, PolicyEngine,
  Sealer, VaultMatcher, actionString, generalise, makeEntity, merge, normalise, parseAction, parsePlaceholderId, type UserOverride, type VaultEntry, fold, DEFAULT_POLICY_SETTINGS,
  renderedLegend, mustNotEgress, bucket, findMoney, ageDescription, relativeDescription, ladderDefault, validateRewrite, rewriteRole,
} from "../src/engine";
import { fixture } from "./support";

const patterns = new PatternDetector();
const utc = (s: string): Date => new Date(`${s}T00:00:00Z`);

interface FEntity { id: string; category: string; canonical: string; surfaceForms: string[]; action: string; vaultEntryId?: string }
const toEntity = (f: FEntity): Entity =>
  makeEntity({ id: f.id, category: f.category as PrivacyCategory, canonical: f.canonical, surfaceForms: new Set(f.surfaceForms), action: parseAction(f.action), sources: new Set(["llm"]), confidence: "high", vaultEntryId: f.vaultEntryId ?? null });
interface FVault { id: string; canonical: string; aliases: string[]; category: string; roleHint: string | null; isUser: boolean }
const toVault = (v: FVault): VaultEntry => ({ ...v, category: v.category as PrivacyCategory });

describe("policy (spec/fixtures/policy.json)", () => {
  type Fx = { cases: { dial: string; category: string; subtype: string | null; canonical: string; expected: string; vault: boolean; protectHealth: boolean; override: { action: string; revealThisTime: boolean } | null }[] };
  it("matches every case", () => {
    const f = fixture<Fx>("policy.json");
    expect(f.cases.length).toBeGreaterThanOrEqual(40);
    for (const c of f.cases) {
      const engine = new PolicyEngine(c.dial as DialPreset, { ...DEFAULT_POLICY_SETTINGS, protectHealth: c.protectHealth });
      const e = makeEntity({ id: c.category === "quasi" ? "PERSON_ME" : `${{ person: "PERSON", org: "ORG", location: "LOC", contact: "CONTACT", id: "ID", date: "DATE", health: "HEALTH", secret: "SECRET" }[c.category]}_1`, category: c.category as PrivacyCategory, canonical: c.canonical, sources: new Set(["llm"]), confidence: "high", subtype: c.subtype, vaultEntryId: c.vault ? "v" : null });
      const o: UserOverride | undefined = c.override ? { action: parseAction(c.override.action), revealThisTime: c.override.revealThisTime } : undefined;
      expect(actionString(engine.action(e, o)), `${c.dial} ${c.category}/${c.subtype} override=${JSON.stringify(c.override)}`).toBe(c.expected);
    }
  });
  it("modes per dial", () => {
    expect(new PolicyEngine("open").redTeamMode).toBe("off");
    expect(new PolicyEngine("balanced").reviewMode).toBe("ifLowConfidenceOrRisk");
    expect(new PolicyEngine("strict").reviewMode).toBe("always");
    expect(new PolicyEngine("strict").bucketsMoney).toBe(true);
  });
});

describe("merger (spec/fixtures/merge.json)", () => {
  type FC = { start: number; end: number; text: string; category: string; detector: string; subtype?: string; sameAs?: string; vaultEntryId?: string; roleHint?: string };
  type Fx = { cases: { name: string; text: string; vault: FVault[]; candidates: FC[]; existing: FEntity[]; expect: { entities: { id: string; canonical: string; formsInclude?: string[]; confidence?: string; vaultEntryId?: string }[]; mentions: string[][]; ambiguous: string[][] } }[] };
  it("matches every case", () => {
    for (const c of fixture<Fx>("merge.json").cases) {
      const cands: Candidate[] = c.candidates.map((x) => ({ span: { start: x.start, end: x.end }, text: x.text, category: x.category as PrivacyCategory, subtype: x.subtype ?? null, detector: x.detector as Candidate["detector"], confidence: "high", roleHint: x.roleHint ?? null, sameAs: x.sameAs ?? null, vaultEntryId: x.vaultEntryId ?? null }));
      const r = merge(cands, c.text, new EntityMap(c.existing.map(toEntity)), c.vault.map(toVault));
      for (const e of c.expect.entities) {
        const got = r.entities.get(e.id);
        expect(got, `[${c.name}] missing ${e.id}; have ${r.entities.keys()}`).toBeDefined();
        expect(got!.canonical, `[${c.name}] canonical of ${e.id}`).toBe(e.canonical);
        for (const f of e.formsInclude ?? []) expect(got!.surfaceForms.has(f), `[${c.name}] ${e.id} forms lack ${f}`).toBe(true);
        if (e.confidence) expect(got!.confidence).toBe(e.confidence);
        if (e.vaultEntryId) expect(got!.vaultEntryId).toBe(e.vaultEntryId);
      }
      expect(r.entities.size, `[${c.name}] entity count`).toBe(c.expect.entities.length);
      expect(r.mentions.map((m) => [m.text, m.entityId]), `[${c.name}] mentions`).toEqual(c.expect.mentions);
      expect(new Set(r.ambiguous.map((a) => `${a.entity}>${a.possiblySameAs}`)), `[${c.name}] ambiguous`).toEqual(new Set(c.expect.ambiguous.map((a) => `${a[0]}>${a[1]}`)));
    }
  });
  it("ids follow first appearance", () => {
    const text = "Lena met Omar and Lena left.";
    const mk = (t: string, s: number): Candidate => ({ span: { start: s, end: s + 4 }, text: t, category: "person", detector: "llm", confidence: "high" });
    expect(merge([mk("Omar", 9), mk("Lena", 0), mk("Lena", 18)], text).mentions.map((m) => m.entityId)).toEqual(["PERSON_1", "PERSON_2", "PERSON_1"]);
  });
});

describe("generaliser and money", () => {
  const today = utc("2026-11-21");
  const dateEntity = (canonical: string, subtype: string): Entity => makeEntity({ id: "DATE_1", category: "date", canonical, sources: new Set(["pattern"]), confidence: "high", subtype });
  it("ages from a date of birth", () => {
    expect(ladderDefault(dateEntity("4 Mar 1989", "dob"), 2, today)).toBe("late 30s");
    expect(ladderDefault(dateEntity("4 Mar 1989", "dob"), 3, today)).toBe("30s");
    expect(ladderDefault(dateEntity("2010-05-01", "dob"), 2, today)).toBe("a teenager");
    expect(ageDescription(utc("2010-12-25"), today, false)).toBe("a teenager");
  });
  it("relative dates", () => {
    for (const [raw, expected] of [["Oct 28", "3 weeks ago"], ["2026-11-20", "yesterday"], ["21/11/2026", "today"], ["Dec 5, 2026", "in 2 weeks"], ["2025-11-21", "about 1 year ago"], ["not a date", "a recent date"]] as const) {
      expect(ladderDefault(dateEntity(raw, "date"), 1, today), raw).toBe(expected);
    }
    expect(relativeDescription(utc("2026-11-22"), today)).toBe("tomorrow");
  });
  it("validates model rewrites", () => {
    const map = new EntityMap([makeEntity({ id: "ORG_1", category: "org", canonical: "Mercy General Hospital", surfaceForms: new Set(["Mercy General"]), action: generalise(2), sources: new Set(["llm"]), confidence: "high" })]);
    const ok = (r: string): boolean => validateRewrite(r, "Mercy General Hospital", map, patterns);
    expect(ok("a large hospital")).toBe(true);
    for (const bad of ["", "a very large and busy teaching hospital in the city centre", "Mercy General Hospital", "the Mercy General campus", "call 312-555-0147", "[[ORG_1]]"]) expect(ok(bad), bad).toBe(false);
  });
  it("money buckets", () => {
    expect(bucket(1240, "$")).toBe("$1,000–1,500");
    expect(bucket(85, "€")).toBe("€85–90");
    expect(bucket(7, "£")).toBe("under £10");
    expect(findMoney("Rent is $1,240.50 and ₹45000, not 1,240.").map((h) => h.bucket)).toEqual(["$1,000–1,500", "₹45,000–50,000"]);
  });
  it("role rewriting", () => {
    expect(rewriteRole("the writer's landlord")).toBe("the user's landlord");
    expect(rewriteRole("my sister")).toBe("the user's sister");
    expect(rewriteRole("me")).toBe("the user");
    expect(rewriteRole("landlord")).toBe("the user's landlord");
    expect(rewriteRole("a coworker")).toBe("a coworker");
  });
});

/** The deterministic pipeline as the app runs it (minus the on-device LLM, whose candidates are given). */
function runPipeline(raw: string, vault: VaultEntry[], llm: Candidate[], dial: DialPreset, today: Date, overrides = new Map<PlaceholderId, UserOverride>(), existing = new EntityMap()) {
  const n = normalise(raw);
  const candidates = [...new VaultMatcher(vault).detect(n.text), ...patterns.detect(n.text), ...llm];
  const m = merge(candidates, n.text, existing, vault);
  return { draft: new Sealer(new PolicyEngine(dial), patterns, today).draft(n, m, overrides), merge: m, normalised: n };
}

describe("seal pipeline (spec/fixtures/seal.json)", () => {
  type Fx = { cases: { name: string; dial: string; today: string; text: string; expectedText: string; vault: FVault[]; llm: { start: number; end: number; text: string; category: string; detector: string; subtype?: string; roleHint?: string }[]; overrides: { id: string; action: string; revealThisTime: boolean }[]; expectedLegend: string[][] }[] };
  it("matches every case and the gate accepts every draft", () => {
    for (const c of fixture<Fx>("seal.json").cases) {
      const llm: Candidate[] = c.llm.map((x) => ({ span: { start: x.start, end: x.end }, text: x.text, category: x.category as PrivacyCategory, subtype: x.subtype ?? null, detector: "llm", confidence: "high", roleHint: x.roleHint ?? null }));
      const vault = c.vault.map(toVault);
      const overrides = new Map(c.overrides.map((o) => [o.id, { action: parseAction(o.action), revealThisTime: o.revealThisTime }] as const));
      const run = runPipeline(c.text, vault, llm, c.dial as DialPreset, utc(c.today), overrides);
      expect(run.draft.text, `[${c.name}]`).toBe(c.expectedText);
      expect(run.draft.legend.map((l) => [l.placeholder, l.description]), `[${c.name}] legend`).toEqual(c.expectedLegend);
      expect(() => new EgressGate(patterns, vault).seal(run.draft), `[${c.name}] gate must pass`).not.toThrow();
    }
  });
  it("replacements map back", () => {
    const vault = [{ id: "v", canonical: "Raj", aliases: [], category: "person" as const, roleHint: "my landlord", isUser: false }];
    const run = runPipeline("Hi Raj, call 312-555-0147.", vault, [], "balanced", new Date());
    for (const r of run.draft.replacements) expect(run.draft.text.slice(r.sealedSpan.start, r.sealedSpan.end)).toBe(`[[${r.entityId}]]`);
    expect(run.draft.text).toBe("Hi [[PERSON_1]], call [[CONTACT_1]].");
  });
  it("a leaky role hint falls back to a neutral description", () => {
    const llm: Candidate[] = [{ span: { start: 0, end: 11 }, text: "Lena Okafor", category: "person", detector: "llm", confidence: "high", roleHint: "Okafor's manager at a@b.co" }];
    expect(runPipeline("Lena Okafor emailed.", [], llm, "balanced", new Date()).draft.legend[0]?.description).toBe("a person mentioned in the message");
  });
});

describe("egress gate (spec/fixtures/gate.json)", () => {
  type Fx = { cases: { name: string; text: string; legend: string[][]; entities: FEntity[]; vault: FVault[]; revealed: string[]; kept: string[]; mustInclude: string[]; toolResult: boolean; pass: boolean; maxUTF16: number | null }[] };
  it("matches every case", () => {
    for (const c of fixture<Fx>("gate.json").cases) {
      const gate = new EgressGate(patterns, c.vault.map(toVault), { maxUtf16: c.maxUTF16 ?? 40_000 });
      const map = new EntityMap(c.entities.map(toEntity));
      const legend = c.legend.map(([p, d]) => ({ placeholder: p!, description: d! }));
      let blocked: GateBlocked | null = null;
      try {
        const sealed = c.toolResult
          ? gate.sealToolResult(c.text, map)
          : gate.seal({ text: c.text, legend, replacements: [], entities: map, secretWarnings: [], revealedVaultIds: new Set(c.revealed), keptValues: new Set(c.kept.map((k) => fold(k))) });
        expect(c.pass, `[${c.name}] should have been blocked`).toBe(true);
        expect(sealed.value).toBe(c.text);
        expect(sealed.gateReport.checksPassed).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7"]);
        expect(sealed.gateReport.bypassed).toBe(false);
      } catch (e) {
        if (!(e instanceof GateBlocked)) throw e;
        blocked = e;
      }
      if (blocked) {
        expect(c.pass, `[${c.name}] false block: ${[...blocked.checks]}`).toBe(false);
        for (const must of c.mustInclude) expect([...blocked.checks], `[${c.name}] expected ${must}`).toContain(must);
      }
    }
  });
  it("the error carries no values (INV-8)", () => {
    const gate = new EgressGate(patterns, [{ id: "v", canonical: "Maya Chen", aliases: [], category: "person", isUser: false }]);
    try {
      gate.seal({ text: "From Maya Chen, maya@example.com", legend: [], replacements: [], entities: new EntityMap(), secretWarnings: [], revealedVaultIds: new Set(), keptValues: new Set() });
      expect.unreachable();
    } catch (e) {
      const dump = JSON.stringify(e) + String(e) + (e as Error).message;
      expect(dump).not.toMatch(/Maya|example\.com/);
      expect((e as GateBlocked).checks).toEqual(new Set(["G1", "G3"]));
    }
  });
  it("hashes text and legend; debug bypass is opt-in", () => {
    const e = makeEntity({ id: "PERSON_1", category: "person", canonical: "Raj Patel", sources: new Set(["llm"]), confidence: "high" });
    const draft = { text: "Hi [[PERSON_1]].", legend: [{ placeholder: "PERSON_1", description: "the user's landlord" }], replacements: [], entities: new EntityMap([e]), secretWarnings: [], revealedVaultIds: new Set<string>(), keptValues: new Set<string>() };
    const sealed = new EgressGate(patterns, []).seal(draft);
    expect(renderedLegend(sealed)).toBe("[[PERSON_1]] — the user's landlord");
    expect(sealed.gateReport.counts["person"]).toBe(1);
    expect(() => new EgressGate(patterns, []).sealBypassingChecks(draft)).toThrow(/disabled/);
    const bypassed = new EgressGate(patterns, [], undefined, true).sealBypassingChecks({ ...draft, text: "card 4111 1111 1111 1111" });
    expect(bypassed.gateReport.bypassed && bypassed.gateReport.checksPassed.length === 0).toBe(true);
    expect(mustNotEgress({ kind: "keep" })).toBe(false);
    expect(parsePlaceholderId("PERSON_ME")?.index).toBe("ME");
  });
});
