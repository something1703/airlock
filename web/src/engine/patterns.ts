import { type Candidate, type Confidence, type PrivacyCategory, CATEGORY_PRIORITY, compareSpans, confidenceRank, spansOverlap, spanLength } from "./types";
import { named, type Validator } from "./validators";
import corePack from "./packs/core.json";
import nationalPack from "./packs/national.json";

export interface PatternContext {
  words: string[];
  before: number;
  after: number;
  required: boolean;
  subtype?: string;
  confidence?: Confidence;
}

export interface PatternRule {
  id: string;
  category: PrivacyCategory;
  subtype: string;
  confidence: Confidence;
  regex: string;
  caseInsensitive?: boolean;
  group?: number;
  validator?: string;
  shrink?: boolean;
  context?: PatternContext;
}

export interface PatternPack {
  id: string;
  description: string;
  rules: PatternRule[];
}

export const BUNDLED_PACKS: PatternPack[] = [corePack as PatternPack, nationalPack as PatternPack];

interface Compiled {
  rule: PatternRule;
  regex: RegExp;
  validator: Validator | undefined;
}

/** Characters trimmed from token edges before context matching (punctuation + symbols, but not '#'). */
function trimEdges(s: string): string {
  const cs = [...s];
  const strip = (c: string): boolean => c !== "#" && /[\p{P}\p{S}]/u.test(c);
  let a = 0;
  let b = cs.length;
  while (a < b && strip(cs[a]!)) a++;
  while (b > a && strip(cs[b - 1]!)) b--;
  return cs.slice(a, b).join("");
}

export function contextTokens(s: string): string[] {
  return s.toLowerCase().split(/\s+/u).map(trimEdges).filter((t) => t.length > 0);
}

/**
 * D2 — deterministic pattern detectors (port of PatternDetector.swift). Pure regex rules, so
 * results match the Swift/Android engines; Apple's NSDataDetector boost has no web equivalent.
 */
export class PatternDetector {
  private readonly rules: Compiled[];

  constructor(packs: PatternPack[] = BUNDLED_PACKS, disabled: ReadonlySet<string> = new Set()) {
    this.rules = [];
    for (const pack of packs) {
      if (disabled.has(pack.id)) continue;
      for (const rule of pack.rules) {
        let regex: RegExp;
        try {
          regex = new RegExp(rule.regex, "gud" + (rule.caseInsensitive ? "i" : ""));
        } catch {
          throw new Error(`bad regex in rule ${rule.id}`);
        }
        let validator: Validator | undefined;
        if (rule.validator) {
          validator = named(rule.validator);
          if (!validator) throw new Error(`unknown validator ${rule.validator} in rule ${rule.id}`);
        }
        this.rules.push({ rule, regex, validator });
      }
    }
  }

  detect(text: string): Candidate[] {
    const hits: Candidate[] = [];
    for (const { rule, regex, validator } of this.rules) {
      regex.lastIndex = 0;
      for (const m of text.matchAll(regex)) {
        const g = rule.group ?? 0;
        const range = (m as RegExpMatchArray & { indices?: ([number, number] | undefined)[] }).indices?.[g];
        if (!range) continue;
        let [start, end] = range;
        if (end <= start) continue;
        let value = text.slice(start, end);
        if (validator && !validator(value)) {
          const shrunk = rule.shrink ? shrinkToValid(value, validator) : null;
          if (shrunk === null) continue;
          value = shrunk;
          end = start + shrunk.length;
        }
        let subtype = rule.subtype;
        let confidence = rule.confidence;
        if (rule.context) {
          const present = contextPresent(rule.context, start, end, text);
          if (rule.context.required && !present) continue;
          if (present) {
            if (rule.context.subtype) subtype = rule.context.subtype;
            if (rule.context.confidence) confidence = rule.context.confidence;
          }
        }
        hits.push({ span: { start, end }, text: value, category: rule.category, subtype, detector: "pattern", confidence });
      }
    }
    return resolveOverlaps(hits);
  }
}

/** Longest span first, then category priority, then confidence, then position; keep non-overlapping. */
export function resolveOverlaps(hits: Candidate[]): Candidate[] {
  const ordered = [...hits].sort((a, b) => {
    if (spanLength(a.span) !== spanLength(b.span)) return spanLength(b.span) - spanLength(a.span);
    if (CATEGORY_PRIORITY[a.category] !== CATEGORY_PRIORITY[b.category]) return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    if (a.confidence !== b.confidence) return confidenceRank(b.confidence) - confidenceRank(a.confidence);
    return compareSpans(a.span, b.span);
  });
  const kept: Candidate[] = [];
  for (const h of ordered) if (!kept.some((k) => spansOverlap(k.span, h.span))) kept.push(h);
  return kept.sort((a, b) => compareSpans(a.span, b.span));
}

function shrinkToValid(value: string, validator: Validator): string | null {
  const parts = value.split(" ");
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join(" ");
    if (validator(candidate)) return candidate;
  }
  return null;
}

function contextPresent(ctx: PatternContext, start: number, end: number, text: string): boolean {
  const window = 160;
  const beforeText = text.slice(Math.max(0, start - window), start);
  const afterText = text.slice(end, end + window);
  const before = contextTokens(beforeText).slice(-ctx.before);
  const after = ctx.after > 0 ? contextTokens(afterText).slice(0, ctx.after) : [];
  const joined = " " + [...(ctx.before > 0 ? before : []), ...after].join(" ") + " ";
  return ctx.words.some((w) => joined.includes(" " + w + " "));
}
