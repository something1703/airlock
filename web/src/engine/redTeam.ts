import { ANALYSIS_OPTIONS, type PhoneOnlyEngine } from "./engines";
import { contains, fold, isBoundary } from "./foldedSearch";
import { validateRewrite } from "./generaliser";
import { firstJsonObject } from "./llmDetector";
import type { PatternDetector } from "./patterns";
import type { PromptLibrary } from "./prompts";
import type { Replacement, SealDraft } from "./sealer";
import { type Confidence, type EntityMap, type RedTeamMode, type TextSpan, confidenceRank, spanContains, spansOverlap } from "./types";

export type RiskAttribute = "identity" | "location" | "employer" | "occupation" | "age" | "relationship" | "event";
const ATTRIBUTES = new Set<RiskAttribute>(["identity", "location", "employer", "occupation", "age", "relationship", "event"]);

/** One Risk card: "A reader could still guess …, because of …". */
export interface Risk {
  id: number;
  attribute: RiskAttribute;
  guess: string;
  /** The exact draft text that gives it away. */
  evidence: string;
  confidence: Confidence;
  /** A validated rewrite, or null (the card offers Keep / Edit only). */
  suggestion: string | null;
}

export interface RedTeamResult {
  risks: Risk[];
  applied: Risk[];
  draft: SealDraft;
  rounds: number;
  /** The check couldn't run (unavailable / refused / unparseable) — forces review. */
  unavailable: boolean;
}

export const MAX_RISKS_PER_ROUND = 6;
const TOKEN = /\[\[[A-Z]+_(?:[0-9]+|ME)\]\]/g;

function placeholderSpans(text: string): TextSpan[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}
const tokensIn = (text: string): string[] => [...text.matchAll(TOKEN)].map((m) => m[0]).sort();
const maskTokens = (text: string): string => text.replace(TOKEN, " ").split(/\s+/u).filter(Boolean).join(" ");
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Word-bounded occurrences: exact case first, then case-insensitive. */
export function locate(needle: string, text: string): TextSpan[] {
  const n = needle.trim();
  if (!n) return [];
  for (const hay of [text, text.toLowerCase()]) {
    if (hay.length !== text.length) continue;
    const nn = hay === text ? n : n.toLowerCase();
    const found: TextSpan[] = [];
    let from = 0;
    while (from < hay.length) {
      const i = hay.indexOf(nn, from);
      if (i < 0) break;
      const okStart = isBoundary(text, i - 1) || !isWordChar(n[0]);
      const okEnd = isBoundary(text, i + nn.length) || !isWordChar(n[n.length - 1]);
      if (okStart && okEnd) found.push({ start: i, end: i + nn.length });
      from = i + nn.length;
    }
    if (found.length) return found;
  }
  return [];
}

/** Generaliser rules on the non-placeholder text, plus exact placeholder preservation. */
export function isValidSuggestion(rewrite: string, evidence: string, entities: EntityMap, patterns: PatternDetector): boolean {
  if (tokensIn(rewrite).join() !== tokensIn(evidence).join()) return false;
  const r = maskTokens(rewrite).trim();
  if (!r) return false;
  return validateRewrite(r, maskTokens(evidence).trim(), entities, patterns);
}

/** Deterministic and idempotent; skips evidence it can't find (Review's "Use suggestion" calls it). */
export function applyRisks(risks: Risk[], draft: SealDraft): SealDraft {
  let text = draft.text;
  let replacements: Replacement[] = [...draft.replacements];
  const edits: { span: TextSpan; text: string }[] = [];
  for (const risk of risks) {
    if (risk.suggestion === null || contains(fold(risk.evidence), fold(risk.suggestion))) continue;
    const tokenSpans = placeholderSpans(text);
    const candidate = locate(risk.evidence, text).find(
      (span) => !edits.some((e) => spansOverlap(e.span, span)) && !tokenSpans.some((t) => spansOverlap(t, span) && !spanContains(span, t)),
    );
    if (candidate) edits.push({ span: candidate, text: risk.suggestion });
  }
  for (const edit of [...edits].sort((a, b) => b.span.start - a.span.start)) {
    text = text.slice(0, edit.span.start) + edit.text + text.slice(edit.span.end);
    const delta = edit.text.length - (edit.span.end - edit.span.start);
    replacements = replacements.flatMap((r): Replacement[] => {
      if (r.sealedSpan.end <= edit.span.start) return [r];
      if (r.sealedSpan.start >= edit.span.end) return [{ ...r, sealedSpan: { start: r.sealedSpan.start + delta, end: r.sealedSpan.end + delta } }];
      return [];
    });
    replacements.push({ normalisedSpan: { start: 0, end: 0 }, sealedSpan: { start: edit.span.start, end: edit.span.start + edit.text.length }, entityId: null, kind: "redteam" });
  }
  replacements.sort((a, b) => a.sealedSpan.start - b.sealedSpan.start || a.sealedSpan.end - b.sealedSpan.end);
  return { ...draft, text, replacements };
}

