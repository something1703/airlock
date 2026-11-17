import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AirlockStores, EncryptedStore, StoreError, validName } from "../src/store/encryptedStore";
import { EntityMap, makeEntity } from "../src/engine";

const fresh = (): Promise<EncryptedStore> => EncryptedStore.open("t", new IDBFactory());
const bytesOf = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof ArrayBuffer ? Buffer.from(x).toString("latin1") : x instanceof Uint8Array ? Buffer.from(x).toString("latin1") : x));

describe("encrypted store (IndexedDB + WebCrypto)", () => {
  it("round-trips and stores only ciphertext", async () => {
    const s = await fresh();
    await s.write("note", new TextEncoder().encode("Raj Patel, 14 Elm St, Mercy General"));
    expect(new TextDecoder().decode(await s.read("note"))).toBe("Raj Patel, 14 Elm St, Mercy General");
    const raw = bytesOf(await s.rawRecord("note"));
    for (const needle of ["Raj", "Patel", "Elm", "Mercy"]) expect(raw).not.toContain(needle);
  });
  it("the key is non-extractable", async () => {
    const s = await fresh();
    const key = (s as unknown as { key: CryptoKey }).key;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });
  it("tampering and swapped records fail to decrypt", async () => {
    const s = await fresh();
    await s.write("a", new TextEncoder().encode("one"));
    await s.write("b", new TextEncoder().encode("two"));
    const rec = (await s.rawRecord("a")) as { v: number; iv: Uint8Array; ct: ArrayBuffer };
    await s.putRawRecord("b", rec);
    await expect(s.read("b")).rejects.toMatchObject({ code: "decryptionFailed" });
    const ct = new Uint8Array(rec.ct.slice(0));
    ct[0] = ct[0]! ^ 1;
    await s.putRawRecord("a", { ...rec, ct: ct.buffer });
    await expect(s.read("a")).rejects.toMatchObject({ code: "decryptionFailed" });
    await s.putRawRecord("c", { ...rec, v: 9 });
    await expect(s.read("c")).rejects.toMatchObject({ code: "unsupportedVersion" });
  });
  it("names are validated; missing records are notFound", async () => {
    const s = await fresh();
    for (const bad of ["../x", "a/b", ".hidden", "", "a b", "é"]) expect(validName(bad)).toBe(false);
    await expect(s.write("../x", new Uint8Array())).rejects.toBeInstanceOf(StoreError);
    await expect(s.read("nope")).rejects.toMatchObject({ code: "notFound" });
  });
});

describe("Airlock stores", () => {
  it("entity maps and the Vault are encrypted at rest", async () => {
    const s = await fresh();
    const stores = new AirlockStores(s);
    const raj = makeEntity({ id: "PERSON_1", category: "person", canonical: "Raj Patel", surfaceForms: new Set(["Raj"]), roleHint: "the user's landlord", sources: new Set(["vault"]), confidence: "high", vaultEntryId: "v1" });
    await stores.saveEntities("thr_1", new EntityMap([raj]));
    await stores.saveVault([{ id: "v1", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false }]);
    const back = await stores.loadEntities("thr_1");
    expect(back.get("PERSON_1")?.canonical).toBe("Raj Patel");
    expect(back.get("PERSON_1")?.surfaceForms.has("Raj")).toBe(true);
    expect((await stores.loadVault())[0]?.aliases).toEqual(["Raj"]);
    expect((await stores.loadEntities("other")).size).toBe(0);
    for (const n of await s.list()) {
      const raw = bytesOf(await s.rawRecord(n));
      for (const needle of ["Raj", "Patel", "landlord", "PERSON_1"]) expect(raw, n).not.toContain(needle);
    }
  });
  it("captures save, list newest-first, purge by age, delete with their thread", async () => {
    const stores = new AirlockStores(await fresh());
    const now = 1_800_000_000_000;
    const day = 86_400_000;
    await stores.saveCapture("old lease text about Mercy General", "paste", null, now - 40 * day, "old");
    await stores.saveCapture("recent", "photo", "thr_1", now - 5 * day, "recent");
    await stores.saveCapture("today", "pdf", null, now, "today");
    expect((await stores.captures()).map((c) => c.id)).toEqual(["today", "recent", "old"]);
    expect(await stores.purgeCaptures(30, now)).toBe(1);
    await stores.deleteThread("thr_1");
    expect((await stores.captures()).map((c) => c.id)).toEqual(["today"]);
  });
  it("delete everything destroys records and the key", async () => {
    const s = await fresh();
    const stores = new AirlockStores(s);
    await stores.saveVault([{ id: "v", canonical: "Maya Chen", aliases: [], category: "person", isUser: true }]);
    const leftover = await s.rawRecord("vault");
    await stores.deleteEverything();
    expect(await s.list()).toEqual([]);
    await s.putRawRecord("vault", leftover);
    await expect(s.read("vault")).rejects.toMatchObject({ code: "decryptionFailed" });
  });
});
