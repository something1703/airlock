// Pure stats logic for aggregateStats (mirrors web/src/engine/ledger.ts `stats`). No I/O.

/** Receipt as synced to Firestore (no outboundText). Only the fields stats need. */
export interface SyncedReceipt {
  id: string;
  createdAt: string;
  modelVersion: string;
  armor: string;
  counts: Record<string, number>;
}

export const CATEGORIES = ["person", "org", "location", "contact", "id", "date", "health", "secret", "quasi"] as const;

/** Model versions that mean "answered on this device" (web Chrome Nano, Android Nano, Apple FM). */
export const ON_DEVICE_MODELS = new Set(["chrome-gemini-nano", "gemini-nano-on-device", "ondevice", "apple-foundation-models"]);

/** ISO-8601 week id of a timestamp, e.g. "2026-W47" (weeks start Monday; week 1 contains Jan 4th). */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error("bad timestamp");
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface StatsDelta {
  requests: number;
  sealedDetails: number;
  generalised: number;
  onDeviceAnswers: number;
  cloudAnswers: number;
  blocked: number;
  byCategory: Record<string, number>;
}

/** What one receipt adds to its week. Unknown or negative counts are ignored. */
export function deltaFor(r: SyncedReceipt): StatsDelta {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const byCategory: Record<string, number> = {};
  for (const c of CATEGORIES) {
    const v = n(r.counts?.[c]);
    if (v) byCategory[c] = v;
  }
  const generalised = n(r.counts?.["generalised"]);
  const onDevice = ON_DEVICE_MODELS.has(r.modelVersion);
  const blocked = r.armor === "blocked";
  return {
    requests: 1,
    sealedDetails: Object.values(byCategory).reduce((a, b) => a + b, 0) + generalised,
    generalised,
    onDeviceAnswers: onDevice ? 1 : 0,
    cloudAnswers: !onDevice && !blocked ? 1 : 0,
    blocked: blocked ? 1 : 0,
    byCategory,
  };
}
