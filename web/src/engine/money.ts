import type { TextSpan } from "./types";

export interface MoneyHit {
  span: TextSpan;
  bucket: string;
}

/** Strict-dial money bucketing: "$1,240" → "$1,000–1,500". Only amounts with a currency symbol. */
const MONEY = /(?<![\w.])([$€£₹])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?!\d|,\d)/gu;

export function findMoney(text: string): MoneyHit[] {
  const hits: MoneyHit[] = [];
  for (const m of text.matchAll(MONEY)) {
    const value = Number((m[2] ?? "").replaceAll(",", ""));
    if (!Number.isFinite(value)) continue;
    hits.push({ span: { start: m.index!, end: m.index! + m[0].length }, bucket: bucket(value, m[1] ?? "$") });
  }
  return hits;
}

/** Half-magnitude buckets: 1,240 → 1,000–1,500; 85 → 85–90; 7 → under 10. */
export function bucket(value: number, symbol: string): string {
  if (value < 10) return `under ${symbol}10`;
  const magnitude = 10 ** (String(value).length - 1);
  const step = Math.max(1, Math.floor(magnitude / 2));
  const low = Math.floor(value / step) * step;
  const fmt = (n: number): string => n.toLocaleString("en-US");
  return `${symbol}${fmt(low)}–${fmt(low + step)}`;
}
