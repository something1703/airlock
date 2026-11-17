// On-device encrypted storage for the web app (INV-6) — port of AirlockStore (Swift).
// AES-256-GCM via WebCrypto; the key is generated NON-EXTRACTABLE and kept in IndexedDB, so no script can
// export it. Each record's name is authenticated data, so records can't be swapped between slots.
import { EntityMap, type Entity, type LegendLine, type Route } from "../engine/types";
import type { TaskKind } from "../engine/answer";
import type { Receipt } from "../engine/hashchain";
import type { VaultEntry } from "../engine/vault";

export class StoreError extends Error {
  constructor(readonly code: "decryptionFailed" | "notFound" | "invalidName" | "io" | "unsupportedVersion") {
    super(`Store error: ${code}`);
    this.name = "StoreError";
  }
}

const VERSION = 1;
const KEY_ID = "master-v1";
interface Blob {
  v: number;
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(new StoreError("io")); });

export const validName = (n: string): boolean => n.length > 0 && n.length <= 120 && !n.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(n);
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);

export class EncryptedStore {
  private constructor(
    private readonly db: IDBDatabase,
    private key: CryptoKey,
    private readonly name: string,
    private readonly idb: IDBFactory,
  ) {}

  static async open(name = "airlock", idb: IDBFactory = indexedDB): Promise<EncryptedStore> {
    const open = idb.open(name, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("keys");
      open.result.createObjectStore("records");
    };
    const db = await req(open);
    let key = (await req(db.transaction("keys").objectStore("keys").get(KEY_ID))) as CryptoKey | undefined;
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await req(db.transaction("keys", "readwrite").objectStore("keys").put(key, KEY_ID));
    }
    return new EncryptedStore(db, key, name, idb);
  }

  async write(name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!validName(name)) throw new StoreError("invalidName");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name) }, this.key, data);
    const blob: Blob = { v: VERSION, iv, ct };
    await req(this.db.transaction("records", "readwrite").objectStore("records").put(blob, name));
  }

  async read(name: string): Promise<Uint8Array<ArrayBuffer>> {
    if (!validName(name)) throw new StoreError("invalidName");
    const blob = (await req(this.db.transaction("records").objectStore("records").get(name))) as Blob | undefined;
    if (!blob) throw new StoreError("notFound");
    if (blob.v !== VERSION) throw new StoreError("unsupportedVersion");
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv, additionalData: new TextEncoder().encode(name) }, this.key, blob.ct));
    } catch {
      throw new StoreError("decryptionFailed");
    }
  }

  /** Raw stored value (tests and tamper checks only). */
  async rawRecord(name: string): Promise<unknown> {
    return req(this.db.transaction("records").objectStore("records").get(name));
  }
  async putRawRecord(name: string, value: unknown): Promise<void> {
    await req(this.db.transaction("records", "readwrite").objectStore("records").put(value, name));
  }

  async writeJson(name: string, value: unknown): Promise<void> {
    await this.write(name, new TextEncoder().encode(JSON.stringify(value)));
  }
  async readJson<T>(name: string): Promise<T> {
    try {
      return JSON.parse(new TextDecoder().decode(await this.read(name))) as T;
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError("decryptionFailed");
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const keys = (await req(this.db.transaction("records").objectStore("records").getAllKeys())) as string[];
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }
  async delete(name: string): Promise<void> {
    await req(this.db.transaction("records", "readwrite").objectStore("records").delete(name));
  }

  /** Settings → Delete everything: every record, then the key itself (leftover copies become unreadable). */
  async deleteEverything(): Promise<void> {
    await req(this.db.transaction("records", "readwrite").objectStore("records").clear());
    await req(this.db.transaction("keys", "readwrite").objectStore("keys").clear());
    this.key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await req(this.db.transaction("keys", "readwrite").objectStore("keys").put(this.key, KEY_ID));
  }

  close(): void {
    this.db.close();
  }
  get dbName(): string {
    return this.name;
  }
  get factory(): IDBFactory {
    return this.idb;
  }
}

// MARK: Typed records (port of AirlockStores.swift)

interface EntityJson extends Omit<Entity, "surfaceForms" | "sources"> {
  surfaceForms: string[];
  sources: string[];
}
const toJson = (m: EntityMap): EntityJson[] => m.sorted().map((e) => ({ ...e, surfaceForms: [...e.surfaceForms].sort(), sources: [...e.sources].sort() }));
const fromJson = (list: EntityJson[]): EntityMap =>
  new EntityMap(list.map((e) => ({ ...e, surfaceForms: new Set(e.surfaceForms), sources: new Set(e.sources) }) as Entity));

