import type { AppConfig } from "../core/appConfig";
import type { PhoneAvailability, PhoneOnlyEngine } from "./engines";
import { firstJsonObject, LLMDetector, type LLMDetectionReport } from "./llmDetector";
import { merge, type Mention, type MergeResult } from "./merger";
import { normalise, MAX_INPUT_UTF16, type NormalisedText } from "./normaliser";
import type { PatternDetector } from "./patterns";
import { PolicyEngine, DEFAULT_POLICY_SETTINGS, type PolicySettings, type UserOverride } from "./policy";
import type { PromptLibrary } from "./prompts";
import { applyRisks, RedTeam, type Risk } from "./redTeam";
import { Sealer, type SealDraft } from "./sealer";
import { ANALYSIS_OPTIONS } from "./engines";
import { type DialPreset, type Entity, type PlaceholderId, type ReviewMode, EntityMap, confidenceRank, compareIds } from "./types";
import { VaultMatcher, type VaultEntry } from "./vault";

export interface SealSettings {
  dial: DialPreset;
  policy: PolicySettings;
  chunkTokens: number;
  maxRewrites: number;
  taskSummary: string;
  today: Date;
  redTeamEnabled: boolean;
  redTeamRounds: number;
}

export function sealSettings(config: AppConfig, overrides: Partial<SealSettings> = {}): SealSettings {
  return {
    dial: config.dialDefault, policy: DEFAULT_POLICY_SETTINGS, chunkTokens: config.detectChunkTokens, maxRewrites: 6,
    taskSummary: "getting help with this message", today: new Date(), redTeamEnabled: config.redTeamEnabled, redTeamRounds: config.redTeamRounds,
    ...overrides,
  };
}

export type ReviewReason =
  | { kind: "phoneUnavailable"; availability: PhoneAvailability }
  | { kind: "llmFailed"; chunks: number[] }
  | { kind: "refused"; chunks: number[] }
  | { kind: "lowConfidence" }
  | { kind: "ambiguous" }
  | { kind: "secretsFound" }
  | { kind: "risks"; count: number }
  | { kind: "redTeamUnavailable" };

export type SealProgress = { kind: "detecting"; section: number; of: number } | { kind: "generalising" } | { kind: "checkingRisks" } | { kind: "done" };

export interface SealResult {
  normalised: NormalisedText;
  merge: MergeResult;
  draft: SealDraft;
  reasons: ReviewReason[];
  requiresReview: boolean;
  detection: LLMDetectionReport;
  rewrites: Map<PlaceholderId, string>;
  sealMs: number;
  risks: Risk[];
  acceptedRisks: Risk[];
  redTeamUnavailable: boolean;
}

export const pendingRisks = (r: Pick<SealResult, "risks" | "acceptedRisks">): Risk[] => {
  const accepted = new Set(r.acceptedRisks.map((x) => x.id));
  return r.risks.filter((x) => !accepted.has(x.id));
};

/**
 * Stages 1–7: raw text → sealed draft, entirely on the device (port of SealPipeline.swift).
 * Holds only a PhoneOnlyEngine, so there is no cloud engine to call (INV-1, INV-3). INV-9: if the
 * on-device model is unavailable or fails, detection falls back to Vault + patterns and Review is forced.
 * The draft must still pass `EgressGate.seal` before anything leaves.
 */
export class SealPipeline {
  constructor(
    private readonly phone: PhoneOnlyEngine,
    private readonly patterns: PatternDetector,
    private readonly vault: readonly VaultEntry[],
    private readonly prompts: PromptLibrary,
    private readonly settings: SealSettings,
  ) {}

