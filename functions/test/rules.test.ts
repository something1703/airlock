// Firestore rules against the emulator (`npm run test:emulator`). Uses the REAL web pipeline + egress gate to
// produce sealed text, and the web's own DTO builders, so the rules are tested on exactly what the app sends.
import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EgressGate, makeReceipt, MockPhoneEngine, PatternDetector, PromptLibrary, SealPipeline, GENESIS, type SealedText } from "../../web/src/engine/index";
import { sealSettings } from "../../web/src/engine/pipeline";
import { AppConfig } from "../../web/src/core/appConfig";
import { assistantTurnDto, receiptDto, threadDto, userTurnDto } from "../../web/src/app/syncDto";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("Firestore rules (emulator)", () => {
  let env: RulesTestEnvironment;
  let sealed: SealedText;
  const RAW = "Hi Raj, the heater at 14 Elm St, Apt 3B is broken. Call me on 312-555-0147. Thanks, Maya Chen";

  beforeAll(async () => {
    const [host, port] = emulator!.split(":");
    env = await initializeTestEnvironment({ projectId: "demo-airlock", firestore: { rules: readFileSync(new URL("../../firebase/firestore.rules", import.meta.url), "utf8"), host, port: Number(port) } });
    const vault = [
      { id: "me", canonical: "Maya Chen", aliases: ["Maya"], category: "person" as const, roleHint: "me", isUser: true },
      { id: "raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person" as const, roleHint: "my landlord", isUser: false },
    ];
    const patterns = new PatternDetector();
    const phone = new MockPhoneEngine((id) => (id === "attack.v1" ? '{"guesses":[]}' : '{"items":[]}'));
    const result = await new SealPipeline(phone, patterns, vault, new PromptLibrary(), sealSettings(new AppConfig(), { dial: "balanced" })).run(RAW);
    sealed = new EgressGate(patterns, vault).seal(result.draft);
  });
  afterAll(async () => env?.cleanup());
  beforeEach(async () => env.clearFirestore());

  const alice = () => env.authenticatedContext("alice").firestore();
  const now = Date.parse("2026-11-17T10:00:00Z");
  const receipt = () => makeReceipt(sealed, 1, GENESIS, "t1", "cloudFirst", "gemini-3.8-flash", "notConfigured", 1200, 3400, new Date(now));

  it("accepts exactly what the web app syncs", async () => {
    const db = alice();
    const r = receipt();
    expect(sealed.value).not.toMatch(/Raj|Maya|Elm|312-555/);
    await assertSucceeds(setDoc(doc(db, "users/alice"), { createdAt: new Date(now), dial: "balanced", appVersion: "web-0.1.0" }));
    await assertSucceeds(setDoc(doc(db, "users/alice/threads/t1"), threadDto({ title: "Heater broken, urgent repair", createdAt: now, updatedAt: now, lastRoute: "cloudFirst", turnCount: 2 })));
    await assertSucceeds(setDoc(doc(db, "users/alice/threads/t1/turns/u1"), userTurnDto(sealed, "cloudFirst", "gemini-3.8-flash", r.id, now)));
    await assertSucceeds(setDoc(doc(db, "users/alice/threads/t1/turns/a1"), assistantTurnDto("Hi [[PERSON_1]], the heater at [[LOC_1]] still needs fixing.", "cloudFirst", "gemini-3.8-flash", r.id, now)));
    await assertSucceeds(setDoc(doc(db, `users/alice/receipts/${r.id}`), receiptDto(r)));
    await assertSucceeds(getDoc(doc(db, "users/alice/threads/t1/turns/u1")));
  });

  it("rejects raw-text fields, outboundText and unknown fields", async () => {
    const db = alice();
    const r = receipt();
    await assertFails(setDoc(doc(db, `users/alice/receipts/${r.id}`), r)); // still has outboundText
    await assertFails(setDoc(doc(db, "users/alice/threads/t1/turns/u1"), { ...userTurnDto(sealed, "cloudFirst", "m", null, now), raw: RAW }));
    await assertFails(setDoc(doc(db, "users/alice/threads/t1/turns/u1"), { ...userTurnDto(sealed, "cloudFirst", "m", null, now), restored: "Hi Raj" }));
    await assertFails(setDoc(doc(db, "users/alice/threads/t1/turns/u1"), { ...userTurnDto(sealed, "cloudFirst", "m", null, now), extra: 1 }));
    await assertFails(setDoc(doc(db, "users/alice"), { createdAt: new Date(now), entityMap: {} }));
  });

  it("the identifier tripwire blocks emails, card-like and SSN-like numbers (RE2)", async () => {
    const db = alice();
    const turn = (sealedText: string) => setDoc(doc(db, `users/alice/threads/t1/turns/${Math.random().toString(36).slice(2)}`), { createdAt: new Date(now), role: "user", sealedText, route: "cloudFirst", modelVersion: "m", receiptId: null });
    for (const bad of ["mail maya.chen@example.com now", "card 4111 1111 1111 1111", "card 4111-1111-1111-1111", "ssn 123-45-6789", "multi\nline\nraj@example.org"]) await assertFails(turn(bad));
    for (const ok of ["Hi [[PERSON_1]]", "Call [[CONTACT_1]] about the £1,200 deposit on 12/03", "Room 1234 5678"]) await assertSucceeds(turn(ok));
    await assertFails(turn("x".repeat(40_001)));
    await assertFails(setDoc(doc(db, "users/alice/threads/t2"), { title: "Email raj@example.com", createdAt: new Date(now) }));
  });

  it("turns and receipts are immutable; other users and anonymous callers are locked out", async () => {
    const r = receipt();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "users/alice/threads/t1/turns/u1"), userTurnDto(sealed, "cloudFirst", "m", null, now));
      await setDoc(doc(ctx.firestore(), `users/alice/receipts/${r.id}`), receiptDto(r));
      await setDoc(doc(ctx.firestore(), "users/alice/stats/2026-W47"), { requests: 1 });
    });
    const db = alice();
    await assertFails(updateDoc(doc(db, "users/alice/threads/t1/turns/u1"), { sealedText: "edited" }));
    await assertFails(updateDoc(doc(db, `users/alice/receipts/${r.id}`), { seq: 2 }));
    await assertSucceeds(getDoc(doc(db, "users/alice/stats/2026-W47")));
    await assertFails(setDoc(doc(db, "users/alice/stats/2026-W47"), { requests: 99 }));
    await assertSucceeds(deleteDoc(doc(db, "users/alice/threads/t1/turns/u1")));

    const bob = env.authenticatedContext("bob").firestore();
    await assertFails(getDoc(doc(bob, `users/alice/receipts/${r.id}`)));
    await assertFails(setDoc(doc(bob, "users/alice/threads/t9"), threadDto({ title: "x", createdAt: now, updatedAt: now, lastRoute: "cloudFirst", turnCount: 0 })));
    const anon = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, "users/alice")));
    await assertFails(setDoc(doc(anon, "elsewhere/x"), { a: 1 }));
  });

  it("receipt fields are type-checked", async () => {
    const db = alice();
    const good = receiptDto(receipt());
    await assertFails(setDoc(doc(db, "users/alice/receipts/r2"), { ...good, hash: "not-hex" }));
    await assertFails(setDoc(doc(db, "users/alice/receipts/r3"), { ...good, seq: "1" }));
    await assertFails(setDoc(doc(db, "users/alice/receipts/r4"), { ...good, route: "teleport" }));
    await assertFails(setDoc(doc(db, "users/alice/receipts/r5"), { ...good, armor: "maybe" }));
  });
});
