import { describe, expect, it } from "vitest";
import { MockPhoneEngine, PromptLibrary } from "../src/engine";
import { LLMDetector } from "../src/engine/llmDetector";
import { plausibleGeneral } from "../src/engine/generaliser";
import type { Candidate } from "../src/engine/types";
import { fixture } from "./support";

interface Case {
  name: string;
  promptId: string;
  text: string;
  masks: { start: number; end: number; text: string; category: Candidate["category"]; subtype?: string; detector: Candidate["detector"] }[];
  modelOutput: string;
  expect: [string, string, string, string | null][];
  generals: Record<string, string>;
  promptIncludes: string[];
  promptExcludes: string[];
  hallucinated: number;
}

const prompts = new PromptLibrary();

describe("LLM detector conformance (spec/fixtures/detect.json)", () => {
  const { cases } = fixture<{ cases: Case[] }>("detect.json");
  for (const c of cases) {
    it(c.name, async () => {
      const masks: Candidate[] = c.masks.map((m) => ({ span: { start: m.start, end: m.end }, text: m.text, category: m.category, subtype: m.subtype ?? null, detector: m.detector, confidence: "high" }));
      const phone = new MockPhoneEngine(() => c.modelOutput);
      const r = await new LLMDetector(phone, prompts, 3000, { promptId: c.promptId, masks }).detect(c.text);
      expect(phone.calls[0]!.promptId).toBe(c.promptId);
      expect(r.candidates.map((x) => [x.text, x.category, x.confidence, x.roleHint ?? null])).toEqual(c.expect);
      expect(Object.fromEntries(r.generals)).toEqual(c.generals);
      expect(r.hallucinatedDropped).toBe(c.hallucinated);
      expect(r.failedChunks).toEqual([]);
      const sent = phone.calls[0]!.text;
      for (const s of c.promptIncludes) expect(sent, `prompt should include ${s}`).toContain(s);
      for (const s of c.promptExcludes) expect(sent, `prompt should not include ${s}`).not.toContain(s);
    });
  }
});

describe("detect.v2 robustness", () => {
  it("a reply that is neither lines nor JSON is repaired once, then reported as failed", async () => {
    const phone = new MockPhoneEngine(() => "I cannot do that");
    const r = await new LLMDetector(phone, prompts, 3000, { promptId: "detect.v2" }).detect("Hi Raj.");
    expect(phone.calledPromptIds).toEqual(["detect.v2", "detect-repair.v1"]);
    expect(r.failedChunks).toEqual([0]);
  });
  it("a repaired reply (v1 JSON) is accepted", async () => {
    const phone = new MockPhoneEngine((id) => (id === "detect.v2" ? "nonsense" : '{"items":[{"text":"Raj","type":"PERSON","confidence":"high"}]}'));
    const r = await new LLMDetector(phone, prompts, 3000, { promptId: "detect.v2" }).detect("Hi Raj.");
    expect(r.candidates.map((x) => x.text)).toEqual(["Raj"]);
    expect(r.repairsUsed).toBe(1);
  });
  it("masks only reach the prompt inside their own chunk and never change located spans", async () => {
    const text = "Mail maya@example.com. Hi Raj.";
    const phone = new MockPhoneEngine(() => "PERSON | Raj | friend | -\nEND");
    const mask: Candidate = { span: { start: 5, end: 21 }, text: "maya@example.com", category: "contact", subtype: "email", detector: "pattern", confidence: "high" };
    const r = await new LLMDetector(phone, prompts, 3000, { promptId: "detect.v2", masks: [mask] }).detect(text);
    expect(phone.calls[0]!.text).toContain("Mail [email]. Hi Raj.");
    expect(r.candidates[0]!.span).toEqual({ start: text.indexOf("Raj"), end: text.indexOf("Raj") + 3 });
  });
});

describe("plausibleGeneral (shape check for a model-written replacement)", () => {
  it("accepts short noun phrases", () => {
    for (const g of ["a large hospital", "a nearby street", "a chronic condition"]) expect(plausibleGeneral(g, "Mercy General Hospital"), g).toBe(true);
  });
  it("rejects sentences, long phrases, brackets and a capital the span didn't have", () => {
    expect(plausibleGeneral("Two-week turnaround required for repairs.", "14 days")).toBe(false);
    expect(plausibleGeneral("a very large and busy teaching hospital in town", "Mercy General")).toBe(false);
    expect(plausibleGeneral("a [[ORG_1]] clinic", "Mercy")).toBe(false);
    expect(plausibleGeneral("The hospital", "mercy")).toBe(false);
    expect(plausibleGeneral("The hospital", "Mercy")).toBe(true);
    expect(plausibleGeneral("", "Mercy")).toBe(false);
  });
});