  async run(raw: string, existing = new EntityMap(), overrides = new Map<PlaceholderId, UserOverride>(), progress: (p: SealProgress) => void = () => {}): Promise<SealResult> {
    const t0 = performance.now();
    const normalised = normalise(raw.slice(0, MAX_INPUT_UTF16));
    const text = normalised.text;
    const candidates = [...new VaultMatcher(this.vault).detect(text), ...this.patterns.detect(text)];
    const report = await new LLMDetector(this.phone, this.prompts, this.settings.chunkTokens).detect(text, (section, of) => progress({ kind: "detecting", section, of }));
    candidates.push(...report.candidates);

    const m = merge(candidates, text, existing, this.vault);
    const policy = new PolicyEngine(this.settings.dial, this.settings.policy);

    const rewrites = new Map<PlaceholderId, string>();
    if (report.unavailable === null) {
      const ids = [...new Set(m.mentions.map((x) => x.entityId))].sort(compareIds);
      const targets = ids.map((id) => m.entities.get(id)).filter((e): e is Entity => !!e && policy.action(e, overrides.get(e.id)).kind === "generalise").slice(0, this.settings.maxRewrites);
      if (targets.length) progress({ kind: "generalising" });
      for (const e of targets) {
        const action = policy.action(e, overrides.get(e.id));
        const mention = m.mentions.find((x) => x.entityId === e.id);
        if (action.kind !== "generalise" || !mention) continue;
        const r = await this.rewrite(e, mention, action.level, text);
        if (r) rewrites.set(e.id, r);
      }
    }

    let draft = new Sealer(policy, this.patterns, this.settings.today).draft(normalised, m, overrides, rewrites);
    let risks: Risk[] = [];
    let accepted: Risk[] = [];
    let redTeamUnavailable = false;
    if (this.settings.redTeamEnabled && policy.redTeamMode !== "off") {
      if (report.unavailable === null) {
        progress({ kind: "checkingRisks" });
        const rt = await new RedTeam(this.phone, this.prompts, this.patterns).run(draft, policy.redTeamMode, this.settings.redTeamRounds, this.settings.taskSummary);
        ({ risks, applied: accepted, draft } = rt);
        redTeamUnavailable = rt.unavailable;
      } else redTeamUnavailable = true;
    }
    const result = finalise(
      { normalised, merge: m, draft, reasons: [], requiresReview: false, detection: report, rewrites, sealMs: performance.now() - t0, risks, acceptedRisks: accepted, redTeamUnavailable },
      policy.reviewMode,
    );
    progress({ kind: "done" });
    return result;
  }

  /** Re-applies Review edits without calling the model (chip toggles and "Use suggestion" are instant). */
  reseal(result: SealResult, overrides: Map<PlaceholderId, UserOverride>, acceptedRisks: Risk[] = result.acceptedRisks): SealResult {
    const policy = new PolicyEngine(this.settings.dial, this.settings.policy);
    const base = new Sealer(policy, this.patterns, this.settings.today).draft(result.normalised, result.merge, overrides, result.rewrites);
    return finalise({ ...result, draft: applyRisks(acceptedRisks, base), acceptedRisks }, policy.reviewMode);
  }

  private async rewrite(e: Entity, mention: Mention, level: number, text: string): Promise<string | null> {
    const sentence = text.slice(Math.max(0, mention.span.start - 120), Math.min(text.length, mention.span.end + 120));
    const hint = level === 1 ? "slightly less specific" : level === 2 ? 'a general kind, no name (e.g. "a large hospital")' : 'very general (e.g. "a healthcare employer")';
    try {
      const prompt = this.prompts.render("gen.v1", { task_summary: this.settings.taskSummary, sentence, phrase: mention.text, type: e.category, level_hint: hint });
      const out = (await this.phone.respond({ promptId: "gen.v1", text: prompt }, ANALYSIS_OPTIONS)).text;
      const json = firstJsonObject(out);
      const r = json ? (JSON.parse(json) as { rewrite?: unknown }).rewrite : undefined;
      return typeof r === "string" ? r.trim() : null;
    } catch {
      return null;
    }
  }
}

function finalise(r: SealResult, mode: ReviewMode): SealResult {
  const reasons: ReviewReason[] = [];
  if (r.detection.unavailable !== null) reasons.push({ kind: "phoneUnavailable", availability: r.detection.unavailable });
  if (r.detection.failedChunks.length) reasons.push({ kind: "llmFailed", chunks: r.detection.failedChunks });
  if (r.detection.refusedChunks.length) reasons.push({ kind: "refused", chunks: r.detection.refusedChunks });
  const present = new Set(r.merge.mentions.map((x) => x.entityId));
  const lowConfidenceSealed = [...present].some((id) => {
    const e = r.draft.entities.get(id);
    return !!e && e.action.kind !== "keep" && confidenceRank(e.confidence) < confidenceRank("high");
  });
  if (lowConfidenceSealed) reasons.push({ kind: "lowConfidence" });
  if (r.merge.ambiguous.length) reasons.push({ kind: "ambiguous" });
  if (r.draft.secretWarnings.length) reasons.push({ kind: "secretsFound" });
  const pending = pendingRisks(r);
  if (pending.length) reasons.push({ kind: "risks", count: pending.length });
  if (r.redTeamUnavailable && r.detection.unavailable === null) reasons.push({ kind: "redTeamUnavailable" });
  const forced = reasons.some((x) => x.kind !== "lowConfidence");
  const requiresReview = mode === "always" ? true : mode === "ifLowConfidenceOrRisk" ? forced || reasons.some((x) => x.kind === "lowConfidence") : forced;
  return { ...r, reasons, requiresReview };
}
