// Shared harness for the red-team regression suite (docs/12-REVIEW.md, docs/13-FIX-PLAN.md FX-00).
// Drives the real SealPipeline + EgressGate with mock models; no network.
import { AppConfig } from "../src/core/appConfig";
import {
  EgressGate, EntityMap, GateBlocked, MockPhoneEngine, PatternDetector, PromptLibrary, SealPipeline, renderedLegend, sealSettings,
  type SealResult, type SealedText, type VaultEntry,
} from "../src/engine";

export const patterns = new PatternDetector();
export const prompts = new PromptLibrary();

export interface ModelItem { text: string; type: string; role?: string; same_as?: string; confidence?: string }

export interface SealOptions {
  vault?: VaultEntry[];
  dial?: "open" | "balanced" | "strict";
  /** `null` = on-device model unavailable (rules only). Otherwise what the mock detector returns. */
  items?: ModelItem[] | null;
  attack?: string;
  rewrite?: string;
  existing?: EntityMap;
}

export interface Sealed {
  sealed: SealedText | null;
  /** Sealed text + legend exactly as it would leave, or "" if the gate blocked. */
  outbound: string;
  blocked: boolean;
  res: SealResult;
  reasons: string[];
}

export async function seal(raw: string, o: SealOptions = {}): Promise<Sealed> {
  const vault = o.vault ?? [];
  const detect = JSON.stringify({ items: o.items ?? [] });
  const phone = new MockPhoneEngine(
    (id) => (id === "gen.v1" ? JSON.stringify({ rewrite: o.rewrite ?? "a general thing" }) : id === "attack.v1" ? (o.attack ?? '{"guesses":[]}') : detect),
    o.items === null ? "unavailable" : "available",
  );
  const pipeline = new SealPipeline(phone, patterns, vault, prompts, sealSettings(new AppConfig(), { dial: o.dial ?? "balanced", today: new Date("2026-11-20T00:00:00Z") }));
  const res = await pipeline.run(raw, o.existing ?? new EntityMap());
  let sealed: SealedText | null = null;
  let blocked = false;
  try {
    sealed = new EgressGate(patterns, vault).seal(res.draft);
  } catch (e) {
    if (!(e instanceof GateBlocked)) throw e;
    blocked = true;
  }
  const outbound = sealed ? (sealed.legend.length ? `${sealed.value}\n\n${renderedLegend(sealed)}` : sealed.value) : "";
  return { sealed, outbound, blocked, res, reasons: res.reasons.map((r) => r.kind), requiresReview: res.requiresReview } as Sealed;
}

/** Safe = the gate blocked, or none of the needles is in what would leave. */
export function leaks(r: Sealed, needles: readonly string[]): string[] {
  if (r.blocked) return [];
  return needles.filter((n) => r.outbound.includes(n));
}

export const vaultEntry = (id: string, canonical: string, aliases: string[] = [], category: VaultEntry["category"] = "person", isUser = false, roleHint: string | null = null): VaultEntry =>
  ({ id, canonical, aliases, category, isUser, roleHint });
