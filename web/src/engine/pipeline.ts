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
import { CallMeter, emptyTimings, type SealTimings } from "./timing";
import { ANALYSIS_OPTIONS } from "./engines";
import { type Candidate, type DialPreset, type Entity, type PlaceholderId, type PrivacyCategory, type ReviewMode, EntityMap, PLACEHOLDER, confidenceRank, compareIds } from "./types";
import { VaultMatcher, type VaultEntry } from "./vault";
import { ranges } from "./foldedSearch";

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

export type SealProgress =
  | { kind: "rulesReady"; preview: RulesPreview }
  | { kind: "detecting"; section: number; of: number } | { kind: "generalising" } | { kind: "checkingRisks" } | { kind: "done" };

/** FX-02: what the Vault and the rules found, before any model call — shown at once on the sealing screen (local only). */
export interface RulesPreview {
  /** The normalised text the spans point into. */
  text: string;
  /** Non-overlapping, in order; the longest wins where two overlap. */
  spans: { start: number; end: number; category: PrivacyCategory }[];
  /** Distinct details (same text, any case, counted once). */
  count: number;
}

export function rulesPreview(text: string, candidates: readonly Candidate[]): RulesPreview {
  const sorted = [...candidates].sort((a, b) => a.span.start - b.span.start || (b.span.end - b.span.start) - (a.span.end - a.span.start));
  const spans: RulesPreview["spans"] = [];
  for (const c of sorted) {
    const last = spans[spans.length - 1];
    if (last && c.span.start < last.end) {
      if (c.span.end - c.span.start > last.end - last.start) spans[spans.length - 1] = { start: c.span.start, end: c.span.end, category: c.category };
      continue;
    }
    spans.push({ start: c.span.start, end: c.span.end, category: c.category });
  }
  const count = new Set(spans.map((x) => text.slice(x.start, x.end).toLowerCase())).size;
  return { text, spans, count };
}

export interface SealResult {
  normalised: NormalisedText;
  merge: MergeResult;
  draft: SealDraft;
  reasons: ReviewReason[];
  requiresReview: boolean;
  detection: LLMDetectionReport;
  rewrites: Map<PlaceholderId, string>;
  sealMs: number;
  /** Where the seal's time went (FX-02); numbers only. */
  timings: SealTimings;
  risks: Risk[];
  acceptedRisks: Risk[];
  redTeamUnavailable: boolean;
  /** Web staged mode: the red-team check is still running; sending must wait. */
  redTeamPending?: boolean;
  /** Every detection before merging (kept so the user can add their own and re-merge). */
  candidates: Candidate[];
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

  private async prepare(raw: string, existing: EntityMap, overrides: Map<PlaceholderId, UserOverride>, progress: (p: SealProgress) => void, staged: boolean): Promise<{ result: SealResult; later: Promise<SealResult> | null }> {
    const t0 = performance.now();
    const meter = new CallMeter(this.phone, t0);
    const timings = emptyTimings();
    const normalised = normalise(raw.slice(0, MAX_INPUT_UTF16));
    const text = normalised.text;
    const candidates = [...new VaultMatcher(this.vault).detect(text), ...this.patterns.detect(text)];
    const tRules = performance.now();
    timings.rulesMs = tRules - t0;
    progress({ kind: "rulesReady", preview: rulesPreview(text, candidates) });
    const report = await new LLMDetector(meter, this.prompts, this.settings.chunkTokens).detect(text, (section, of) => progress({ kind: "detecting", section, of }));
    timings.detectMs = performance.now() - tRules;
    timings.detectCalls = meter.calls("detect");
    timings.repairCalls = meter.calls("detect-repair");
    candidates.push(...report.candidates);

    const m = merge(candidates, text, existing, this.vault);
    const policy = new PolicyEngine(this.settings.dial, this.settings.policy);

    const rewrites = new Map<PlaceholderId, string>();
    if (report.unavailable === null) {
      const ids = [...new Set(m.mentions.map((x) => x.entityId))].sort(compareIds);
      const targets = ids.map((id) => m.entities.get(id)).filter((e): e is Entity => !!e && policy.action(e, overrides.get(e.id)).kind === "generalise").slice(0, this.settings.maxRewrites);
      if (targets.length) progress({ kind: "generalising" });
      const tGen = performance.now();
      const callsBefore = meter.calls();
      for (const e of targets) {
        const action = policy.action(e, overrides.get(e.id));
        const mention = m.mentions.find((x) => x.entityId === e.id);
        if (action.kind !== "generalise" || !mention) continue;
        const r = await this.rewrite(meter, e, mention, action.level, text);
        if (r) rewrites.set(e.id, r);
      }
      timings.generaliseMs = performance.now() - tGen;
      timings.generaliseCalls = meter.calls() - callsBefore;
    }

    let draft = new Sealer(policy, this.patterns, this.settings.today).draft(normalised, m, overrides, rewrites);
    let risks: Risk[] = [];
    let accepted: Risk[] = [];
    let redTeamUnavailable = false;
    let later: Promise<SealResult> | null = null;
    const base = (): SealResult => {
      const sealMs = performance.now() - t0;
      return { normalised, merge: m, draft, reasons: [], requiresReview: false, detection: report, rewrites, sealMs, timings: { ...timings, firstModelOutputMs: meter.firstModelOutputMs, totalMs: sealMs }, risks, acceptedRisks: accepted, redTeamUnavailable, candidates };
    };
    if (this.settings.redTeamEnabled && policy.redTeamMode !== "off") {
      if (report.unavailable !== null) redTeamUnavailable = true;
      else if (staged && policy.redTeamMode === "suggest") {
        // Suggestions don't change the draft, so the user can start reviewing now; risk cards arrive later.
        const early = { ...base(), redTeamPending: true };
        progress({ kind: "checkingRisks" });
        const tRed = performance.now();
        const callsBefore = meter.calls();
        later = new RedTeam(meter, this.prompts, this.patterns).run(draft, "suggest", this.settings.redTeamRounds, this.settings.taskSummary)
          .then((rt) => finalise({
            ...early, redTeamPending: false, risks: rt.risks, redTeamUnavailable: rt.unavailable, sealMs: performance.now() - t0,
            timings: { ...early.timings, redTeamMs: performance.now() - tRed, redTeamCalls: meter.calls() - callsBefore },
          }, policy.reviewMode));
        return { result: finalise(early, policy.reviewMode), later };
      } else {
        progress({ kind: "checkingRisks" });
        const tRed = performance.now();
        const callsBefore = meter.calls();
        const rt = await new RedTeam(meter, this.prompts, this.patterns).run(draft, policy.redTeamMode, this.settings.redTeamRounds, this.settings.taskSummary);
        timings.redTeamMs = performance.now() - tRed;
        timings.redTeamCalls = meter.calls() - callsBefore;
        ({ risks, applied: accepted, draft } = rt);
        redTeamUnavailable = rt.unavailable;
      }
    }
    const result = finalise(base(), policy.reviewMode);
    progress({ kind: "done" });
    return { result, later };
  }

