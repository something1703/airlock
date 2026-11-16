import { sha256Hex } from "./sha256";
import type { Route } from "./types";

/** A tamper-evident record of one thing that left the device (no raw or restored text — INV-7). */
export interface Receipt {
  id: string;
  seq: number;
  /** ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z`. */
  createdAt: string;
  threadId: string;
  route: Route;
  modelVersion: string;
  outboundSha256: string;
  outboundChars: number;
  counts: Record<string, number>;
  gate: { passed: boolean; checks: string[] };
  armor: "pass" | "blocked" | "notConfigured" | "unknown";
  latencyMs: Record<string, number>;
  prevHash: string;
  hash: string;
  /** The exact sealed text that left (local only; excluded from the hash). */
  outboundText?: string;
}

export const GENESIS = "0".repeat(64);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Canonical JSON for hashing — byte-identical to Swift's `CanonicalJSON` and Python
 * `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`: keys sorted by UTF-16
 * code unit, no whitespace, minimal string escaping, integers only.
 */
export function canonicalJson(v: Json): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("canonical JSON allows integers only");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k]!)).join(",") + "}";
}

/** The hashed fields: everything except `hash` and `outboundText`. */
export function hashedFields(r: Receipt): Json {
  return {
    armor: r.armor, counts: r.counts, createdAt: r.createdAt, gate: { checks: r.gate.checks, passed: r.gate.passed }, id: r.id,
    latencyMs: r.latencyMs, modelVersion: r.modelVersion, outboundChars: r.outboundChars, outboundSha256: r.outboundSha256,
    prevHash: r.prevHash, route: r.route, seq: r.seq, threadId: r.threadId,
  };
}

export const computeHash = (r: Receipt): string => sha256Hex(r.prevHash + canonicalJson(hashedFields(r)));
export const sealReceipt = (r: Receipt): Receipt => ({ ...r, hash: computeHash(r) });

export type ChainVerification =
  | { valid: true; count: number }
  | { valid: false; index: number; seq: number; reason: "hashMismatch" | "prevHashMismatch" | "seqGap" | "genesisMismatch" };

/** Verifies receipts in chain order (ascending `seq`). */
export function verifyChain(receipts: readonly Receipt[]): ChainVerification {
  let expectedPrev = GENESIS;
  let expectedSeq: number | undefined;
  for (const [index, r] of receipts.entries()) {
    if (index === 0 && r.prevHash !== GENESIS) return { valid: false, index, seq: r.seq, reason: "genesisMismatch" };
    if (expectedSeq !== undefined && r.seq !== expectedSeq) return { valid: false, index, seq: r.seq, reason: "seqGap" };
    if (r.prevHash !== expectedPrev) return { valid: false, index, seq: r.seq, reason: "prevHashMismatch" };
    if (computeHash(r) !== r.hash) return { valid: false, index, seq: r.seq, reason: "hashMismatch" };
    expectedPrev = r.hash;
    expectedSeq = r.seq + 1;
  }
  return { valid: true, count: receipts.length };
}
