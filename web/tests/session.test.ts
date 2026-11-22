import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app/services";
import { AirlockSession, cleanTitle, titleFrom } from "../src/app/session";
import { PROOF_SAMPLES } from "../src/app/proofSamples";

describe("Proof mode (demo engines, end to end)", () => {
  it("scam sample → 'Likely a scam' with sources and receipts; only sealed claims left; nothing stored", async () => {
    const s = await demoSession();
    const sample = PROOF_SAMPLES[0]!;
    const stages: string[] = [];
    const unsub = s.subscribe(() => { const st = s.getState().proof?.stage; if (st && stages.at(-1) !== st) stages.push(st); });
    s.openProof(sample.message);
    expect(s.getState().screen).toBe("proof");
    await new Promise((r) => setTimeout(r, 0));
    while (s.getState().proof?.stage !== "done") await new Promise((r) => setTimeout(r, 50));
    unsub();
    expect(stages).toEqual(["scanning", "sealing", "checking", "done"]);
    const r = s.getState().proof!.result!;
    expect(r.mode).toBe("checked");
    expect(r.verdict).toBe("likelyScam");
    expect(r.flags.map((f) => f.tactic)).toEqual(expect.arrayContaining(["credential_request", "urgency", "fear", "secrecy"]));
    const checked = r.claims.filter((c) => c.status === "checked");
    expect(checked).toHaveLength(2);
    for (const c of checked) if (c.status === "checked") expect(c.finding.sources.length).toBe(2);
    const outbound = s.ledger.receipts.map((x) => x.outboundText ?? "").join("\n");
    expect(s.ledger.receipts).toHaveLength(2);
    for (const raw of ["Lakeview", "740", "6-digit", sample.message]) expect(outbound).not.toContain(raw);
    expect(await s.services.stores.captures()).toHaveLength(0);
    expect(s.proofShareText()).toMatch(/^Heads up: I got a message that looks like a scam\./);
    s.resetProof();
    expect(s.getState().proof).toBeNull();
  });

  it("legitimate sample → 'Looks legitimate' and no share warning", async () => {
    const s = await demoSession();
    await s.startProof(PROOF_SAMPLES[2]!.message);
    expect(s.getState().proof!.result!.verdict).toBe("looksLegit");
    expect(s.proofShareText()).toBeNull();
  });

  it("offline → tactics-only card, nothing sent", async () => {
    const services = await createServices("?demo=1");
    const s = new AirlockSession({ ...services, online: () => false }, { dial: "balanced", preference: "auto", onboarded: true, backup: false });
    await s.load();
    const before = s.ledger.receipts.length;
    await s.startProof(PROOF_SAMPLES[0]!.message);
    const r = s.getState().proof!.result!;
    expect(r.mode).toBe("offline");
    expect(r.flags.length).toBeGreaterThanOrEqual(3);
    expect(s.ledger.receipts.length).toBe(before);
  });
});

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

  describe("private tools: Propose a meeting time", () => {
    const MEET = "Hi Raj, can we meet next week about the heater at 14 Elm St? Thanks, Maya Chen";

    /** Sends, answering every consent card with `decide` as soon as it appears. */
    async function sendAnswering(s: AirlockSession, decide: "allow" | "deny"): Promise<string[]> {
      const seen: string[] = [];
      const off = s.subscribe(() => {
        for (const c of s.getState().consents) {
          if (seen.includes(c.title)) continue;
          seen.push(c.title);
          queueMicrotask(() => s.answerConsent(c.id, decide));
        }
      });
      await s.send();
      off();
      return seen;
    }

    it("with an imported calendar: consent cards for date + free time, a draft with two real free slots, nothing private shared", async () => {
      const s = await demoSession();
      expect(await s.useSampleCalendar()).toBe(true);
      expect(s.getState().calendar).toMatchObject({ sample: true });
      await s.startReview(MEET, { kind: "meeting" });
      const cards = await sendAnswering(s, "allow");
      expect(cards).toEqual(["Gemini wants to know today’s date", "Gemini wants to check your free time next week"]);
      const answer = s.getState().threads[0]!.turns.at(-1)!;
      if (answer.kind !== "assistant") throw new Error("expected answer");
      expect(answer.status).toBe("done");
      const slots = (JSON.parse(answer.tools.find((t) => t.tool === "find_free_slots")!.shared!) as { slots: string[] }).slots;
      expect(slots.length).toBeGreaterThanOrEqual(2);
      expect(answer.text).toContain(`I'm free ${slots[0]} or ${slots[1]}`);
      expect(answer.text).toContain("Hi Raj");
      expect(answer.outcome?.route).toBe("cloudOnly");
      const shared = answer.tools.map((t) => t.shared ?? "").join("\n");
      for (const raw of ["Raj", "Maya", "Elm", "Dentist", "Day off", "stand-up"]) expect(shared).not.toContain(raw);
      expect(s.getState().consents).toHaveLength(0);

      // Tool activity survives a reload.
      const again = new AirlockSession(s.services, { onboarded: true, preference: "best" });
      await again.load();
      const reloaded = again.getState().threads[0]!.turns.at(-1)!;
      expect(reloaded.kind === "assistant" && reloaded.tools.map((t) => t.status)).toEqual(["allowed", "allowed"]);
      expect(again.getState().calendar).toMatchObject({ sample: true });
    });

    it("declining consent still yields a sensible draft", async () => {
      const s = await demoSession();
      await s.useSampleCalendar();
      await s.startReview(MEET, { kind: "meeting" });
      await sendAnswering(s, "deny");
      const answer = s.getState().threads[0]!.turns.at(-1)!;
      if (answer.kind !== "assistant") throw new Error("expected answer");
      expect(answer.status).toBe("done");
      expect(answer.text).toContain("Could we find a time next week");
      expect(answer.tools.map((t) => [t.status, t.shared])).toEqual([["declined", '{"error":"user_declined"}'], ["declined", '{"error":"user_declined"}']]);
    });

    it("without a calendar the free-time tool isn't offered; 'Always allow' skips the date card next time; remove calendar", async () => {
      const s = await demoSession();
      await s.startReview(MEET, { kind: "meeting" });
      const seen: string[] = [];
      const off = s.subscribe(() => {
        for (const c of s.getState().consents) if (!seen.includes(c.id)) { seen.push(c.id); queueMicrotask(() => s.answerConsent(c.id, "allow", true)); }
      });
      await s.send();
      off();
      expect(seen).toHaveLength(1);
      expect(s.getState().prefs.toolsAlwaysAllow).toEqual(["today_context"]);
      const id = s.getState().currentThreadId!;
      await s.startReview("And if Raj can't make it?", { kind: "meeting" }, id);
      await s.send();
      const last = s.getState().threads[0]!.turns.at(-1)!;
      expect(last.kind === "assistant" && last.tools.map((t) => t.status)).toEqual(["allowed"]);
      expect(s.getState().consents).toHaveLength(0);
      await s.useSampleCalendar();
      await s.removeCalendar();
      expect(s.getState().calendar).toBeNull();
      expect(await s.importCalendar("not a calendar")).toBe(false);
    });
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

  it("a mark made while the red-team check is still running survives the late result (regression)", async () => {
    const services = await createServices("?demo=1");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const phone = services.engines.phone;
    const slowPhone = { availability: () => phone.availability(), respond: async (p: Parameters<typeof phone.respond>[0], o: Parameters<typeof phone.respond>[1]) => { if (p.promptId === "attack.v1") await gate; return phone.respond(p, o); } };
    const s = new AirlockSession({ ...services, engines: { phone: slowPhone, sealed: services.engines.sealed.bind(services.engines), tools: services.engines.tools.bind(services.engines) } }, { dial: "balanced", preference: "best", onboarded: true, backup: false });
    await s.load();
    await s.deleteEverything();
    s.setPrefs({ onboarded: true, dial: "balanced", backup: false });
    const started = s.startReview("The leak at Willowbrook Court got worse, Raj.", { kind: "help" });
    while (!s.getState().review?.result) await new Promise((r) => setTimeout(r, 1));
    expect(s.getState().review!.result!.redTeamPending).toBe(true);
    expect(s.protect("Willowbrook Court", "location")).toBe(true);
    release();
    await started;
    const after = s.getState().review!.result!;
    expect(after.redTeamPending).toBe(false);
    expect(after.draft.text).not.toContain("Willowbrook");
  });

  it("strict: the draft shows first and the red-team's rewrites join it, with the user's mark kept (FX-02)", async () => {
    const services = await createServices("?demo=1");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const base = services.engines.phone;
    const scripted = { availability: () => base.availability(), respond: async (p: Parameters<typeof base.respond>[0], o: Parameters<typeof base.respond>[1]) => {
      if (p.promptId === "attack.v1") { await gate; return { text: JSON.stringify({ guesses: [{ attribute: "location", evidence: "near the old mill", confidence: "high" }] }), modelVersion: "mock", ranOnDevice: true, latencyMs: 0 }; }
      if (p.promptId === "gen.v1" && p.text.includes("near the old mill")) return { text: JSON.stringify({ rewrite: "in the area" }), modelVersion: "mock", ranOnDevice: true, latencyMs: 0 };
      return base.respond(p, o);
    } };
    const s = new AirlockSession({ ...services, engines: { phone: scripted, sealed: services.engines.sealed.bind(services.engines), tools: services.engines.tools.bind(services.engines) } }, { dial: "strict", preference: "best", onboarded: true, backup: false });
    await s.load();
    await s.deleteEverything();
    s.setPrefs({ onboarded: true, dial: "strict", backup: false });
    const started = s.startReview("I live near the old mill and the leak at Willowbrook Court got worse.", { kind: "help" });
    while (!s.getState().review?.result) await new Promise((r) => setTimeout(r, 1));
    const early = s.getState().review!.result!;
    expect(early.redTeamPending).toBe(true);
    expect(early.draft.text).toContain("near the old mill");
    expect(s.protect("Willowbrook Court", "location")).toBe(true);
    release();
    await started;
    const after = s.getState().review!.result!;
    expect(after.redTeamPending).toBe(false);
    expect(after.draft.text).not.toContain("Willowbrook");
    expect(after.draft.text).not.toContain("near the old mill");
    expect(s.getState().review!.accepted.length).toBeGreaterThan(0);
  });

  it("titles never contain placeholder tokens", () => {
    expect(titleFrom("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken")).toBe("Hi someone the heater at a place");
    expect(titleFrom("[[PERSON_ME]]")).toBe("Me");
    expect(titleFrom("[[SECRET_1]] !!")).toBe("A code");
  });
});
