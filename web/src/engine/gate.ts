import { fold, ranges } from "./foldedSearch";
import { mixedScriptWords, skeleton } from "./homoglyphs";
import { isNormalised } from "./normaliser";
import type { PatternDetector } from "./patterns";
import { PlaceholderParser } from "./restore";
import type { Replacement, SealDraft } from "./sealer";
import { __createSealedText } from "./sealedInternal";
import { sha256Hex } from "./sha256";
import { entityTerms, type Term } from "./terms";
import { type Candidate, type EntityMap, type GateCheckId, type LegendLine, type PrivacyCategory, type SealedText, type TextSpan, ALL_GATE_CHECKS, mustNotEgress, renderLegendLine } from "./types";
import { ADDRESS_SUBTYPES } from "./policy";
import { allTerms, type VaultEntry } from "./vault";

export interface GateLimits {
  /** Max UTF-16 length of text + legend (matches the Firestore `looksSealed` rule). */
  maxUtf16: number;
}
export const DEFAULT_LIMITS: GateLimits = { maxUtf16: 40_000 };

/** Where to highlight. Carries **no** matched values (INV-8). */
export interface GateHit {
  check: GateCheckId;
  category: PrivacyCategory | null;
  /** Span in the draft text, or in the legend line's description when `legendIndex` is set. */
  span: TextSpan | null;
  legendIndex: number | null;
}

/** Thrown when any check fails. The message names checks only — never content. */
export class GateBlocked extends Error {
  constructor(readonly hits: readonly GateHit[]) {
    super(`Egress gate blocked: ${[...new Set(hits.map((h) => h.check))].sort().join(", ")}`);
    this.name = "GateBlocked";
  }
  get checks(): Set<GateCheckId> {
    return new Set(this.hits.map((h) => h.check));
  }
}

const outboundOf = (text: string, legend: readonly LegendLine[]): string => (legend.length === 0 ? text : text + "\n\n" + legend.map(renderLegendLine).join("\n"));

/** Canonical placeholder tokens replaced by spaces of equal length, so term/pattern searches never match inside our own tokens. */
function maskPlaceholders(text: string): string {
  return text.replace(/\[\[[A-Z]+_(?:[0-9]+|ME)\]\]/g, (m) => " ".repeat(m.length));
}

function blocksPattern(c: Candidate): boolean {
  switch (c.category) {
    case "contact": case "id": case "secret": return true;
    case "location": return c.subtype != null && ADDRESS_SUBTYPES.has(c.subtype);
    default: return false;
  }
}

/**
 * Stage 9 — the egress gate (port of EgressGate.swift). **The only constructor of `SealedText`** (INV-2).
 * Deterministic; all of G1–G7 must pass or nothing is produced:
 * G6 normal form + no mixed-script words · G1 no Vault name/alias (unless revealed) · G2 no entity surface
 * form, partial name or distinctive word · G3 no contact/ID/secret/address pattern (unless kept) ·
 * G4 every placeholder canonical and explained · G5 legend lines clean · G7 size. G1/G2/G5 also run on
 * the homoglyph skeleton. The same checks run on tool results (INV-5).
 */
export class EgressGate {
  constructor(
    readonly patterns: PatternDetector,
    readonly vault: readonly VaultEntry[],
    readonly limits: GateLimits = DEFAULT_LIMITS,
    /** Pass `import.meta.env.DEV` — lets a DEBUG build skip checks to demo Model Armor. Never true in production. */
    readonly allowDebugBypass = false,
  ) {}

  seal(draft: SealDraft): SealedText {
    const hits = this.check(draft.text, draft.legend, draft.entities, draft.revealedVaultIds, draft.keptValues, true);
    if (hits.length > 0) throw new GateBlocked(hits);
    return this.make(draft.text, draft.legend, draft.replacements, false);
  }

  /** Seals a tool result before it goes back to the cloud model (INV-5). Placeholders must belong to the thread. */
  sealToolResult(text: string, entities: EntityMap): SealedText {
    const hits = this.check(text, [], entities, new Set(), new Set(), false);
    if (hits.length > 0) throw new GateBlocked(hits);
    return this.make(text, [], [], false);
  }

  /** DEBUG only: skips every check; the report says `bypassed: true` and the UI shows a red banner. */
  sealBypassingChecks(draft: SealDraft): SealedText {
    if (!this.allowDebugBypass) throw new Error("gate bypass is disabled outside DEBUG builds");
    return this.make(draft.text, draft.legend, draft.replacements, true);
  }

