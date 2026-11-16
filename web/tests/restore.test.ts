import { describe, expect, it } from "vitest";
import { EntityMap, PlaceholderParser, StreamingRestorer, fidelityCheck, makeEntity, parseAction, restore, type PrivacyCategory, type RestoreContext } from "../src/engine";
import { fixture, int, pick, rng } from "./support";

describe("placeholder parser (spec/fixtures/placeholders.json)", () => {
  type Fx = { known: string[]; cases: { text: string; expect: { original: string; id: string; canonical: boolean }[] }[] };
  it("matches every case", () => {
    const f = fixture<Fx>("placeholders.json");
    const parser = new PlaceholderParser(new Set(f.known));
    for (const c of f.cases) {
      const got = parser.tokens(c.text);
      expect(got.map((t) => t.original), c.text).toEqual(c.expect.map((e) => e.original));
      expect(got.map((t) => t.id), c.text).toEqual(c.expect.map((e) => e.id));
      expect(got.map((t) => t.isCanonical), c.text).toEqual(c.expect.map((e) => e.canonical));
      for (const t of got) {
        expect(t.original.length).toBeLessThanOrEqual(24);
        expect(c.text.slice(t.span.start, t.span.end)).toBe(t.original);
      }
    }
  });
});

type FxR = { secretDisplay: string; groups: { entities: { id: string; category: string; canonical: string; surfaceForms: string[]; action: string }[]; cases: { name: string; output: string; expected: string; writingAsUser?: boolean; userFirstName?: string; unknown?: string[] }[] }[] };
const fx = fixture<FxR>("restore.json");
const mapOf = (g: FxR["groups"][number]): EntityMap =>
  new EntityMap(g.entities.map((e) => makeEntity({ id: e.id, category: e.category as PrivacyCategory, canonical: e.canonical, surfaceForms: new Set(e.surfaceForms), action: parseAction(e.action), sources: new Set(["llm"]), confidence: "high" })));
const ctxOf = (g: FxR["groups"][number], c: FxR["groups"][number]["cases"][number]): RestoreContext => ({ entities: mapOf(g), userFirstName: c.userFirstName ?? null, writingAsUser: c.writingAsUser ?? false, secretDisplay: fx.secretDisplay });

describe("restorer (spec/fixtures/restore.json)", () => {
  it("matches every case", () => {
    for (const g of fx.groups) for (const c of g.cases) {
      const r = restore(c.output, ctxOf(g, c));
      expect(r.text, `[${c.name}]`).toBe(c.expected);
      expect(r.unknownIds, `[${c.name}] unknown`).toEqual(c.unknown ?? []);
    }
  });

  it("streaming equals unary at every split point (delta and cumulative)", () => {
    for (const g of fx.groups) for (const c of g.cases) {
      const ctx = ctxOf(g, c);
      const unary = restore(c.output, ctx);
      for (let split = 0; split <= c.output.length; split++) {
        const head = c.output.slice(0, split);
        const tail = c.output.slice(split);
        // Real SDK chunks are valid strings: skip splits inside a surrogate pair.
        if (split > 0 && split < c.output.length && c.output.charCodeAt(split - 1) >= 0xd800 && c.output.charCodeAt(split - 1) <= 0xdbff) continue;
        const d = new StreamingRestorer(ctx);
        d.append(head); d.append(tail); d.finish();
        expect(d.segments, `[${c.name}] delta split ${split}`).toEqual(unary.segments);
        const cu = new StreamingRestorer(ctx);
        cu.update(head); cu.update(head + tail); cu.finish();
        expect(cu.segments, `[${c.name}] cumulative split ${split}`).toEqual(unary.segments);
      }
    }
  });

  it("random multi-chunk streaming of placeholder-dense answers (500)", () => {
    const g = fx.groups[0]!;
    const ctx: RestoreContext = { entities: mapOf(g), secretDisplay: fx.secretDisplay };
    const r = rng(2026);
    const parts = ["[[PERSON_1]]", "[[ORG_1]]", "[[LOC_1]]", "[[SECRET_1]]", "[[PERSON_ME]]", "[[PERSON_9]]", "PERSON_1", "[Person_1]", "【PERSON_1】", "[[", "]]", "[", "PERSON", "_", "1", "'s ", " the ", "heater ", "\n", "é", "👩‍👧", "[[PERSON_1"];
    for (let i = 0; i < 500; i++) {
      const answer = Array.from({ length: int(r, 1, 40) }, () => pick(r, parts)).join("");
      const unary = restore(answer, ctx);
      const s = new StreamingRestorer(ctx);
      let k = 0;
      while (k < answer.length) {
        let end = Math.min(answer.length, k + int(r, 1, 12));
        if (end < answer.length && answer.charCodeAt(end) >= 0xdc00 && answer.charCodeAt(end) <= 0xdfff) end += 1;
        s.append(answer.slice(k, end));
        k = end;
      }
      s.finish();
      expect(s.segments, `answer: ${answer}`).toEqual(unary.segments);
    }
  });

  it("never restores a secret, in any variant", () => {
    const ctx: RestoreContext = { entities: mapOf(fx.groups[0]!) };
    for (const v of ["[[SECRET_1]]", "[SECRET_1]", "SECRET_1", "[[ SECRET_1 ]]", "【SECRET_1】", "[[Secret_1]]"]) {
      const r = restore(`code: ${v}`, ctx);
      expect(r.text).not.toContain("482913");
      expect(r.secretsHidden).toBe(1);
    }
  });

  it("restored ranges point at the values; hold-back is bounded", () => {
    const r = restore("Hi [[PERSON_1]], see [[ORG_1]].", { entities: mapOf(fx.groups[0]!) });
    expect(r.restoredRanges.map((x) => r.text.slice(x.span.start, x.span.end))).toEqual(["Raj Patel", "Mercy General Hospital"]);
    const s = new StreamingRestorer({ entities: new EntityMap() });
    const emitted = s.append("word ".repeat(20)).map((x) => (x.kind === "text" ? x.text : "")).join("");
    expect(emitted.length).toBe(100 - StreamingRestorer.HOLD_BACK);
  });

  it("flags a model that guessed a real name", () => {
    const ctx: RestoreContext = { entities: new EntityMap([makeEntity({ id: "PERSON_1", category: "person", canonical: "Raj Patel", surfaceForms: new Set(["Raj"]), sources: new Set(["vault"]), confidence: "high" })]) };
    expect(fidelityCheck("Tell [[PERSON_1]] politely.", ctx).isClean).toBe(true);
    expect(fidelityCheck("Tell Raj politely.", ctx).guessedEntities).toEqual(["PERSON_1"]);
    expect(fidelityCheck("Ask [[ORG_4]].", ctx).unknownIds).toEqual(["ORG_4"]);
  });
});
