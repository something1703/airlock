import { describe, expect, it } from "vitest";
import {
  locate,
  BUNDLED_PROMPT_IDS, EgressGate, EngineError, EntityMap, LLMDetector, MockEngines, MockPhoneEngine, MockSealedEngine, PatternDetector, PromptError,
  PromptLibrary, ReceiptLedger, RedTeam, SealPipeline, answer, applyRisks, chunks, estimateTokens, halve, isValidSuggestion, makeEntity, pendingRisks,
  route as routeOf, taskSpec, CHROME_ON_DEVICE_MODEL, type AnswerEvent, type AnswerOutcome, type Risk, type SealDraft, type SealedText, type VaultEntry,
} from "../src/engine";
import { KEEP } from "../src/engine/types";
import { AppConfig } from "../src/core/appConfig";
import { sealSettings } from "../src/engine/pipeline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { int, pick, repoRoot, rng } from "./support";

const patterns = new PatternDetector();
const prompts = new PromptLibrary();
const utc = (s: string): Date => new Date(`${s}T00:00:00Z`);

describe("prompt library", () => {
  it("bundles every prompt, byte-identical to the Swift package", () => {
    expect(BUNDLED_PROMPT_IDS.length).toBe(23);
    for (const id of BUNDLED_PROMPT_IDS) {
      const swift = readFileSync(join(repoRoot, "Packages/AirlockKit/Sources/AirlockPrompts/Prompts", `${id}.txt`), "utf8");
      expect(prompts.template(id) + "\n", `${id} drifted — run npm run sync-packs`).toBe(swift);
    }
  });
  it("renders in a single pass and rejects unfilled variables", () => {
    expect(prompts.render("detect.v1", { chunk: "hi {{task_instruction}} there" })).toContain("hi {{task_instruction}} there");
    expect(() => prompts.render("gen.v1", {})).toThrow(PromptError);
  });
  it("applies Remote Config overrides; ignores malformed JSON", () => {
    expect(new PromptLibrary('{"title.v1":"T: {{sealed_first_message}}"}').render("title.v1", { sealed_first_message: "x" })).toBe("T: x");
    expect(new PromptLibrary("not json").template("title.v1")).toBe(prompts.template("title.v1"));
  });
});

describe("chunker", () => {
  it("token estimates", () => {
    expect(estimateTokens("a".repeat(320))).toBe(100);
    expect(estimateTokens("漢".repeat(180))).toBe(100);
  });
  it("covers the text, respects the budget, overlaps (300 random documents)", () => {
    const r = rng(99);
    const words = ["The", "heater", "broke", "again", "and", "Raj", "said", "he", "would", "call", "tomorrow", "morning", "東京", "Привет"];
    for (let n = 0; n < 300; n++) {
      const text = Array.from({ length: int(r, 1, 40) }, () => Array.from({ length: int(r, 1, 30) }, () => pick(r, words)).join(" ") + ".").join(" ");
      const budget = int(r, 60, 400);
      const cs = chunks(text, budget);
      expect(cs[0]!.span.start).toBe(0);
      expect(cs.at(-1)!.span.end).toBe(text.length);
      for (let i = 1; i < cs.length; i++) {
        expect(cs[i]!.span.start).toBeLessThanOrEqual(cs[i - 1]!.span.end);
        expect(cs[i]!.span.start).toBeGreaterThan(cs[i - 1]!.span.start);
      }
      for (const c of cs) {
        expect(estimateTokens(c.text)).toBeLessThanOrEqual(budget);
        expect(text.slice(c.span.start, c.span.end)).toBe(c.text);
      }
    }
  });
  it("halves near the middle", () => {
    const text = "one two three four five six seven eight";
    const halves = halve(chunks(text, 1000)[0]!, text);
    expect(halves.length).toBe(2);
    expect(halves.map((h) => h.text).join("")).toBe(text);
  });
});