export interface CaptureRecord {
  id: string;
  createdAt: number;
  threadId: string | null;
  source: "paste" | "photo" | "pdf" | "share" | "followUp";
  text: string;
}

/** The sealed side of a user turn, kept so it can be re-checked by the gate on reload (never trusted as-is). */
export interface StoredSealed {
  text: string;
  legend: LegendLine[];
  revealedVaultIds: string[];
  keptValues: string[];
}
export interface StoredOutcome {
  route: Route;
  modelVersion: string;
  ranOnDevice: boolean;
  fellBackToPhone: boolean;
  latencyMs: number;
  receiptId: string | null;
}
export type StoredTurn =
  | { kind: "user"; raw: string; sealed: StoredSealed }
  | { kind: "assistant"; task: TaskKind; status: "done" | "error"; modelText: string; error: string | null; outcome: StoredOutcome | null };
export interface ThreadRecord {
  v: 1;
  id: string;
  title: string;
  task: TaskKind;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

/** All sensitive persistence. Nothing here ever syncs (INV-6, ADR-09). */
export class AirlockStores {
  constructor(readonly store: EncryptedStore) {}

  saveEntities(thread: string, map: EntityMap): Promise<void> {
    return this.store.writeJson(`entities-${safe(thread)}`, toJson(map));
  }
  async loadEntities(thread: string): Promise<EntityMap> {
    try {
      return fromJson(await this.store.readJson<EntityJson[]>(`entities-${safe(thread)}`));
    } catch (e) {
      if (e instanceof StoreError && e.code === "notFound") return new EntityMap();
      throw e;
    }
  }

  saveVault(entries: VaultEntry[]): Promise<void> {
    return this.store.writeJson("vault", entries);
  }
  async loadVault(): Promise<VaultEntry[]> {
    try {
      return await this.store.readJson<VaultEntry[]>("vault");
    } catch (e) {
      if (e instanceof StoreError && e.code === "notFound") return [];
      throw e;
    }
  }

  async saveCapture(text: string, source: CaptureRecord["source"], threadId: string | null = null, now = Date.now(), id: string = crypto.randomUUID()): Promise<CaptureRecord> {
    const rec: CaptureRecord = { id, createdAt: now, threadId, source, text };
    await this.store.writeJson(`capture-${safe(id)}`, rec);
    return rec;
  }
  async captures(): Promise<CaptureRecord[]> {
    const out: CaptureRecord[] = [];
    for (const n of await this.store.list("capture-")) {
      try {
        out.push(await this.store.readJson<CaptureRecord>(n));
      } catch {
        // Unreadable (wrong key / tampered): skipped here, removed by purge.
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  /** Deletes captures older than `days` days (and unreadable ones); returns how many were removed. */
  async purgeCaptures(days: number, now = Date.now()): Promise<number> {
    const cutoff = now - Math.max(0, days) * 86_400_000;
    let removed = 0;
    for (const n of await this.store.list("capture-")) {
      let keep = false;
      try {
        keep = (await this.store.readJson<CaptureRecord>(n)).createdAt >= cutoff;
      } catch {
        keep = false;
      }
      if (!keep) {
        await this.store.delete(n);
        removed++;
      }
    }
    return removed;
  }
  /** One conversation (raw turns, sealed turns, model text). Local only, encrypted; never synced (INV-7). */
  saveThread(rec: ThreadRecord): Promise<void> {
    return this.store.writeJson(`thread-${safe(rec.id)}`, rec);
  }
  async threads(): Promise<ThreadRecord[]> {
    const out: ThreadRecord[] = [];
    for (const n of await this.store.list("thread-")) {
      try {
        const rec = await this.store.readJson<ThreadRecord>(n);
        if (rec.v === 1) out.push(rec);
      } catch {
        // Unreadable records are skipped (wrong key / tampered).
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteThread(thread: string): Promise<void> {
    await this.store.delete(`thread-${safe(thread)}`);
    await this.store.delete(`entities-${safe(thread)}`);
    for (const c of await this.captures()) if (c.threadId === thread) await this.store.delete(`capture-${safe(c.id)}`);
  }

  saveReceipt(r: Receipt): Promise<void> {
    return this.store.writeJson(`receipt-${String(r.seq).padStart(8, "0")}`, r);
  }
  async receipts(): Promise<Receipt[]> {
    const out: Receipt[] = [];
    for (const n of await this.store.list("receipt-")) out.push(await this.store.readJson<Receipt>(n));
    return out;
  }

  deleteEverything(): Promise<void> {
    return this.store.deleteEverything();
  }
}
