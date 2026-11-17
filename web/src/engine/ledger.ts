import { GENESIS, sealReceipt, verifyChain, type ChainVerification, type Receipt } from "./hashchain";
import { CHROME_ON_DEVICE_MODEL } from "./engines";
import { ALL_CATEGORIES, renderedLegend, type Route, type SealedText } from "./types";

/** ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z`. */
export const timestamp = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function makeReceipt(sealed: SealedText, seq: number, prevHash: string, threadId: string, route: Route, modelVersion: string, armor: Receipt["armor"], sealMs: number, networkMs: number, at: Date): Receipt {
  const outbound = sealed.legend.length === 0 ? sealed.value : `${sealed.value}\n\n${renderedLegend(sealed)}`;
  return sealReceipt({
    id: `rcpt_${String(seq).padStart(4, "0")}`, seq, createdAt: timestamp(at), threadId, route, modelVersion, outboundSha256: sealed.gateReport.outboundSha256,
    outboundChars: [...outbound].length, counts: { ...sealed.gateReport.counts }, gate: { passed: !sealed.gateReport.bypassed, checks: [...sealed.gateReport.checksPassed] },
    armor, latencyMs: { seal: Math.round(sealMs), network: Math.round(networkMs) }, prevHash, hash: "", outboundText: outbound,
  });
}

export interface LedgerStats {
  requests: number;
  sealedDetails: number;
  generalised: number;
  onDeviceAnswers: number;
  cloudAnswers: number;
  blocked: number;
  byCategory: Record<string, number>;
}

/**
 * The local append-only receipt chain (port of ReceiptLedger.swift). On-device answers (nothing left
 * the device) are counted but create no receipt. `onAppend` lets the store persist each receipt.
 */
export class ReceiptLedger {
  private readonly onDevice: Date[] = [];

  constructor(
    readonly receipts: Receipt[] = [],
    private readonly onAppend: (r: Receipt) => void | Promise<void> = () => {},
  ) {}

  async append(sealed: SealedText, threadId: string, route: Route, modelVersion: string, armor: Receipt["armor"], sealMs: number, networkMs: number, at = new Date()): Promise<Receipt> {
    const last = this.receipts.at(-1);
    const r = makeReceipt(sealed, (last?.seq ?? 0) + 1, last?.hash ?? GENESIS, threadId, route, modelVersion, armor, sealMs, networkMs, at);
    this.receipts.push(r);
    await this.onAppend(r);
    return r;
  }

  recordOnDeviceAnswer(at = new Date()): void {
    this.onDevice.push(at);
  }

  verify(): ChainVerification {
    return verifyChain(this.receipts);
  }

  stats(since: Date): LedgerStats {
    const iso = timestamp(since);
    const recent = this.receipts.filter((r) => r.createdAt >= iso);
    const byCategory: Record<string, number> = {};
    const cats = new Set<string>(ALL_CATEGORIES);
    for (const r of recent) for (const [k, v] of Object.entries(r.counts)) if (cats.has(k)) byCategory[k] = (byCategory[k] ?? 0) + v;
    const generalised = recent.reduce((a, r) => a + (r.counts["generalised"] ?? 0), 0);
    return {
      requests: recent.length, sealedDetails: Object.values(byCategory).reduce((a, b) => a + b, 0) + generalised, generalised,
      onDeviceAnswers: this.onDevice.filter((d) => d >= since).length + recent.filter((r) => r.modelVersion === CHROME_ON_DEVICE_MODEL).length,
      cloudAnswers: recent.filter((r) => r.modelVersion !== CHROME_ON_DEVICE_MODEL && r.armor !== "blocked").length,
      blocked: recent.filter((r) => r.armor === "blocked").length, byCategory,
    };
  }
}