interface Guess {
  attribute: RiskAttribute;
  guess: string;
  evidence: string;
  confidence: Confidence;
}

/**
 * Stage 7 — the on-device red-team loop (port of RedTeam.swift). Phone-only; a guess is used only if its
 * evidence is in the draft; a suggestion is offered only if it passes validation and keeps exactly the
 * evidence's placeholders. ≤ 6 risks per round, ≤ 2 rounds.
 */
export class RedTeam {
  constructor(
    readonly phone: PhoneOnlyEngine,
    readonly prompts: PromptLibrary,
    readonly patterns: PatternDetector,
  ) {}

  async run(draft: SealDraft, mode: RedTeamMode, maxRounds: number, taskSummary: string): Promise<RedTeamResult> {
    if (mode === "off" || maxRounds <= 0) return { risks: [], applied: [], draft, rounds: 0, unavailable: false };
    let current = draft;
    const all: Risk[] = [];
    const applied: Risk[] = [];
    let rounds = 0;
    for (let round = 1; round <= Math.min(maxRounds, 2); round++) {
      rounds = round;
      const guesses = await this.attack(current);
      if (guesses === null) return { risks: all, applied, draft: current, rounds, unavailable: true };
      const risky = filterGuesses(guesses, current.text);
      if (risky.length === 0) break;
      const risks: Risk[] = [];
      for (const [i, g] of risky.entries()) {
        risks.push({ id: round * 100 + i, ...g, suggestion: await this.suggest(g, current, taskSummary) });
      }
      all.push(...risks);
      if (mode !== "autoApply") break;
      const good = risks.filter((r) => r.suggestion !== null);
      if (good.length === 0) break;
      current = applyRisks(good, current);
      applied.push(...good);
    }
    return { risks: all, applied, draft: current, rounds, unavailable: false };
  }

  private async attack(draft: SealDraft): Promise<Guess[] | null> {
    let output: string;
    try {
      output = (await this.phone.respond({ promptId: "attack.v1", text: this.prompts.render("attack.v1", { draft: draft.text }) }, ANALYSIS_OPTIONS)).text;
    } catch {
      return null;
    }
    const json = firstJsonObject(output);
    if (!json) return null;
    let obj: unknown;
    try {
      obj = JSON.parse(json);
    } catch {
      return null;
    }
    const list = (obj as { guesses?: unknown }).guesses;
    if (!Array.isArray(list)) return null;
    const out: Guess[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const d = raw as Record<string, unknown>;
      const attribute = typeof d.attribute === "string" ? (d.attribute.toLowerCase() as RiskAttribute) : null;
      if (!attribute || !ATTRIBUTES.has(attribute) || typeof d.evidence !== "string") continue;
      const conf = typeof d.confidence === "string" ? d.confidence.toLowerCase() : "low";
      out.push({ attribute, guess: typeof d.guess === "string" ? d.guess : "", evidence: d.evidence, confidence: conf === "high" || conf === "medium" ? conf : "low" });
    }
    return out;
  }

  private async suggest(g: Guess, draft: SealDraft, taskSummary: string): Promise<string | null> {
    const span = locate(g.evidence, draft.text)[0];
    if (!span) return null;
    const sentence = draft.text.slice(Math.max(0, span.start - 120), Math.min(draft.text.length, span.end + 120));
    try {
      const text = this.prompts.render("gen.v1", { task_summary: taskSummary, sentence, phrase: g.evidence, type: g.attribute, level_hint: "general, not unique to one person or place" });
      const output = (await this.phone.respond({ promptId: "gen.v1", text }, ANALYSIS_OPTIONS)).text;
      const json = firstJsonObject(output);
      if (!json) return null;
      const r = (JSON.parse(json) as { rewrite?: unknown }).rewrite;
      if (typeof r !== "string") return null;
      const rewrite = r.trim();
      return isValidSuggestion(rewrite, g.evidence, draft.entities, this.patterns) ? rewrite : null;
    } catch {
      return null;
    }
  }
}

/** Keeps medium+ guesses whose evidence really is in the draft (as written there), max 6. */
export function filterGuesses(guesses: Guess[], text: string): Guess[] {
  const seen = new Set<string>();
  const kept: Guess[] = [];
  for (const g of guesses) {
    if (confidenceRank(g.confidence) < confidenceRank("medium")) continue;
    if (!maskTokens(g.evidence).replace(/[\s\p{P}]/gu, "")) continue;
    const span = locate(g.evidence, text)[0];
    if (!span) continue;
    const asWritten = text.slice(span.start, span.end);
    if (seen.has(asWritten)) continue;
    seen.add(asWritten);
    kept.push({ ...g, evidence: asWritten });
  }
  return kept.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence)).slice(0, MAX_RISKS_PER_ROUND);
}
