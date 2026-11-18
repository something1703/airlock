// F-25 "What could Gemini still guess?" — the sealed text the cloud already received is sent again (cloudOnly)
// with `infer.v1`, and the model lists what it can infer about the writer. Shows the user, in the cloud model's
// own words, what sealing does NOT hide (their situation), so they can choose to protect more next time.
//
// Only SealedText reaches the engine (INV-1); a receipt is written because a request left the device.
import { renderedLegend, type Confidence, type SealedText } from "./types";
import type { EngineProvider, TaskSpec } from "./engines";
import { firstJsonObject } from "./llmDetector";
import type { PromptLibrary } from "./prompts";
import type { ReceiptLedger } from "./ledger";
import type { Receipt } from "./hashchain";

export interface Inference {
  attribute: string;
  value: string;
  confidence: Confidence;
  /** The words in the sealed text that suggest it. */
  evidence: string;
}

export interface InferResult {
  inferences: Inference[];
  modelVersion: string;
  receipt: Receipt;
  /** The model's reply could not be read as the expected JSON. */
  unreadable: boolean;
}

const TOKEN = /\[\[[A-Z]+_(?:\d+|ME)\]\]/;
const MAX = 8;

/**
 * The task instruction is the versioned `infer.v1` prompt (docs/04-PROMPTS.md §8) minus its quoted-message
 * block: the cloud user turn (`cloud-user.v1`) already carries the sealed text and its legend.
 */
export function inferTask(prompts: PromptLibrary): TaskSpec {
  const full = prompts.render("infer.v1", { sealed_text: "" });
  const close = full.lastIndexOf(">>>");
  const instruction = (close >= 0 ? full.slice(close + 3) : full).trim();
  return { id: "infer.v1", instruction, maxOutputTokens: 700 };
}

/** Lenient parse: JSON anywhere in the reply; drops malformed items and any value that names a placeholder's person. */
export function parseInferences(text: string): { inferences: Inference[]; unreadable: boolean } {
  const json = firstJsonObject(text);
  if (!json) return { inferences: [], unreadable: true };
  let raw: unknown;
  try {
    raw = (JSON.parse(json) as { inferences?: unknown }).inferences;
  } catch {
    return { inferences: [], unreadable: true };
  }
  if (!Array.isArray(raw)) return { inferences: [], unreadable: true };
  const out: Inference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const attribute = typeof r.attribute === "string" ? r.attribute.trim() : "";
    const value = typeof r.value === "string" ? r.value.trim() : "";
    if (!attribute || !value || attribute.length > 40 || value.length > 160) continue;
    const c = typeof r.confidence === "string" ? r.confidence.toLowerCase() : "";
    const confidence: Confidence = c === "high" || c === "medium" || c === "low" ? c : "low";
    const evidence = typeof r.evidence === "string" ? r.evidence.trim().slice(0, 200) : "";
    // The prompt forbids guessing names; a value that is just a placeholder adds nothing.
    if (TOKEN.test(value) && value.replace(TOKEN, "").trim().length === 0) continue;
    out.push({ attribute, value, confidence, evidence });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  out.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return { inferences: out.slice(0, MAX), unreadable: false };
}

export async function inferWhatCloudCanGuess(args: {
  engines: EngineProvider;
  prompts: PromptLibrary;
  ledger: ReceiptLedger;
  sealed: SealedText;
  threadId: string;
  armorExpected?: boolean;
}): Promise<InferResult> {
  const t0 = performance.now();
  const res = await args.engines.sealed("cloudOnly", "auto").respond(args.sealed, inferTask(args.prompts));
  const receipt = await args.ledger.append(args.sealed, args.threadId, "cloudOnly", res.modelVersion, args.armorExpected ? "pass" : "notConfigured", 0, performance.now() - t0);
  return { ...parseInferences(res.text), modelVersion: res.modelVersion, receipt };
}

/** For tests and UI copy: the exact text that leaves (same as the original request). */
export const outboundOf = (s: SealedText): string => (s.legend.length ? `${s.value}\n\n${renderedLegend(s)}` : s.value);
