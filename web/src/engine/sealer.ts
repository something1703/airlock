import { contains, fold } from "./foldedSearch";
import { ladderDefault, validateRewrite } from "./generaliser";
import type { MergeResult } from "./merger";
import { findMoney } from "./money";
import type { NormalisedText } from "./normaliser";
import type { PatternDetector } from "./patterns";
import type { PolicyEngine, UserOverride } from "./policy";
import { type Entity, type EntityMap, type LegendLine, type PlaceholderId, type PrivacyCategory, type TextSpan, compareIds, idToken, isMe, spansOverlap } from "./types";

export type ReplacementKind = "placeholder" | "generalised" | "blocked" | "bucketed" | "redteam";

/** One change the sealer made. */
export interface Replacement {
  /** Where the original text was, in the normalised input. */
  normalisedSpan: TextSpan;
  /** Where the replacement sits in the draft. */
  sealedSpan: TextSpan;
  entityId: PlaceholderId | null;
  kind: ReplacementKind;
}

/** A sealed draft, before the egress gate. Lives only on device. */
export interface SealDraft {
  text: string;
  legend: LegendLine[];
  replacements: Replacement[];
  /** Entities with their final actions and generalised phrases. */
  entities: EntityMap;
  /** Secrets that were removed — the UI warns "Never share these". */
  secretWarnings: PlaceholderId[];
  /** Vault entries the user chose to reveal this time (gate check G1 skips these). */
  revealedVaultIds: ReadonlySet<string>;
  /** Folded values the user explicitly chose to keep (gate check G3 allows these). */
  keptValues: ReadonlySet<string>;
}

const GENERIC: Record<PrivacyCategory, string> = {
  person: "a person mentioned in the message",
  org: "an organisation mentioned in the message",
  location: "a place mentioned in the message",
  contact: "contact details",
  id: "an ID or reference number",
  date: "a date",
  health: "a health detail",
  secret: "a secret the user should not share",
  quasi: "a detail",
};

/** "the writer's landlord" → "the user's landlord"; "my landlord" → "the user's landlord"; "me" → "the user". */
export function rewriteRole(raw: string): string {
  let s = raw.replace(/^[\s.]+|[\s.]+$/g, "");
  const lower = s.toLowerCase();
  if (["me", "myself", "self", "the writer", "writer", "i", "the user"].includes(lower)) return "the user";
  for (const [prefix, replacement] of [["the writer's ", "the user's "], ["the writer’s ", "the user's "], ["writer's ", "the user's "], ["my ", "the user's "]] as const) {
    if (lower.startsWith(prefix)) return replacement + s.slice(prefix.length);
  }
  s = s.replace(/the writer/gi, "the user");
  const articles = ["the ", "a ", "an ", "someone", "their "];
  if (!articles.some((a) => s.toLowerCase().startsWith(a))) s = "the user's " + s;
  return s;
}

/**
 * Stage 6 — build the sealed draft and its legend (port of Sealer.swift).
 * Every mention whose entity isn't `keep` is replaced (placeholder/block → `[[ID]]`, generalise → a
 * validated phrase); Strict also buckets money. The legend has one line per placeholder present, sorted
 * by id; `PERSON_ME` is "the user"; legend lines never contain surface forms or pattern hits.
 */
export class Sealer {
  constructor(
    readonly policy: PolicyEngine,
    readonly patterns: PatternDetector,
    readonly today: Date = new Date(),
  ) {}

  draft(
    text: NormalisedText,
    mergeResult: MergeResult,
    overrides: ReadonlyMap<PlaceholderId, UserOverride> = new Map(),
    rewrites: ReadonlyMap<PlaceholderId, string> = new Map(),
  ): SealDraft {
    const map = mergeResult.entities.clone();
    const present = new Set(mergeResult.mentions.map((m) => m.entityId));
    const revealed = new Set<string>();
    const kept = new Set<string>();

    for (const id of present) {
      const e = map.get(id);
      if (!e) continue;
      const override = overrides.get(id);
      e.action = this.policy.action(e, override);
      if (e.action.kind === "generalise") {
        const r = rewrites.get(id);
        e.generalisedText = r !== undefined && validateRewrite(r, e.canonical, map, this.patterns) ? r : ladderDefault(e, e.action.level, this.today);
      }
      if (e.action.kind === "keep" && override) {
        for (const f of e.surfaceForms) kept.add(fold(f));
        if (e.vaultEntryId != null && override.revealThisTime) revealed.add(e.vaultEntryId);
      }
      map.upsert(e);
    }

    interface Edit { span: TextSpan; replacement: string; id: PlaceholderId | null; kind: ReplacementKind }
    const edits: Edit[] = [];
    for (const m of mergeResult.mentions) {
      const e = map.get(m.entityId);
      if (!e) continue;
      switch (e.action.kind) {
        case "keep": break;
        case "placeholder": edits.push({ span: m.span, replacement: idToken(e.id), id: e.id, kind: "placeholder" }); break;
        case "block": edits.push({ span: m.span, replacement: idToken(e.id), id: e.id, kind: "blocked" }); break;
        case "generalise": edits.push({ span: m.span, replacement: e.generalisedText ?? "something", id: e.id, kind: "generalised" }); break;
      }
    }
    if (this.policy.bucketsMoney) {
      for (const hit of findMoney(text.text)) {
        if (!edits.some((e) => spansOverlap(e.span, hit.span))) edits.push({ span: hit.span, replacement: hit.bucket, id: null, kind: "bucketed" });
      }
    }
    edits.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);

    let out = "";
    let cursor = 0;
    const replacements: Replacement[] = [];
    for (const edit of edits) {
      if (edit.span.start < cursor) continue;
      out += text.text.slice(cursor, edit.span.start);
      const start = out.length;
      out += edit.replacement;
      replacements.push({ normalisedSpan: edit.span, sealedSpan: { start, end: out.length }, entityId: edit.id, kind: edit.kind });
      cursor = edit.span.end;
    }
    out += text.text.slice(cursor);

    const placeholderIds = [...new Set(replacements.filter((r) => (r.kind === "placeholder" || r.kind === "blocked") && r.entityId).map((r) => r.entityId!))].sort(compareIds);
    const legend: LegendLine[] = [];
    for (const id of placeholderIds) {
      const e = map.get(id);
      if (e) legend.push({ placeholder: id, description: this.legendDescription(e, map) });
    }
    const secretWarnings = placeholderIds.filter((id) => map.get(id)?.action.kind === "block");
    return { text: out, legend, replacements, entities: map, secretWarnings, revealedVaultIds: revealed, keptValues: kept };
  }

  legendDescription(e: Entity, map: EntityMap): string {
    if (isMe(e.id)) return "the user";
    if (e.category === "secret") return "a secret the user should not share";
    if (e.roleHint) {
      const hint = rewriteRole(e.roleHint);
      if (this.passesMiniGate(hint, map)) return hint;
    }
    return GENERIC[e.category];
  }

  /** A role hint is only used if it names nobody and matches no pattern. */
  passesMiniGate(hint: string, map: EntityMap): boolean {
    if (hint.length === 0 || hint.split(/\s+/u).length > 12 || hint.includes("[[")) return false;
    for (const e of map.sorted()) {
      for (const form of e.surfaceForms) if (form.length >= 2 && contains(form, hint)) return false;
    }
    return !this.patterns.detect(hint).some((c) => c.category !== "date");
  }
}

