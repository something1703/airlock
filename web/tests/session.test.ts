import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app/services";
import { AirlockSession, cleanTitle, titleFrom } from "../src/app/session";

const SAMPLE = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. You can reach me on 312-555-0147. Thanks, Maya Chen";

async function demoSession(): Promise<AirlockSession> {
  const s = new AirlockSession(await createServices("?demo=1"), { dial: "balanced", preference: "best", onboarded: true, backup: true });
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

  it("conversations survive a reload: restored names come back and sealed turns are re-checked by the gate", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "reply", tone: "firm but polite" });
    await s.send();
    const id = s.getState().currentThreadId!;

    const again = new AirlockSession(s.services, { dial: "balanced", preference: "best", onboarded: true, backup: true });
    await again.load();
    const t = again.getState().threads.find((x) => x.id === id)!;
    expect(t.turns).toHaveLength(2);
    const [user, answer] = t.turns;
    expect(user?.kind === "user" && user.sealed !== null && user.display === user.sealed.value).toBe(true);
    expect(answer?.kind === "assistant" && answer.text).toContain("Raj");
    expect(answer?.kind === "assistant" && answer.outcome?.receipt?.id).toBe(s.ledger.receipts.at(-1)!.id);

    await again.startReview("What if Raj ignores me again?", { kind: "help" }, id);
    await again.send();
    expect(again.getState().threads.find((x) => x.id === id)!.turns).toHaveLength(4);
  });

  it("a saved turn that no longer passes the gate is shown but kept out of follow-up history", async () => {
    const s = await demoSession();
    await s.startReview("The heater is broken at Willowbrook Court.", { kind: "help" });
    // Send "Willowbrook" as written, then add it to the Vault: the old sealed turn now contains a Vault name.
    const loc = s.getState().review!.result!.draft.entities.sorted().find((e) => e.canonical.includes("Willowbrook"));
    if (loc) s.toggleEntity(loc.id);
    await s.send();
    await s.saveVault([...s.getState().vault, { id: "w", canonical: "Willowbrook Court", aliases: ["Willowbrook"], category: "location", isUser: false }]);
    const again = new AirlockSession(s.services, { dial: "balanced", preference: "best", onboarded: true, backup: true });
    await again.load();
    const user = again.getState().threads[0]!.turns[0]!;
    expect(user.kind === "user" && user.sealed).toBeNull();
    expect(user.kind === "user" && user.display).toContain("Willowbrook");
  });

  it("deleting a conversation removes it from storage but keeps the receipt chain", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    await s.send();
    const id = s.getState().currentThreadId!;
    const receipts = s.ledger.receipts.length;
    await s.deleteThread(id);
    expect(s.getState().threads).toHaveLength(0);
    expect(s.getState().screen).toBe("ask");
    const again = new AirlockSession(s.services);
    await again.load();
    expect(again.getState().threads).toHaveLength(0);
    expect(again.ledger.receipts).toHaveLength(receipts);
    expect(again.verifyChain().valid).toBe(true);
  });

  it("sending is impossible while the red-team check is still pending", async () => {
    const s = await demoSession();
    await s.startReview(SAMPLE, { kind: "help" });
    const r = s.getState().review!;
    // Simulate the staged state the UI sees before the check completes.
    (s as unknown as { state: { review: typeof r } }).state.review = { ...r, result: { ...r.result!, redTeamPending: true } };
    await s.send();
    expect(s.getState().screen).toBe("review");
    expect(s.ledger.receipts).toHaveLength(0);
  });

  it("model titles are accepted only when short, plain and placeholder-free", () => {
    expect(cleanTitle('"Broken heater, landlord unresponsive."\n')).toBe("Broken heater, landlord unresponsive");
    expect(cleanTitle("Title: rent increase question")).toBe("Rent increase question");
    for (const bad of ["", "{}", "Heater for [[PERSON_1]]", "Heater for PERSON_1", "a ".repeat(40), "one two three four five six seven eight"]) expect(cleanTitle(bad)).toBeNull();
  });

  it("Protect this: a missed phrase is sealed everywhere, survives later toggles, and never reaches the outbound text", async () => {
    const s = await demoSession();
    await s.startReview("The leak at Willowbrook Court got worse. Willowbrook Court management won't answer, Raj.", { kind: "help" });
    expect(s.getState().review!.result!.draft.text).toContain("Willowbrook");
    expect(s.protect("willowbrook court", "location")).toBe(true);
    expect(s.getState().review!.result!.draft.text).not.toContain("Willowbrook");
    const raj = s.getState().review!.result!.draft.entities.sorted().find((e) => e.canonical === "Raj Patel")!;
    s.toggleEntity(raj.id); // a later toggle must not undo the user's mark
    expect(s.getState().review!.result!.draft.text).not.toContain("Willowbrook");
    expect(s.protect("Nowhere Clinic", "org")).toBe(false);
    await s.send();
    expect(s.ledger.receipts.at(-1)!.outboundText).not.toContain("Willowbrook");
    expect(s.getState().threads[0]!.turns.at(-1)!.kind === "assistant").toBe(true);
  });

  it("titles never contain placeholder tokens", () => {
    expect(titleFrom("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken")).toBe("Hi someone the heater at a place");
    expect(titleFrom("[[PERSON_ME]]")).toBe("Me");
    expect(titleFrom("[[SECRET_1]] !!")).toBe("A code");
  });
});
