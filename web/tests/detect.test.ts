import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PACKS, PatternDetector } from "../src/engine/patterns";
import { isNormalised, normalise, toOriginal } from "../src/engine/normaliser";
import * as FoldedSearch from "../src/engine/foldedSearch";
import { named } from "../src/engine/validators";
import { VaultMatcher, type VaultEntry } from "../src/engine/vault";
import type { PrivacyCategory } from "../src/engine/types";
import { fixture, int, pick, repoRoot, rng } from "./support";

describe("shared pattern packs", () => {
  it("web copies are byte-identical to the Swift package resources", () => {
    for (const f of ["core.json", "national.json"]) {
      const swift = readFileSync(join(repoRoot, "Packages/AirlockKit/Sources/AirlockDetect/PatternPacks", f), "utf8");
      const web = readFileSync(join(repoRoot, "web/src/engine/packs", f), "utf8");
      expect(web, `${f} drifted — run npm run sync-packs`).toBe(swift);
    }
    expect(BUNDLED_PACKS.map((p) => p.id)).toEqual(["core", "national"]);
  });
});

describe("validators (spec/fixtures/validators.json)", () => {
  const fx = fixture<Record<string, unknown>>("validators.json");
  it("matches every case", () => {
    let checked = 0;
    for (const [name, cases] of Object.entries(fx)) {
      if (!Array.isArray(cases)) continue;
      const v = named(name);
      expect(v, `no validator ${name}`).toBeDefined();
      for (const c of cases as { input: string; valid: boolean }[]) {
        expect(v!(c.input), `${name}(${c.input})`).toBe(c.valid);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe("normaliser (spec/fixtures/normalise.json)", () => {
  it("matches every case", () => {
    for (const c of fixture<{ cases: { name: string; input: string; expected: string }[] }>("normalise.json").cases) {
      expect(normalise(c.input).text, c.name).toBe(c.expected);
    }
  });

  it("is idempotent and keeps a monotonic offset map (random inputs)", () => {
    const r = rng(7);
    const pieces = ["Raj", " ", "  ", "​", "“", "”", "Ｒ", "ﬁ", "\r\n", "é", "é", "👩‍👩‍👧", "\t", "14 Elm St", "‮", "@", "x"];
    for (let i = 0; i < 500; i++) {
      const input = Array.from({ length: int(r, 1, 30) }, () => pick(r, pieces)).join("");
      const n = normalise(input);
      expect(n.originalOffsets.length).toBe(n.text.length + 1);
      expect(n.originalOffsets.at(-1)).toBe(input.length);
      for (let k = 1; k < n.originalOffsets.length; k++) expect(n.originalOffsets[k]!).toBeGreaterThanOrEqual(n.originalOffsets[k - 1]!);
      expect(normalise(n.text).text).toBe(n.text);
      expect(isNormalised(n.text)).toBe(true);
    }
  });

  it("maps a span back to the original text", () => {
    const original = "Hi​  “Raj Patel”";
    const n = normalise(original);
    const span = FoldedSearch.ranges("Raj Patel", n.text)[0]!;
    const back = toOriginal(n, span);
    expect(original.slice(back.start, back.end)).toBe("Raj Patel");
  });
});

describe("folded search", () => {
  it("word boundaries and folding", () => {
    expect(FoldedSearch.ranges("Raj", "Raj's car, not Rajesh").map((s) => s.start)).toEqual([0]);
    expect(FoldedSearch.contains("José", "jose said")).toBe(true);
    expect(FoldedSearch.contains("Raj Patel", "RAJ\n  PATEL")).toBe(true);
    expect(FoldedSearch.contains("Raj Patel", "Raj Patelson")).toBe(false);
    expect(FoldedSearch.ranges("  ", "a  b")).toEqual([]);
  });
  it("case-sensitive mode keeps diacritic folding but not case", () => {
    expect(FoldedSearch.contains("Will", "I will call", true)).toBe(false);
    expect(FoldedSearch.contains("Will", "Will called", true)).toBe(true);
    expect(FoldedSearch.contains("José", "Jose called", true)).toBe(true);
  });
  it("returns spans in original coordinates even when folding changes length", () => {
    const text = "the ﬁle of Raj";
    const [span] = FoldedSearch.ranges("Raj", text);
    expect(text.slice(span!.start, span!.end)).toBe("Raj");
  });
});

describe("pattern detector (spec/fixtures/patterns.json)", () => {
  const detector = new PatternDetector();
  type Case = { name: string; text: string; expect: { text: string; category: string; subtype: string }[]; absent: { text: string; subtype: string | null }[] };
  type Fx = { templates: Record<string, string[]>; cases: Case[] };
  it("matches every case", () => {
    const fx = fixture<Fx>("patterns.json");
    // Fake secrets are stored in parts so no key-shaped string exists in the repo; join them here.
    const expand = (s: string): string => Object.entries(fx.templates).reduce((acc, [k, parts]) => acc.replaceAll(`{{${k}}}`, parts.join("")), s);
    for (const raw of fx.cases) {
      const c: Case = { ...raw, text: expand(raw.text), expect: raw.expect.map((e) => ({ ...e, text: expand(e.text) })), absent: raw.absent.map((a) => ({ ...a, text: expand(a.text) })) };
      const found = detector.detect(c.text);
      for (const e of c.expect) {
        expect(found.some((f) => f.text === e.text && f.category === e.category && f.subtype === e.subtype), `[${c.name}] expected ${e.text}; got ${found.map((f) => `${f.text}=${f.category}/${f.subtype}`)}`).toBe(true);
      }
      for (const a of c.absent) {
        expect(found.some((f) => f.text === a.text && (a.subtype === null || f.subtype === a.subtype)), `[${c.name}] ${a.text} must not be detected`).toBe(false);
      }
      for (const f of found) expect(c.text.slice(f.span.start, f.span.end)).toBe(f.text);
    }
  });

  it("never returns overlapping candidates", () => {
    const found = detector.detect("Card 4111 1111 1111 1111, SSN 123-45-6789, call 312-555-0147, mail a@b.co, code 4821, Order #ZX81234.");
    for (let i = 0; i < found.length; i++) for (let j = i + 1; j < found.length; j++) {
      expect(found[i]!.span.end <= found[j]!.span.start || found[j]!.span.end <= found[i]!.span.start).toBe(true);
    }
  });

  it("finds valid IDs inserted anywhere in filler text (1,000 random cases)", () => {
    const r = rng(42);
    const filler = "the heater has been broken for three weeks and nobody has called back about the repair yet".split(" ");
    const secrets: [string, PrivacyCategory, string][] = [
      ["4111 1111 1111 1111", "id", "card"], ["5555555555554444", "id", "card"], ["GB82WEST12345698765432", "id", "iban"],
      ["maya.chen@example.com", "contact", "email"], ["r.patel+rent@mail.example.org", "contact", "email"], ["123-45-6789", "id", "ssn"],
      ["+44 20 7946 0958", "contact", "phone"], ["312-555-0147", "contact", "phone"], ["sk-" + "abcdefghijklmnopqrstuv12", "secret", "api_key"],
    ];
    for (let i = 0; i < 1000; i++) {
      const words = Array.from({ length: int(r, 3, 25) }, () => pick(r, filler));
      const [value, category, subtype] = pick(r, secrets);
      words.splice(int(r, 0, words.length), 0, value);
      const text = words.join(" ") + pick(r, [".", ",", "", "!", ";"]);
      const found = new PatternDetector().detect(text);
      expect(found.some((f) => f.text === value && f.category === category && f.subtype === subtype), `${value} not found in: ${text}`).toBe(true);
    }
  });

  it("disabling a pack skips its rules", () => {
    expect(new PatternDetector(BUNDLED_PACKS, new Set(["national"])).detect("PAN ABCPE1234F").some((f) => f.subtype === "national_id")).toBe(false);
  });
  it("reports bad regexes and unknown validators", () => {
    expect(() => new PatternDetector([{ id: "x", description: "", rules: [{ id: "bad", category: "id", subtype: "x", confidence: "low", regex: "(" }] }])).toThrow(/bad/);
    expect(() => new PatternDetector([{ id: "x", description: "", rules: [{ id: "r", category: "id", subtype: "x", confidence: "low", regex: "a", validator: "nope" }] }])).toThrow(/unknown validator/);
  });
});

describe("vault matcher (spec/fixtures/vault.json)", () => {
  type Fx = { entries: (Omit<VaultEntry, "category"> & { category: string })[]; cases: { name: string; text: string; expect: { text: string; entryId: string }[]; absent: string[] }[] };
  const fx = fixture<Fx>("vault.json");
  const matcher = new VaultMatcher(fx.entries.map((e) => ({ ...e, category: e.category as PrivacyCategory })));
  it("matches every case", () => {
    for (const c of fx.cases) {
      const found = matcher.detect(c.text);
      for (const e of c.expect) expect(found.some((f) => f.text === e.text && f.vaultEntryId === e.entryId), `[${c.name}] expected ${e.text}; got ${found.map((f) => f.text)}`).toBe(true);
      for (const a of c.absent) expect(found.some((f) => f.text === a), `[${c.name}] ${a} must not match`).toBe(false);
      expect(found.every((f) => f.detector === "vault" && f.confidence === "high")).toBe(true);
    }
  });
  it("user entry gets the self role", () => {
    const m = new VaultMatcher([{ id: "me", canonical: "Maya Chen", aliases: [], category: "person", roleHint: "me", isUser: true }]);
    const hit = m.detect("Sincerely, Maya Chen")[0];
    expect(hit?.roleHint).toBe("the user");
    expect(hit?.subtype).toBe("self");
  });
});
