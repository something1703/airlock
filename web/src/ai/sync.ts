// Sealed-history backup to Firestore (docs/05 §6). Writes ONLY the DTOs from app/syncDto.ts (INV-7): sealed
// turns, the model's placeholder text, receipt metadata without outboundText. Best-effort and never awaited
// by the UI; Firestore rules (firebase/firestore.rules) reject anything that looks unsealed.
import type { FirebaseApp } from "firebase/app";
import { getAuth, onAuthStateChanged, type User } from "firebase/auth";
import { collection, deleteDoc, doc, getDocs, getFirestore, setDoc, type Firestore } from "firebase/firestore";
import type { ReceiptDto, ThreadDto, TurnDto } from "../app/syncDto";

export interface SyncBatch {
  threadId: string;
  thread: ThreadDto;
  /** Deterministic ids (e.g. "003-user") so a retry never duplicates a turn. */
  turns: { id: string; dto: TurnDto }[];
  receipt: ReceiptDto | null;
  profile: { dial: string; appVersion: string };
}

/** Anything that can back up sealed history (Firestore in live mode; nothing in demo/tests). */
export interface SealedSync {
  push(batch: SyncBatch): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export class FirestoreSync implements SealedSync {
  private readonly db: Firestore;
  private readonly user: Promise<User | null>;

  constructor(app: FirebaseApp) {
    this.db = getFirestore(app);
    const auth = getAuth(app);
    this.user = new Promise((resolve) => {
      const stop = onAuthStateChanged(auth, (u) => {
        if (u) {
          stop();
          resolve(u);
        }
      });
      setTimeout(() => resolve(auth.currentUser), 10_000);
    });
  }

  async push(b: SyncBatch): Promise<void> {
    const uid = (await this.user)?.uid;
    if (!uid) return;
    await setDoc(doc(this.db, `users/${uid}`), { dial: b.profile.dial, appVersion: b.profile.appVersion }, { merge: true });
    await setDoc(doc(this.db, `users/${uid}/threads/${b.threadId}`), b.thread);
    for (const t of b.turns) {
      // Turns are immutable: re-sending an existing one is rejected by the rules, which is fine.
      await setDoc(doc(this.db, `users/${uid}/threads/${b.threadId}/turns/${t.id}`), t.dto).catch(() => {});
    }
    if (b.receipt) await setDoc(doc(this.db, `users/${uid}/receipts/${b.receipt.id}`), b.receipt).catch(() => {});
  }

  async deleteThread(threadId: string): Promise<void> {
    const uid = (await this.user)?.uid;
    if (!uid) return;
    const ref = doc(this.db, `users/${uid}/threads/${threadId}`);
    for (const turn of (await getDocs(collection(ref, "turns"))).docs) await deleteDoc(turn.ref);
    await deleteDoc(ref);
  }

  /** Client-side delete of everything the rules let the owner delete (weekly stats need the deleteUserData function). */
  async deleteAll(): Promise<void> {
    const uid = (await this.user)?.uid;
    if (!uid) return;
    const threads = await getDocs(collection(this.db, `users/${uid}/threads`));
    for (const t of threads.docs) {
      for (const turn of (await getDocs(collection(t.ref, "turns"))).docs) await deleteDoc(turn.ref);
      await deleteDoc(t.ref);
    }
    for (const r of (await getDocs(collection(this.db, `users/${uid}/receipts`))).docs) await deleteDoc(r.ref);
    await deleteDoc(doc(this.db, `users/${uid}`));
  }
}
