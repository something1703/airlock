import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app/services";
import { AirlockSession } from "../src/app/session";
import type { SealedSync, SyncBatch } from "../src/ai/sync";
import type { TaskKind } from "../src/engine/answer";
import { int, pick, rng } from "./support";

class FakeSync implements SealedSync {
  batches: SyncBatch[] = [];
  deletedThreads: string[] = [];
  wiped = 0;
  async push(b: SyncBatch) { this.batches.push(structuredClone(b)); }
  async deleteThread(id: string) { this.deletedThreads.push(id); }
  async deleteAll() { this.wiped++; }
}

const NAMES = ["Raj Patel", "Maya Chen", "Priya Natarajan", "Daniel Okafor"];
const PLACES = ["14 Elm St, Apt 3B", "22 Baker Street", "9 Rue Cler"];
const PHONES = ["312-555-0147", "415-555-0199"];

async function session(prefs: Partial<{ backup: boolean; preference: "auto" | "phoneOnly" | "best" }> = {}) {
  const services = await createServices("?demo=1");
  const fake = new FakeSync();
  const s = new AirlockSession({ ...services, sync: fake }, { dial: "balanced", preference: prefs.preference ?? "best", onboarded: true, backup: prefs.backup ?? true });
  await s.load();
  await s.deleteEverything();
  s.setPrefs({ onboarded: true, preference: prefs.preference ?? "best", backup: prefs.backup ?? true });
  fake.batches = [];
  fake.wiped = 0;
  await s.saveVault(NAMES.map((n, i) => ({ id: `v${i}`, canonical: n, aliases: [n.split(" ")[0]!], category: "person" as const, roleHint: null, isUser: i === 1 })));
  return { s, fake };
}

describe("sealed-history backup (INV-7)", () => {
  it("property: the backup is exactly what already left — no Vault name or protected detail, ever", async () => {
    const r = rng(20261117);
    for (let k = 0; k < 15; k++) {
      const { s, fake } = await session();
      const name = pick(r, NAMES);
      const place = pick(r, PLACES); // may be undetected by the scripted demo model; then it legitimately left
      const phone = pick(r, PHONES);
      const text = `Hi ${name.split(" ")[0]}, about ${place}: call ${phone}. ${"Thanks ".repeat(int(r, 0, 3))}${pick(r, NAMES)}`;
      const tasks: TaskKind[] = [{ kind: "help" }, { kind: "reply", tone: "polite" }, { kind: "questions" }];
      await s.startReview(text, pick(r, tasks));
      await s.send();
      await new Promise((res) => setTimeout(res, 0));
      const blob = JSON.stringify(fake.batches);
      expect(fake.batches.length).toBeGreaterThan(0);
      // 1. Vault names and pattern-protected details never appear.
      for (const raw of [...NAMES.flatMap((n) => n.split(" ")), phone]) expect(blob, raw).not.toContain(raw);
      expect(blob).not.toContain("outboundText");
      expect(blob).not.toContain('"raw"');
      // 2. The backup is exactly what already left: user turn text + legend == the receipt's outbound text.
      const receipts = new Map(s.ledger.receipts.map((x) => [x.id, x.outboundText]));
      for (const b of fake.batches) for (const t of b.turns.filter((x) => x.dto.role === "user")) {
        const sent = receipts.get(t.dto.receiptId!);
        expect(sent).toBeDefined();
        expect(t.dto.legend ? `${t.dto.sealedText}\n\n${t.dto.legend}` : t.dto.sealedText).toBe(sent);
      }
      // 3. Every protected entity's real value is absent.
      const thread = s.getState().threads[0]!;
      for (const e of thread.entities.sorted()) if (e.action.kind !== "keep") expect(blob, e.canonical).not.toContain(e.canonical);
    }
  });

  it("only turns that already went to Gemini are backed up; on-device answers stay on the device", async () => {
    const { s, fake } = await session({ preference: "phoneOnly" });
    await s.startReview("Summarise: Raj fixed the heater at 14 Elm St.", { kind: "summary" });
    await s.send();
    await new Promise((res) => setTimeout(res, 0));
    expect(s.ledger.receipts).toHaveLength(0);
    expect(fake.batches).toHaveLength(0);
  });

  it("respects the toggle, and deletes follow the user's intent", async () => {
    const off = await session({ backup: false });
    await off.s.startReview("Hi Raj, the heater at 14 Elm St is broken.", { kind: "help" });
    await off.s.send();
    expect(off.fake.batches).toHaveLength(0);

    const on = await session();
    await on.s.startReview("Hi Raj, the heater at 14 Elm St is broken.", { kind: "help" });
    await on.s.send();
    await new Promise((res) => setTimeout(res, 0));
    const b = on.fake.batches.at(-1)!;
    expect(b.turns.map((t) => t.id)).toEqual(["000-user", "001-assistant"]);
    expect(b.receipt?.id).toBe(on.s.ledger.receipts.at(-1)!.id);
    const id = on.s.getState().currentThreadId!;
    await on.s.deleteThread(id);
    expect(on.fake.deletedThreads).toEqual([id]);
    await on.s.deleteEverything();
    expect(on.fake.wiped).toBe(1);
  });
});
