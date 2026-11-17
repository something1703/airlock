// Cloud Functions against the Firestore emulator. Handlers are invoked directly via `.run(event)`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("functions (emulator)", () => {
  let fns: typeof import("../src/index.js");
  let db: import("firebase-admin/firestore").Firestore;

  beforeAll(async () => {
    process.env.GCLOUD_PROJECT = "demo-airlock";
    fns = await import("../src/index.js");
    db = (await import("firebase-admin/firestore")).getFirestore();
  });
  afterAll(async () => {
    await db?.recursiveDelete(db.collection("users"));
  });

  const receipt = (id: string, createdAt: string, counts: Record<string, number>, modelVersion = "gemini-3.8-flash") => ({ id, createdAt, modelVersion, armor: "notConfigured", counts });
  const fire = (uid: string, r: ReturnType<typeof receipt>) =>
    (fns.aggregateStats as unknown as { run: (e: unknown) => Promise<void> }).run({ params: { uid, receiptId: r.id }, data: { data: () => r } });

  it("aggregateStats buckets by ISO week and is idempotent under retries", async () => {
    const r1 = receipt("rcpt_0001", "2026-11-17T10:00:00Z", { person: 2, contact: 1, generalised: 1 });
    await fire("alice", r1);
    await fire("alice", r1); // at-least-once retry
    await fire("alice", receipt("rcpt_0002", "2026-11-18T09:00:00Z", { person: 1 }, "chrome-gemini-nano"));
    await fire("alice", receipt("rcpt_0003", "2026-11-24T09:00:00Z", { location: 1 }));
    const w47 = (await db.doc("users/alice/stats/2026-W47").get()).data();
    expect(w47).toMatchObject({ week: "2026-W47", requests: 2, sealedDetails: 5, generalised: 1, cloudAnswers: 1, onDeviceAnswers: 1, byCategory: { person: 3, contact: 1 } });
    expect((await db.doc("users/alice/stats/2026-W48").get()).data()).toMatchObject({ requests: 1, byCategory: { location: 1 } });
  });

  it("deleteUserData removes the caller's whole subtree and nobody else's", async () => {
    await db.doc("users/bob").set({ dial: "strict" });
    await db.doc("users/bob/threads/t1/turns/u1").set({ sealedText: "Hi [[PERSON_1]]" });
    await db.doc("users/carol/threads/t1").set({ title: "keep" });
    const run = (fns.deleteUserData as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    await expect(run({ data: {}, auth: undefined })).rejects.toThrow();
    await run({ data: {}, auth: { uid: "bob", token: {} } });
    expect((await db.doc("users/bob/threads/t1/turns/u1").get()).exists).toBe(false);
    expect((await db.doc("users/bob").get()).exists).toBe(false);
    expect((await db.doc("users/carol/threads/t1").get()).exists).toBe(true);
  });

  it("scanSealed requires auth and valid input before touching the DLP API", async () => {
    const run = (fns.scanSealed as unknown as { run: (r: unknown) => Promise<unknown> }).run;
    await expect(run({ data: { text: "Hi" } })).rejects.toThrow(/Sign-in/);
    await expect(run({ data: { text: "x".repeat(20_001) }, auth: { uid: "a", token: {} } })).rejects.toThrow(/too-long/);
    await expect(run({ data: {}, auth: { uid: "a", token: {} } })).rejects.toThrow(/missing-text/);
    vi.restoreAllMocks();
  });
});
