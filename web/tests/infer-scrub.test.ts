import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app/services";
import { AirlockSession } from "../src/app/session";
import { inferTask, parseInferences } from "../src/engine/infer";
import { PromptLibrary } from "../src/engine";

const SAMPLE = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. Call 312-555-0147. Thanks, Maya Chen";

async function demoSession(): Promise<AirlockSession> {
  const s = new AirlockSession(await createServices("?demo=1"), { dial: "balanced", preference: "best", onboarded: true, backup: false });
  await s.load();
  await s.deleteEverything();
  s.setPrefs({ onboarded: true, preference: "best", backup: false });
  await s.saveVault([
    { id: "me", canonical: "Maya Chen", aliases: ["Maya"], category: "person", roleHint: "me", isUser: true },
    { id: "raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false },
  ]);
  return s;
}

describe("F-25 infer.v1 parsing", () => {
  it("uses the versioned prompt's instruction without the quoted-message block", () => {
    const t = inferTask(new PromptLibrary());
    expect(t.id).toBe("infer.v1");
    expect(t.instruction).toMatch(/^Without guessing any real names/);
    expect(t.instruction).not.toContain("<<<");
    expect(t.instruction).toContain('"inferences"');
  });
  it("is lenient about wrappers, strict about shape, sorted by confidence", () => {
    const r = parseInferences('Sure!\n```json\n{"inferences":[{"attribute":"age","value":"30s","confidence":"low"},{"attribute":"job","value":"nurse","confidence":"HIGH","evidence":"night shifts"},{"value":"no attribute"},{"attribute":"who","value":"[[PERSON_1]]","confidence":"high"}]}\n```');
    expect(r.unreadable).toBe(false);
    expect(r.inferences.map((i) => [i.attribute, i.confidence])).toEqual([["job", "high"], ["age", "low"]]);
    expect(parseInferences("I can't help with that").unreadable).toBe(true);
    expect(parseInferences('{"inferences":"nope"}').unreadable).toBe(true);
  });
});

describe("F-25 What could Gemini still guess (session)", () => {
  it("re-sends exactly the sealed text that already left, writes a receipt, never raw text", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    await s.send();
    const id = s.getState().currentThreadId!;
    const first = s.ledger.receipts.at(-1)!;
    const r = await s.inferGuesses(id);
    expect(r.inferences.length).toBeGreaterThan(0);
    expect(r.inferences[0]!.confidence).toBe("high");
    const second = s.ledger.receipts.at(-1)!;
    expect(second.seq).toBe(first.seq + 1);
    expect(second.outboundSha256).toBe(first.outboundSha256); // identical outbound text: nothing new left
    expect(second.route).toBe("cloudOnly");
    for (const raw of ["Raj", "Maya", "Elm", "312-555", "Mercy"]) expect(second.outboundText).not.toContain(raw);
    expect(s.verifyChain().valid).toBe(true);
  });
});

describe("F-27 Scrub & copy", () => {
  it("copies only gate-sealed text, sends nothing, and restores a pasted answer locally (and after reload)", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "reply", tone: "firm" });
    const copied = await s.scrubAndCopy();
    expect(copied).not.toBeNull();
    for (const raw of ["Raj", "Maya", "Elm", "312-555", "Mercy"]) expect(copied!).not.toContain(raw);
    expect(copied!).toContain("[[PERSON_1]]");
    expect(s.ledger.receipts).toHaveLength(0);
    const t = s.getState().threads[0]!;
    expect(t.mode).toBe("scrub");
    expect(s.getState().screen).toBe("thread");

    await s.restorePasted(t.id, "Dear [[PERSON_1]], please fix the heater at [[LOC_1]]. Regards, [[PERSON_ME]]");
    const answer = s.getState().threads[0]!.turns.at(-1)!;
    expect(answer.kind === "assistant" && answer.text).toContain("14 Elm St");
    expect(answer.kind === "assistant" && answer.text).toContain("Raj");

    const again = new AirlockSession(s.services, { dial: "balanced", preference: "best", onboarded: true, backup: false });
    await again.load();
    const t2 = again.getState().threads.find((x) => x.id === t.id)!;
    expect(t2.mode).toBe("scrub");
    const a2 = t2.turns.at(-1)!;
    expect(a2.kind === "assistant" && a2.pasted).toContain("[[LOC_1]]");
    expect(a2.kind === "assistant" && a2.text).toContain("14 Elm St");
  });

  it("respects an explicit reveal exactly like sending (gate rules are shared)", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    const raj = s.getState().review!.result!.draft.entities.sorted().find((e) => e.canonical === "Raj Patel")!;
    s.toggleEntity(raj.id); // reveal a Vault name this time → allowed by the user's explicit choice
    expect(await s.scrubAndCopy()).toContain("Raj");
  });
});
