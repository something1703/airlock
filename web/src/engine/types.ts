// Core types — a port of AirlockCore (Swift). Spans are UTF-16 code-unit offsets, exactly like
// Swift's NSRange and JavaScript string indices, so fixtures mean the same on every platform.

export type PrivacyCategory = "person" | "org" | "location" | "contact" | "id" | "date" | "health" | "secret" | "quasi";

export const ALL_CATEGORIES: readonly PrivacyCategory[] = ["person", "org", "location", "contact", "id", "date", "health", "secret", "quasi"];

/** Placeholder prefix (`PERSON` in `[[PERSON_1]]`); quasi has none. */
export const CATEGORY_PREFIX: Record<PrivacyCategory, string | null> = {
  person: "PERSON",
  org: "ORG",
  location: "LOC",
  contact: "CONTACT",
  id: "ID",
  date: "DATE",
  health: "HEALTH",
  secret: "SECRET",
  quasi: null,
};

/** Conflict priority: secret > id > contact > person > org > location > date > health > quasi (lower wins). */
export const CATEGORY_PRIORITY: Record<PrivacyCategory, number> = {
  secret: 0,
  id: 1,
  contact: 2,
  person: 3,
  org: 4,
  location: 5,
  date: 6,
  health: 7,
  quasi: 8,
};

export function categoryFromPrefix(prefix: string): PrivacyCategory | null {
  const up = prefix.toUpperCase();
  return ALL_CATEGORIES.find((c) => CATEGORY_PREFIX[c] === up) ?? null;
}

export type DetectorId = "user" | "vault" | "pattern" | "llm" | "nl" | "redteam";

/** Merge rule: vault > pattern > llm > nl (user outranks all; lower wins). */
export const DETECTOR_PRIORITY: Record<DetectorId, number> = { user: 0, vault: 1, pattern: 2, llm: 3, nl: 4, redteam: 5 };

export type Confidence = "low" | "medium" | "high";
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
export const confidenceRank = (c: Confidence): number => CONFIDENCE_RANK[c];
export const maxConfidence = (a: Confidence, b: Confidence): Confidence => (CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b);

/** Half-open range [start, end) in UTF-16 code units. */
export interface TextSpan {
  start: number;
  end: number;
}
export const spanLength = (s: TextSpan): number => s.end - s.start;
export const spansOverlap = (a: TextSpan, b: TextSpan): boolean => a.start < b.end && b.start < a.end;
export const spanContains = (outer: TextSpan, inner: TextSpan): boolean => outer.start <= inner.start && inner.end <= outer.end;
export const spanEquals = (a: TextSpan, b: TextSpan): boolean => a.start === b.start && a.end === b.end;
export const compareSpans = (a: TextSpan, b: TextSpan): number => (a.start !== b.start ? a.start - b.start : a.end - b.end);
export const substringOf = (text: string, s: TextSpan): string | null => (s.start >= 0 && s.end <= text.length && s.start <= s.end ? text.slice(s.start, s.end) : null);

/** One raw detection before merging. `text` is exactly the UTF-16 substring at `span`. */
export interface Candidate {
  span: TextSpan;
  text: string;
  category: PrivacyCategory;
  subtype?: string | null;
  detector: DetectorId;
  confidence: Confidence;
  roleHint?: string | null;
  sameAs?: string | null;
  vaultEntryId?: string | null;
}

// MARK: Placeholder ids — canonical strings: "PERSON_1", "ORG_2", "PERSON_ME".

export type PlaceholderId = string;
export const ME: PlaceholderId = "PERSON_ME";

export interface ParsedId {
  category: PrivacyCategory;
  /** 1-based number, or "ME" (person only). */
  index: number | "ME";
}

/** Accepts the canonical grammar only (case-insensitive prefix); `ME` only for PERSON; no leading zeros. */
export function parsePlaceholderId(s: string): ParsedId | null {
  const cut = s.indexOf("_");
  if (cut <= 0 || cut === s.length - 1) return null;
  const prefix = s.slice(0, cut);
  const rest = s.slice(cut + 1);
  const category = categoryFromPrefix(prefix);
  if (!category || CATEGORY_PREFIX[category] === null) return null;
  if (rest.toUpperCase() === "ME") return category === "person" ? { category, index: "ME" } : null;
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  return { category, index: Number(rest) };
}

export function makeId(category: PrivacyCategory, n: number): PlaceholderId {
  const prefix = CATEGORY_PREFIX[category];
  if (prefix === null || n < 1) throw new Error("invalid placeholder");
  return `${prefix}_${n}`;
}

export const idToken = (id: PlaceholderId): string => `[[${id}]]`;
export const isMe = (id: PlaceholderId): boolean => id === ME;
export function idCategory(id: PlaceholderId): PrivacyCategory {
  const p = parsePlaceholderId(id);
  if (!p) throw new Error("invalid placeholder id");
  return p.category;
}