  async run(raw: string, existing = new EntityMap(), overrides = new Map<PlaceholderId, UserOverride>(), progress: (p: SealProgress) => void = () => {}): Promise<SealResult> {
    return (await this.prepare(raw, existing, overrides, progress, false)).result;
  }

  /**
   * Like `run`, but when the red-team only *suggests* (Balanced), returns the draft as soon as it is sealed
   * (`redTeamPending: true`) and the full result — with risk cards — via `later`. Strict still waits, because
   * there the red-team rewrites the draft itself. Nothing may be sent while `redTeamPending` is true.
   */
  runStaged(raw: string, existing = new EntityMap(), overrides = new Map<PlaceholderId, UserOverride>(), progress: (p: SealProgress) => void = () => {}): Promise<{ result: SealResult; later: Promise<SealResult> | null }> {
    return this.prepare(raw, existing, overrides, progress, true);
  }

  /**
   * "Protect this": the user marks a phrase the detectors missed (essential when the on-device model is
   * unavailable — INV-9). Every word-bounded occurrence becomes a `user` detection (highest merge priority),
   * then we re-merge with the current entities as `existing`, so every placeholder keeps its number and the
   * user's earlier toggles still point at the same details. No model call.
   */
  protect(result: SealResult, phrase: string, category: Exclude<PrivacyCategory, "quasi">, overrides: Map<PlaceholderId, UserOverride>, acceptedRisks: Risk[] = result.acceptedRisks): { result: SealResult; overrides: Map<PlaceholderId, UserOverride> } {
    const text = result.normalised.text;
    const needle = phrase.trim();
    const spans = needle ? ranges(needle, text) : [];
    if (!spans.length) return { result, overrides };
    const added: Candidate[] = spans.map((span) => ({ span, text: text.slice(span.start, span.end), category, detector: "user", confidence: "high" }));
    const candidates = [...result.candidates, ...added];
    const m = merge(candidates, text, result.merge.entities.clone(), this.vault);
    // What the user marked becomes a placeholder (restorable in the answer), not a generalisation.
    const next = new Map(overrides);
    for (const mention of m.mentions) {
      if (added.some((a) => a.span.start === mention.span.start && a.span.end === mention.span.end) && !next.has(mention.entityId)) {
        next.set(mention.entityId, { action: PLACEHOLDER, revealThisTime: false });
      }
    }
    return { result: this.reseal({ ...result, merge: m, candidates }, next, acceptedRisks), overrides: next };
  }

  /** Re-applies Review edits without calling the model (chip toggles and "Use suggestion" are instant). */
  reseal(result: SealResult, overrides: Map<PlaceholderId, UserOverride>, acceptedRisks: Risk[] = result.acceptedRisks): SealResult {
    const policy = new PolicyEngine(this.settings.dial, this.settings.policy);
    const base = new Sealer(policy, this.patterns, this.settings.today).draft(result.normalised, result.merge, overrides, result.rewrites);
    return finalise({ ...result, draft: applyRisks(acceptedRisks, base), acceptedRisks }, policy.reviewMode);
  }

  private async rewrite(phone: PhoneOnlyEngine, e: Entity, mention: Mention, level: number, text: string): Promise<string | null> {
    const sentence = text.slice(Math.max(0, mention.span.start - 120), Math.min(text.length, mention.span.end + 120));
    const hint = level === 1 ? "slightly less specific" : level === 2 ? 'a general kind, no name (e.g. "a large hospital")' : 'very general (e.g. "a healthcare employer")';
    try {
      const prompt = this.prompts.render("gen.v1", { task_summary: this.settings.taskSummary, sentence, phrase: mention.text, type: e.category, level_hint: hint });
      const out = (await phone.respond({ promptId: "gen.v1", text: prompt }, ANALYSIS_OPTIONS)).text;
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