describe("LLM detector (mocked on-device model)", () => {
  const text = "Hi Raj, I work at Mercy General Hospital near the old mill.";
  const detect = async (t: string, handler: (id: string, p: string) => string | Promise<string>, budget = 1400) => {
    const phone = new MockPhoneEngine(handler);
    return { r: await new LLMDetector(phone, prompts, budget).detect(t), phone };
  };
  it("valid JSON", async () => {
    const { r, phone } = await detect(text, () => '{"items":[{"text":"Raj","type":"PERSON","role":"the writer\'s landlord","confidence":"high"},{"text":"Mercy General Hospital","type":"ORG","confidence":"high"}]}');
    expect(r.candidates.map((c) => c.text)).toEqual(["Raj", "Mercy General Hospital"]);
    expect(phone.calledPromptIds).toEqual(["detect.v1"]);
    expect(phone.calls[0]!.text).toContain("Mercy General Hospital");
  });
  it("fenced JSON with prose; hallucinations dropped", async () => {
    const { r } = await detect(text, () => 'Sure!\n```json\n{"items":[{"text":"Raj","type":"PERSON"},{"text":"Priya Shah","type":"PERSON"}]}\n```\nbye {x}');
    expect(r.candidates.map((c) => c.text)).toEqual(["Raj"]);
    expect(r.hallucinatedDropped).toBe(1);
  });
  it("broken JSON → one repair; broken twice → chunk failed", async () => {
    const a = await detect(text, (id) => (id === "detect.v1" ? '{"items":[{"text":"Raj"' : '{"items":[{"text":"Raj","type":"PERSON"}]}'));
    expect(a.phone.calledPromptIds).toEqual(["detect.v1", "detect-repair.v1"]);
    expect(a.r.candidates.map((c) => c.text)).toEqual(["Raj"]);
    const b = await detect(text, () => "no json");
    expect(b.r.failedChunks).toEqual([0]);
  });
  it("refusal reported; context too long halves and retries; unavailable skips the model", async () => {
    expect((await detect(text, () => { throw new EngineError("refused"); })).r.refusedChunks).toEqual([0]);
    let calls = 0;
    const { r } = await detect(text, (_id, p) => {
      if (calls++ === 0) throw new EngineError("contextTooLong");
      return p.includes("Raj") ? '{"items":[{"text":"Raj","type":"PERSON"}]}' : '{"items":[]}';
    });
    expect(r.candidates.map((c) => c.text)).toEqual(["Raj"]);
    expect(calls).toBe(3);
    const phone = MockPhoneEngine.answering("{}", "downloadable");
    const u = await new LLMDetector(phone, prompts, 1400).detect(text);
    expect(u.unavailable).toBe("downloadable");
    expect(phone.calls.length).toBe(0);
  });
  it("multi-chunk offsets are global", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} mentions nobody at all here.`).join(" ") + " Finally Lena Okafor called.";
    const { r } = await detect(long, (_id, p) => (p.includes("Lena Okafor") ? '{"items":[{"text":"Lena Okafor","type":"PERSON"}]}' : '{"items":[]}'), 120);
    expect(r.chunkCount).toBeGreaterThan(3);
    expect(r.candidates.length).toBe(1);
    expect(long.slice(r.candidates[0]!.span.start, r.candidates[0]!.span.end)).toBe("Lena Okafor");
  });
});

const raj = makeEntity({ id: "PERSON_1", category: "person", canonical: "Raj Patel", surfaceForms: new Set(["Raj Patel", "Raj"]), sources: new Set(["vault"]), confidence: "high" });
const org = makeEntity({ id: "ORG_1", category: "org", canonical: "Harbor View Clinic", surfaceForms: new Set(["Harbor View Clinic"]), action: { kind: "generalise", level: 2 }, generalisedText: "a clinic", sources: new Set(["llm"]), confidence: "high" });
const draftOf = (text: string): SealDraft => ({ text, legend: [{ placeholder: "PERSON_1", description: "the user's landlord" }], replacements: [], entities: new EntityMap([raj, org]), secretWarnings: [], revealedVaultIds: new Set(), keptValues: new Set() });
const guesses = (items: [string, string, string][]): string => JSON.stringify({ guesses: items.map(([attribute, evidence, confidence]) => ({ attribute, guess: "g", evidence, confidence })) });

describe("red-team loop", () => {
  const text = "I'm the only night nurse at a clinic near the old mill, and [[PERSON_1]] keeps calling.";
  const team = (attack: (n: number) => string, rewrite: (phrase: string) => string) => {
    let n = 0;
    const phone = new MockPhoneEngine((id, p) => {
      if (id === "attack.v1") return attack(n++);
      const phrase = p.split("Phrase to rewrite: ")[1]?.split("\n")[0] ?? "";
      return JSON.stringify({ rewrite: rewrite(phrase) });
    });
    return { rt: new RedTeam(phone, prompts, patterns), phone };
  };
  it("filters guesses and caps them", async () => {
    const { rt } = team(() => guesses([["location", "near the old mill", "medium"], ["occupation", "night nurse", "low"], ["location", "the lighthouse", "high"], ["hobby", "keeps calling", "high"], ["identity", "[[PERSON_1]]", "high"]]), () => "in the area");
    const r = await rt.run(draftOf(text), "suggest", 2, "help");
    expect(r.risks.map((x) => x.evidence)).toEqual(["near the old mill"]);
    expect(r.risks[0]!.suggestion).toBe("in the area");
    expect(r.draft.text).toBe(text);
  });
  it("rejects leaky or placeholder-changing suggestions", () => {
    const map = new EntityMap([raj, org]);
    expect(isValidSuggestion("[[PERSON_1]]'s office", "[[PERSON_1]]'s office at the old mill", map, patterns)).toBe(true);
    expect(isValidSuggestion("[[PERSON_2]]'s office", "[[PERSON_1]]'s office at the old mill", map, patterns)).toBe(false);
    expect(isValidSuggestion("an office near Harbor View", "the office at the old mill", map, patterns)).toBe(false);
  });
  it("strict auto-applies over two rounds; gate counts it", async () => {
    const { rt, phone } = team((n) => (n === 0 ? guesses([["location", "near the old mill", "high"]]) : guesses([["occupation", "the only night nurse", "high"]])), (p) => (p.includes("mill") ? "in the area" : "a nurse"));
    const r = await rt.run(draftOf(text), "autoApply", 2, "help");
    expect(r.draft.text).toBe("I'm a nurse at a clinic in the area, and [[PERSON_1]] keeps calling.");
    expect(new Set(phone.calledPromptIds)).toEqual(new Set(["attack.v1", "gen.v1"]));
    expect(new EgressGate(patterns, []).seal(r.draft).gateReport.counts["redteamApplied"]).toBe(2);
  });
  it("off makes no calls; failures mark unavailable; apply is idempotent", async () => {
    const { rt, phone } = team(() => "", () => "");
    expect((await rt.run(draftOf(text), "off", 2, "h")).risks).toEqual([]);
    expect(phone.calls.length).toBe(0);
    expect((await new RedTeam(MockPhoneEngine.answering("nope"), prompts, patterns).run(draftOf(text), "suggest", 2, "h")).unavailable).toBe(true);
    const risks: Risk[] = [{ id: 1, attribute: "location", guess: "", evidence: "near the old mill", confidence: "high", suggestion: "in the area" }];
    const once = applyRisks(risks, draftOf(text));
    expect(applyRisks(risks, once).text).toBe(once.text);
  });
});

describe("Protect this (user-marked details)", () => {
  const vault: VaultEntry[] = [{ id: "v-raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false }];
  const raw = "Hi Raj, I work nights at Mercy General Hospital. Mercy General Hospital is far from 14 Elm St.";
  // Rules only: the on-device model is unavailable, so the org name is missed (INV-9 path).
  const pl = () => new SealPipeline(MockPhoneEngine.answering("", "unavailable"), new PatternDetector(), vault, new PromptLibrary(), sealSettings(new AppConfig(), { dial: "balanced" }));

  it("protects every occurrence, keeps existing placeholder numbers and the user's toggles, and passes the gate", async () => {
    const p = pl();
    const r = await p.run(raw);
    expect(r.draft.text).toContain("Mercy General Hospital");
    const raj = r.draft.entities.sorted().find((e) => e.canonical === "Raj Patel")!;
    const overrides = new Map([[raj.id, { action: KEEP, revealThisTime: true }]]);
    const kept = p.reseal(r, overrides);
    expect(kept.draft.text).toContain("Raj");

    const { result: protectedR, overrides: after } = p.protect(kept, "mercy general hospital", "org", overrides);
    expect(after.get("ORG_1")?.action).toEqual({ kind: "placeholder" });
    expect(after.get(raj.id)?.action).toEqual({ kind: "keep" });
    expect(protectedR.draft.text).not.toContain("Mercy");
    expect(protectedR.draft.text.match(/\[\[ORG_1\]\]/g)).toHaveLength(2);
    expect(protectedR.draft.entities.get(raj.id)?.canonical).toBe("Raj Patel");
    expect(protectedR.draft.text).toContain("Raj");
    expect(protectedR.draft.entities.get("ORG_1")?.sources.has("user")).toBe(true);
    expect(() => new EgressGate(new PatternDetector(), vault).seal(protectedR.draft)).not.toThrow();
  });

  it("is a no-op for text that isn't there or is only whitespace", async () => {
    const p = pl();
    const r = await p.run(raw);
    expect(p.protect(r, "Nowhere Clinic", "org", new Map()).result).toBe(r);
    expect(p.protect(r, "   ", "org", new Map()).result).toBe(r);
  });

  it("a user mark inside an existing detection wins (user > vault > pattern > llm)", async () => {
    const p = pl();
    const r = await p.run("Visit 14 Elm St tomorrow");
    const out = p.protect(r, "Elm", "location", new Map()).result;
    expect(out.draft.text).not.toContain("Elm");
  });
});

describe("red-team locate", () => {
  it("finds evidence case-insensitively even when the draft is already lower-case (regression)", () => {
    expect(locate("Near the old mill", "we live near the old mill.")).toEqual([{ start: 8, end: 25 }]);
    expect(locate("near the old mill", "We live Near The Old Mill.")).toEqual([{ start: 8, end: 25 }]);
    expect(locate("old mill", "the old miller")).toEqual([]);
    expect(locate("Mill", "a Mill and a mill")).toEqual([{ start: 2, end: 6 }]);
  });
});

describe("seal pipeline", () => {
  const raw = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. Thanks, Maya Chen";
  const vault: VaultEntry[] = [
    { id: "v-me", canonical: "Maya Chen", aliases: ["Maya"], category: "person", roleHint: "me", isUser: true },
    { id: "v-raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false },
  ];
  const detectAnswer = '{"items":[{"text":"Mercy General Hospital","type":"ORG","role":"the writer\'s employer","confidence":"high"}]}';
  const phone = (rewrite = "a large hospital", attack = '{"guesses":[]}') => new MockPhoneEngine((id) => (id === "gen.v1" ? JSON.stringify({ rewrite }) : id === "attack.v1" ? attack : detectAnswer));
  const pipe = (p: MockPhoneEngine, dial: "open" | "balanced" | "strict" = "balanced") => new SealPipeline(p, patterns, vault, prompts, sealSettings(new AppConfig(), { dial, today: utc("2026-11-21") }));

  it("happy path uses a validated on-device rewrite and passes the gate", async () => {
    const p = phone();
    const r = await pipe(p).run(raw);
    expect(r.draft.text).toBe("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken since Oct 28. I work nights at a large hospital. Thanks, [[PERSON_ME]]");
    expect(p.calledPromptIds).toEqual(["detect.v1", "gen.v1", "attack.v1"]);
    expect(r.requiresReview).toBe(false);
    expect(() => new EgressGate(patterns, vault).seal(r.draft)).not.toThrow();
  });
  it("a leaky rewrite falls back to the ladder default", async () => {
    const r = await pipe(phone("the Mercy General campus")).run(raw);
    expect(r.draft.text).toContain("I work nights at an organisation.");
    expect(r.draft.text).not.toContain("Mercy");
  });
  it("INV-9: no on-device model → rules only, review forced, nothing asked of any model", async () => {
    const p = MockPhoneEngine.answering(detectAnswer, "unavailable");
    const r = await pipe(p, "open").run(raw);
    expect(p.calls.length).toBe(0);
    expect(r.requiresReview).toBe(true);
    expect(r.reasons).toContainEqual({ kind: "phoneUnavailable", availability: "unavailable" });
    expect(r.draft.text).toContain("[[PERSON_1]]");
    expect(() => new EgressGate(patterns, vault).seal(r.draft)).not.toThrow();
  });
  it("staged (web): balanced shows the draft before the red-team finishes; strict waits", async () => {
    const townRaw = "Hi Raj, I work nights at Mercy General Hospital near the old mill. Thanks, Maya Chen";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const p = new MockPhoneEngine((id, prompt) => (id === "attack.v1" ? guesses([["location", "near the old mill", "medium"]]) : id === "gen.v1" ? JSON.stringify({ rewrite: prompt.includes("Phrase to rewrite: Mercy General Hospital") ? "a large hospital" : "in the area" }) : detectAnswer));
    const slow = { availability: () => p.availability(), respond: async (q: Parameters<MockPhoneEngine["respond"]>[0], o: Parameters<MockPhoneEngine["respond"]>[1]) => { if (q.promptId === "attack.v1") await gate; return p.respond(q, o); } };
    const pl = new SealPipeline(slow, patterns, vault, prompts, sealSettings(new AppConfig(), { dial: "balanced", today: utc("2026-11-21") }));
    const { result, later } = await pl.runStaged(townRaw);
    expect(result.redTeamPending).toBe(true);
    expect(result.risks).toEqual([]);
    expect(result.draft.text).toContain("a large hospital");
    expect(later).not.toBeNull();
    release();
    const full = await later!;
    expect(full.redTeamPending).toBe(false);
    expect(full.risks).toHaveLength(1);
    expect(full.draft.text).toBe(result.draft.text);
    expect(full.reasons).toContainEqual({ kind: "risks", count: 1 });

    const strict = await pipe(new MockPhoneEngine((id, prompt) => (id === "attack.v1" ? guesses([["location", "near the old mill", "medium"]]) : id === "gen.v1" ? JSON.stringify({ rewrite: prompt.includes("Phrase to rewrite: Mercy General Hospital") ? "a large hospital" : "in the area" }) : detectAnswer)), "strict").runStaged(townRaw);
    expect(strict.later).toBeNull();
    expect(strict.result.redTeamPending).toBeUndefined();
  });
  it("balanced returns risk cards; accepting them reseals without new model calls", async () => {
    const townRaw = "Hi Raj, I work nights at Mercy General Hospital near the old mill. Thanks, Maya Chen";
    const p = new MockPhoneEngine((id, prompt) => (id === "attack.v1" ? guesses([["location", "near the old mill", "medium"]]) : id === "gen.v1" ? JSON.stringify({ rewrite: prompt.includes("Phrase to rewrite: Mercy General Hospital") ? "a large hospital" : "in the area" }) : detectAnswer));
    const pl = pipe(p);
    const r = await pl.run(townRaw);
    expect(r.risks.length).toBe(1);
    expect(r.requiresReview).toBe(true);
    const calls = p.calls.length;
    const accepted = pl.reseal(r, new Map(), r.risks);
    expect(accepted.draft.text).toContain("at a large hospital in the area.");
    expect(pendingRisks(accepted)).toEqual([]);
    expect(p.calls.length).toBe(calls);
  });
  it("vault reveal via override, secrets force review", async () => {
    const pl = pipe(phone());
    const r = await pl.run("Ask Raj about it.");
    const rajId = r.merge.entities.sorted().find((e) => e.vaultEntryId === "v-raj")!.id;
    expect(pl.reseal(r, new Map([[rajId, { action: { kind: "keep" }, revealThisTime: true }]])).draft.text).toBe("Ask Raj about it.");
    const s = await pipe(MockPhoneEngine.answering('{"items":[]}'), "open").run("Your verification code is 482913.");
    expect(s.draft.text).toBe("Your verification code is [[SECRET_1]].");
    expect(s.reasons).toContainEqual({ kind: "secretsFound" });
  });
});

describe("routing, answers and receipts", () => {
  const me = makeEntity({ id: "PERSON_ME", category: "person", canonical: "Maya Chen", surfaceForms: new Set(["Maya"]), sources: new Set(["vault"]), confidence: "high" });
  const sealedMsg = (text = "Hi [[PERSON_1]], the heater is still broken. — [[PERSON_ME]]"): SealedText => {
    const legend = [{ placeholder: "PERSON_ME", description: "the user" }, { placeholder: "PERSON_1", description: "the user's landlord" }].filter((l) => text.includes(`[[${l.placeholder}]]`));
    return new EgressGate(patterns, []).seal({ text, legend, replacements: [], entities: new EntityMap([raj, me]), secretWarnings: [], revealedVaultIds: new Set(), keptValues: new Set() });
  };
  const restore = { entities: new EntityMap([raj, me]), userFirstName: "Maya" };
  const run = async (gen: AsyncGenerator<AnswerEvent>): Promise<{ events: AnswerEvent[]; outcome: AnswerOutcome }> => {
    const events: AnswerEvent[] = [];
    for await (const e of gen) events.push(e);
    const f = events.find((e) => e.kind === "finished");
    if (f?.kind !== "finished") throw new Error("no outcome");
    return { events, outcome: f.outcome };
  };

  it("route table", () => {
    const s = sealedMsg();
    for (const [t, r] of [[{ kind: "summary" }, "phoneFirst"], [{ kind: "help" }, "cloudFirst"], [{ kind: "reply", tone: "firm" }, "cloudFirst"], [{ kind: "explain" }, "phoneFirst"]] as const) {
      expect(routeOf(t, s, "auto").route).toBe(r);
      expect(routeOf(t, s, "phoneOnly").route).toBe("phoneOnly");
    }
    expect(routeOf({ kind: "summary" }, sealedMsg("x ".repeat(9000)), "auto").route).toBe("cloudOnly");
    expect(taskSpec(prompts, { kind: "reply", tone: "firm but polite" }).instruction).toBe("Draft a reply I can send. Tone: firm but polite. Write it as me. Use placeholders for names.");
  });

  it("deep answer streams, restores and writes a verifiable receipt", async () => {
    const reply = "Here's a reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], please fix the heater this week.\n\nThanks,\n[[PERSON_ME]]";
    const cloud = new MockSealedEngine("cloudFirst", () => reply, "gemini-3.8-flash");
    const ledger = new ReceiptLedger();
    const s = sealedMsg();
    const { events, outcome } = await run(answer({ engines: new MockEngines(undefined, { cloudFirst: cloud }), prompts, ledger, sealed: s, task: { kind: "reply", tone: "firm" }, restore, threadId: "thr_1" }));
    expect(outcome.restored.text).toBe("Here's a reply you can send to Raj Patel:\n\nHi Raj, please fix the heater this week.\n\nThanks,\nMaya");
    expect(cloud.received).toEqual([s]);
    const partials = events.flatMap((e) => (e.kind === "partial" ? [e.text] : []));
    for (let i = 1; i < partials.length; i++) expect(partials[i]!.startsWith(partials[i - 1]!)).toBe(true);
    expect(partials.at(-1)).toBe(outcome.restored.text);
    expect(outcome.receipt?.route).toBe("cloudFirst");
    expect(outcome.receipt?.outboundText).not.toContain("Raj");
    expect(ledger.verify()).toEqual({ valid: true, count: 1 });
  });

  it("an on-device quick answer makes no receipt; an armor block makes a blocked one", async () => {
    const ledger = new ReceiptLedger();
    const quick = new MockSealedEngine("phoneFirst", () => "- [[PERSON_1]] hasn't fixed it.", CHROME_ON_DEVICE_MODEL);
    const { outcome } = await run(answer({ engines: new MockEngines(undefined, { phoneFirst: quick }), prompts, ledger, sealed: sealedMsg(), task: { kind: "summary" }, restore, threadId: "t" }));
    expect(outcome.ranOnDevice && outcome.receipt === null).toBe(true);
    expect(ledger.stats(new Date(0)).onDeviceAnswers).toBe(1);
    const blocked = new MockSealedEngine("cloudFirst", () => { throw new EngineError("armorBlocked"); });
    await expect(run(answer({ engines: new MockEngines(undefined, { cloudFirst: blocked }), prompts, ledger, sealed: sealedMsg(), task: { kind: "help" }, restore, threadId: "t" }))).rejects.toThrow(/armorBlocked/);
    expect(ledger.receipts.map((r) => r.armor)).toEqual(["blocked"]);
  });
});