  private check(text: string, legend: readonly LegendLine[], entities: EntityMap, revealed: ReadonlySet<string>, kept: ReadonlySet<string>, requireLegend: boolean): GateHit[] {
    const hits: GateHit[] = [];
    const descriptions = legend.map((l) => l.description);
    const hit = (check: GateCheckId, category: PrivacyCategory | null, span: TextSpan | null, legendIndex: number | null): void => {
      hits.push({ check, category, span, legendIndex });
    };

    // G6 — normal form and mixed scripts.
    if (!isNormalised(text)) hit("G6", null, null, null);
    for (const w of mixedScriptWords(text)) hit("G6", null, { start: w.start, end: w.end }, null);
    descriptions.forEach((d, i) => {
      if (!isNormalised(d) || mixedScriptWords(d).length > 0) hit("G6", null, null, i);
    });

    const terms = this.protectedTerms(entities, revealed);
    const masked = maskPlaceholders(text);

    // G1 / G2 — on the text and its homoglyph skeleton.
    for (const h of termHits(masked, terms, null)) hits.push(h);

    // G3 — patterns.
    for (const p of this.patterns.detect(masked)) {
      if (blocksPattern(p) && !kept.has(fold(p.text))) hit("G3", p.category, p.span, null);
    }

    // G4 — placeholders canonical and explained.
    const legendIds = new Set(legend.map((l) => l.placeholder));
    const known = new Set([...legendIds, ...entities.keys()]);
    const tokens = new PlaceholderParser(known).tokens(text);
    for (const t of tokens) {
      const explained = requireLegend ? legendIds.has(t.id) : entities.has(t.id);
      if (!t.isCanonical || !explained) hit("G4", null, t.span, null);
    }
    if (requireLegend) {
      const used = new Set(tokens.map((t) => t.id));
      legend.forEach((l, i) => {
        if (!used.has(l.placeholder)) hit("G4", null, null, i);
      });
    }

    // G5 — legend lines.
    descriptions.forEach((d, i) => {
      for (const h of termHits(d, terms, i)) hit("G5", h.category, h.span, i);
      if (d.includes("[[") || this.patterns.detect(d).some((c) => c.category !== "date")) hit("G5", null, null, i);
    });

    // G7 — size.
    if (outboundOf(text, legend).length > this.limits.maxUtf16) hit("G7", null, null, null);
    return hits;
  }

  private protectedTerms(entities: EntityMap, revealed: ReadonlySet<string>): Term[] {
    const terms: Term[] = [];
    for (const entry of this.vault) {
      if (revealed.has(entry.id)) continue;
      for (const t of allTerms(entry)) if (t.length >= 2) terms.push({ text: t, check: "G1", category: entry.category, caseSensitive: false });
    }
    for (const e of entities.sorted()) {
      if (!mustNotEgress(e.action)) continue;
      if (e.vaultEntryId != null && revealed.has(e.vaultEntryId)) continue;
      terms.push(...entityTerms(e));
    }
    return terms;
  }

  private make(text: string, legend: readonly LegendLine[], replacements: readonly Replacement[], bypassed: boolean): SealedText {
    const counts: Record<string, number> = {};
    for (const l of legend) {
      const cat = categoryOfId(l.placeholder);
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    counts["generalised"] = new Set(replacements.filter((r) => r.kind === "generalised" && r.entityId).map((r) => r.entityId)).size;
    counts["bucketed"] = replacements.filter((r) => r.kind === "bucketed").length;
    counts["redteamApplied"] = replacements.filter((r) => r.kind === "redteam").length;
    return __createSealedText(text, legend, {
      checksPassed: bypassed ? [] : [...ALL_GATE_CHECKS],
      counts,
      outboundSha256: sha256Hex(outboundOf(text, legend)),
      bypassed,
    });
  }
}

function categoryOfId(id: string): string {
  const prefix = id.split("_")[0] ?? "";
  const map: Record<string, string> = { PERSON: "person", ORG: "org", LOC: "location", CONTACT: "contact", ID: "id", DATE: "date", HEALTH: "health", SECRET: "secret" };
  return map[prefix] ?? "person";
}

/** Hits of every term on the text and (if different) its homoglyph skeleton; a span is reported once. */
function termHits(text: string, terms: readonly Term[], legendIndex: number | null): GateHit[] {
  const sk = skeleton(text);
  const haystacks = sk === text ? [text] : [text, sk];
  const hits: GateHit[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    for (const hay of haystacks) {
      for (const span of ranges(term.text, hay, term.caseSensitive)) {
        const k = `${span.start}:${span.end}`;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push({ check: term.check, category: term.category, span, legendIndex });
      }
    }
  }
  return hits;
}

