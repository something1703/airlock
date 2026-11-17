import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app/services";
import { AirlockSession, titleFrom } from "../src/app/session";

const SAMPLE = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. You can reach me on 312-555-0147. Thanks, Maya Chen";

async function demoSession(): Promise<AirlockSession> {
  const s = new AirlockSession(await createServices("?demo=1"), { dial: "balanced", preference: "best", onboarded: true });
  await s.load();
  await s.deleteEverything();
  s.setPrefs({ onboarded: true, preference: "best" });
  await s.saveVault([
    { id: "me", canonical: "Maya Chen", aliases: ["Maya"], category: "person", roleHint: "me", isUser: true },
    { id: "raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false },
  ]);
  return s;
}

describe("AirlockSession (demo engines, end to end)", () => {
  it("Ask → Review → Seal & send → restored answer + receipt; nothing raw leaves", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    const review = s.getState().review!;
    expect(review.result).not.toBeNull();
    const draft = review.result!.draft.text;
    for (const raw of ["Raj", "Maya", "Elm", "312-555", "Mercy"]) expect(draft).not.toContain(raw);

    await s.send();
    const st = s.getState();
    expect(st.screen).toBe("thread");
    const thread = st.threads[0]!;
    const answer = thread.turns.at(-1)!;
    expect(answer.kind === "assistant" && answer.status).toBe("done");
    if (answer.kind !== "assistant") throw new Error("expected answer");
    expect(answer.text).toContain("Raj");
    expect(answer.text).toContain("14 Elm St");
    expect(answer.outcome?.receipt).not.toBeNull();

    const outbound = s.ledger.receipts.map((r) => r.outboundText ?? "").join("\n");
    expect(outbound.length).toBeGreaterThan(0);
    for (const raw of ["Raj", "Maya", "Elm", "312-555", "Mercy"]) expect(outbound).not.toContain(raw);
    expect(s.verifyChain().valid).toBe(true);
  });

  it("toggling a chip sends that detail as written, and toggling back protects it again", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    const loc = s.getState().review!.result!.draft.entities.sorted().find((e) => e.category === "location")!;
    s.toggleEntity(loc.id);
    expect(s.getState().review!.result!.draft.text).toContain("14 Elm St");
    s.toggleEntity(loc.id);
    expect(s.getState().review!.result!.draft.text).not.toContain("14 Elm St");
  });

  it("a follow-up reuses the thread's placeholders", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    await s.send();
    const id = s.getState().currentThreadId!;
    await s.startReview("What if Raj ignores me again?", { kind: "help" }, id);
    expect(s.getState().review!.result!.draft.text).toContain("[[PERSON_1]]");
    await s.send();
    expect(s.getState().threads).toHaveLength(1);
    expect(s.getState().threads[0]!.turns).toHaveLength(4);
  });

  it("delete everything clears state and returns to onboarding", async () => {
    const s = await demoSession();
    await s.deleteEverything();
    expect(s.getState().screen).toBe("onboarding");
    expect(s.getState().vault).toEqual([]);
  });

  it("titles never contain placeholder tokens", () => {
    expect(titleFrom("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken")).toBe("Hi someone the heater at a place");
    expect(titleFrom("[[PERSON_ME]]")).toBe("Me");
    expect(titleFrom("[[SECRET_1]] !!")).toBe("A code");
  });
});