/** category priority, then ME first, then number. */
export function compareIds(a: PlaceholderId, b: PlaceholderId): number {
  const pa = parsePlaceholderId(a);
  const pb = parsePlaceholderId(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  if (pa.category !== pb.category) return CATEGORY_PRIORITY[pa.category] - CATEGORY_PRIORITY[pb.category];
  if (pa.index === "ME") return pb.index === "ME" ? 0 : -1;
  if (pb.index === "ME") return 1;
  return pa.index - pb.index;
}

// MARK: Actions

export type Action = { kind: "placeholder" } | { kind: "keep" } | { kind: "block" } | { kind: "generalise"; level: number };
export const PLACEHOLDER: Action = { kind: "placeholder" };
export const KEEP: Action = { kind: "keep" };
export const BLOCK: Action = { kind: "block" };
export const generalise = (level: number): Action => ({ kind: "generalise", level });
export const mustNotEgress = (a: Action): boolean => a.kind !== "keep";

/** "generalise:2" etc. — the string form used by the shared fixtures. */
export function actionString(a: Action): string {
  return a.kind === "generalise" ? `generalise:${a.level}` : a.kind;
}
export function parseAction(s: string): Action {
  if (s.startsWith("generalise:")) return generalise(Number(s.slice("generalise:".length)));
  if (s === "keep") return KEEP;
  if (s === "block") return BLOCK;
  return PLACEHOLDER;
}

// MARK: Entities

export interface Entity {
  id: PlaceholderId;
  category: PrivacyCategory;
  canonical: string;
  surfaceForms: Set<string>;
  roleHint?: string | null;
  action: Action;
  generalisedText?: string | null;
  sources: Set<DetectorId>;
  confidence: Confidence;
  subtype?: string | null;
  /** The Vault entry this came from, if any — such entities can only be revealed explicitly. */
  vaultEntryId?: string | null;
}

export function makeEntity(e: Partial<Entity> & Pick<Entity, "id" | "category" | "canonical" | "sources" | "confidence">): Entity {
  return {
    action: PLACEHOLDER,
    ...e,
    surfaceForms: new Set([...(e.surfaceForms ?? []), e.canonical]),
  };
}

/** Placeholder → entity for one thread. Lives only on device, encrypted at rest (INV-6). */
export class EntityMap {
  private readonly map = new Map<PlaceholderId, Entity>();

  constructor(entities: Iterable<Entity> = []) {
    for (const e of entities) this.map.set(e.id, e);
  }

  get(id: PlaceholderId): Entity | undefined {
    return this.map.get(id);
  }
  has(id: PlaceholderId): boolean {
    return this.map.has(id);
  }
  upsert(e: Entity): void {
    this.map.set(e.id, e);
  }
  get size(): number {
    return this.map.size;
  }
  keys(): PlaceholderId[] {
    return [...this.map.keys()];
  }
  /** Entities sorted by placeholder id. */
  sorted(): Entity[] {
    return [...this.map.values()].sort((a, b) => compareIds(a.id, b.id));
  }
  /** Independent copy (entities are cloned so edits never alias the original). */
  clone(): EntityMap {
    return new EntityMap([...this.map.values()].map((e) => ({ ...e, surfaceForms: new Set(e.surfaceForms), sources: new Set(e.sources) })));
  }
  /** Next unused number for a category (`PERSON_ME` doesn't consume one). */
  nextId(category: PrivacyCategory): PlaceholderId {
    let max = 0;
    for (const id of this.map.keys()) {
      const p = parsePlaceholderId(id);
      if (p && p.category === category && p.index !== "ME") max = Math.max(max, p.index);
    }
    return makeId(category, max + 1);
  }
}

// MARK: Dial

export type DialPreset = "open" | "balanced" | "strict";
export type RedTeamMode = "off" | "suggest" | "autoApply";
export type ReviewMode = "onlyIfRisk" | "ifLowConfidenceOrRisk" | "always";

// MARK: Routes

export type Route = "phoneOnly" | "phoneFirst" | "cloudFirst" | "cloudOnly";
/** Matching Firebase AI Logic `InferenceMode` names (web + Android SDKs). */
export const INFERENCE_MODE: Record<Route, string> = {
  phoneOnly: "ONLY_ON_DEVICE",
  phoneFirst: "PREFER_ON_DEVICE",
  cloudFirst: "PREFER_IN_CLOUD",
  cloudOnly: "ONLY_IN_CLOUD",
};

// MARK: Sealed text

export interface LegendLine {
  placeholder: PlaceholderId;
  description: string;
}
export const renderLegendLine = (l: LegendLine): string => `${idToken(l.placeholder)} — ${l.description}`;

export type GateCheckId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";
export const ALL_GATE_CHECKS: readonly GateCheckId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"];

export interface GateReport {
  checksPassed: GateCheckId[];
  counts: Record<string, number>;
  /** Lowercase hex SHA-256 of the exact outbound text (value + "\n\n" + rendered legend). */
  outboundSha256: string;
  bypassed: boolean;
}

declare const sealedBrand: unique symbol;

/**
 * Text that has passed the egress gate — the only input type cloud engines accept (INV-1, INV-2).
 * The brand is a `unique symbol` that only `sealedInternal.ts` can attach; `tests/sealed.test.ts`
 * scans the source and fails if any other file imports it.
 */
export interface SealedText {
  readonly [sealedBrand]: true;
  readonly value: string;
  readonly legend: readonly LegendLine[];
  readonly gateReport: GateReport;
}

/** Legend as sent: one rendered line per placeholder. */
export const renderedLegend = (s: Pick<SealedText, "legend">): string => s.legend.map(renderLegendLine).join("\n");
