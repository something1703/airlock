import { fold } from "./foldedSearch";
import {
  type Candidate, type Confidence, type DetectorId, type PlaceholderId, type PrivacyCategory, type TextSpan, ME, CATEGORY_PRIORITY,
  DETECTOR_PRIORITY, EntityMap, PLACEHOLDER, compareSpans, confidenceRank, makeEntity, maxConfidence, spanContains, spanEquals, spanLength,
  spansOverlap, substringOf,
} from "./types";
import { allTerms, type VaultEntry } from "./vault";

export interface Mention {
  span: TextSpan;
  entityId: PlaceholderId;
  text: string;
}
/** Two entities the merger couldn't tell apart ("Sam" vs "Sam Lee" / "Sam Ortiz"). */
export interface Ambiguity {
  entity: PlaceholderId;
  possiblySameAs: PlaceholderId;
}
export interface MergeResult {
  entities: EntityMap;
  mentions: Mention[];
  ambiguous: Ambiguity[];
}

interface Accepted {
  span: TextSpan;
  text: string;
  category: PrivacyCategory;
  subtype: string | null;
  detector: DetectorId;
  confidence: Confidence;
  roleHint: string | null;
  sameAs: string | null;
  vaultEntryId: string | null;
  extraForms: Set<string>;
}

interface Cluster {
  category: PrivacyCategory;
  keys: Set<string>;
  tokens: Set<string>;
  mentions: Accepted[];
  vaultEntryId: string | null;
  ambiguousWith: number[];
}

const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "miss", "prof", "sir", "madam", "dame"]);
const NAME_CATEGORIES = new Set<PrivacyCategory>(["person", "org"]);

/**
 * Stage 4 — merge overlapping detections and cluster mentions into entities (port of Merger.swift).
 * Higher-priority detector wins an overlap (user > vault > pattern > llm > nl), then the longer span,
 * then the category order. A losing span that contains a single same-category winner makes the winner
 * grow (so "Raj" inside "Raj Patel" seals the whole name); every loser's text becomes a surface form.
 */
export function merge(candidates: Candidate[], text: string, existing: EntityMap = new EntityMap(), vault: readonly VaultEntry[] = []): MergeResult {
  const accepted = resolveOverlaps(candidates.filter((c) => c.category !== "quasi"), text);
  return assignIds(cluster(accepted, vault), existing, vault);
}

/** Pattern categories that are one identifier as a whole: a name inside an email address is part of the address. */
const ATOMIC_PATTERN = new Set<PrivacyCategory>(["contact", "id", "secret"]);

/**
 * Drops any candidate of a different category that lies strictly inside a contact / ID / secret pattern hit.
 * Without this, a Vault name inside the user's own email ("maya" in maya.chen@example.net) outranks the email
 * pattern and the draft becomes `[[PERSON_ME]].chen@…`, which the gate then blocks (found by AirlockBench).
 */
export function dropInsideAtomicPatterns(candidates: readonly Candidate[]): Candidate[] {
  const atoms = candidates.filter((c) => c.detector === "pattern" && ATOMIC_PATTERN.has(c.category));
  return candidates.filter((c) => !atoms.some((a) => a !== c && a.category !== c.category && spanContains(a.span, c.span) && !spanEquals(a.span, c.span)));
}

function resolveOverlaps(input: Candidate[], text: string): Accepted[] {
  const candidates = dropInsideAtomicPatterns(input);
  const ordered = [...candidates].sort((a, b) => {
    if (DETECTOR_PRIORITY[a.detector] !== DETECTOR_PRIORITY[b.detector]) return DETECTOR_PRIORITY[a.detector] - DETECTOR_PRIORITY[b.detector];
    if (spanLength(a.span) !== spanLength(b.span)) return spanLength(b.span) - spanLength(a.span);
    if (CATEGORY_PRIORITY[a.category] !== CATEGORY_PRIORITY[b.category]) return CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category];
    return compareSpans(a.span, b.span);
  });
  const kept: Accepted[] = [];
  for (const c of ordered) {
    const overlapping = kept.map((k, i) => (spansOverlap(k.span, c.span) ? i : -1)).filter((i) => i >= 0);
    if (overlapping.length === 0) {
      kept.push({
        span: c.span, text: c.text, category: c.category, subtype: c.subtype ?? null, detector: c.detector, confidence: c.confidence,
        roleHint: c.roleHint ?? null, sameAs: c.sameAs ?? null, vaultEntryId: c.vaultEntryId ?? null, extraForms: new Set(),
      });
      continue;
    }
    const only = overlapping.length === 1 ? kept[overlapping[0]!] : undefined;
    if (only && only.category === c.category && spanContains(c.span, only.span) && !spanEquals(c.span, only.span)) {
      const grown = substringOf(text, c.span);
      if (grown !== null) {
        only.extraForms.add(only.text);
        only.extraForms.add(c.text);
        only.span = c.span;
        only.text = grown;
        only.confidence = maxConfidence(only.confidence, c.confidence);
        continue;
      }
    }
    const same = overlapping.find((i) => kept[i]!.category === c.category);
    if (same !== undefined) kept[same]!.extraForms.add(c.text);
  }
  return kept.sort((a, b) => compareSpans(a.span, b.span));
}

function stripPossessive(s: string): string {
  for (const suffix of ["'s", "’s"]) if (s.endsWith(suffix) && [...s].length > 3) return s.slice(0, -2);
  return s;
}

/** Comparison key: folded, possessive and titles stripped; IDs and phones compare without separators. */
function key(text: string, category: PrivacyCategory): string {
  let s = fold(text).replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
  for (const suffix of ["'s", "s'"]) {
    if (s.endsWith(suffix) && [...s].length > suffix.length + 1) {
      s = s.slice(0, suffix === "'s" ? -2 : -1);
    }
  }
  switch (category) {
    case "person":
    case "org":
    case "location":
    case "health":
    case "quasi": {
      const words = s.split(/\s+/u).filter((w) => w.length > 0).map((w) => w.replace(/^[.,]+|[.,]+$/g, ""));
      if (category === "person") while (words.length > 1 && TITLES.has(words[0]!)) words.shift();
      return words.join(" ");
    }
    case "id":
    case "contact":
    case "secret":
      if (s.includes("@") || s.includes("/")) return s;
      return [...s].filter((c) => !/\s/u.test(c) && !"-().".includes(c)).join("");
    case "date":
      return s;
  }
}

const tokensOf = (k: string): Set<string> => new Set(k.split(" ").filter((t) => [...t].length >= 2 && !TITLES.has(t)));
const isSubset = <T>(a: Set<T>, b: Set<T>): boolean => [...a].every((x) => b.has(x));

function cluster(accepted: Accepted[], vault: readonly VaultEntry[]): Cluster[] {
  const clusters: Cluster[] = [];
  const order = accepted.map((_, i) => i).sort((x, y) => {
    const a = tokensOf(key(accepted[x]!.text, accepted[x]!.category)).size;
    const b = tokensOf(key(accepted[y]!.text, accepted[y]!.category)).size;
    return a !== b ? b - a : compareSpans(accepted[x]!.span, accepted[y]!.span);
  });
  for (const i of order) {
    const m = accepted[i]!;
    const k = key(m.text, m.category);
    const t = tokensOf(k);

    if (m.vaultEntryId) {
      const c = clusters.find((cl) => cl.vaultEntryId === m.vaultEntryId);
      if (c) {
        c.mentions.push(m);
        c.keys.add(k);
      } else {
        const keys = new Set([k]);
        const toks = new Set(t);
        const entry = vault.find((v) => v.id === m.vaultEntryId);
        if (entry) {
          for (const term of allTerms(entry)) {
            const tk = key(term, m.category);
            keys.add(tk);
            for (const x of tokensOf(tk)) toks.add(x);
          }
        }
        clusters.push({ category: m.category, keys, tokens: toks, mentions: [m], vaultEntryId: m.vaultEntryId, ambiguousWith: [] });
      }
      continue;
    }
    const exact = clusters.find((cl) => cl.category === m.category && cl.keys.has(k));
    if (exact) {
      exact.mentions.push(m);
      continue;
    }
    if (m.sameAs) {
      const sk = key(m.sameAs, m.category);
      const c = clusters.find((cl) => cl.category === m.category && cl.keys.has(sk));
      if (c) {
        c.mentions.push(m);
        c.keys.add(k);
        for (const x of t) c.tokens.add(x);
        continue;
      }
    }
    if (NAME_CATEGORIES.has(m.category) && t.size > 0) {
      const supersets = clusters.map((cl, ci) => (cl.category === m.category && isSubset(t, cl.tokens) ? ci : -1)).filter((ci) => ci >= 0);
      if (supersets.length === 1) {
        const c = clusters[supersets[0]!]!;
        c.mentions.push(m);
        c.keys.add(k);
        continue;
      }
      if (supersets.length > 1) {
        clusters.push({ category: m.category, keys: new Set([k]), tokens: t, mentions: [{ ...m, confidence: "medium" }], vaultEntryId: null, ambiguousWith: supersets });
        continue;
      }
    }
    clusters.push({ category: m.category, keys: new Set([k]), tokens: t, mentions: [m], vaultEntryId: null, ambiguousWith: [] });
  }
  return clusters;
}

function assignIds(clusters: Cluster[], existing: EntityMap, vault: readonly VaultEntry[]): MergeResult {
  const map = existing.clone();
  const mentions: Mention[] = [];
  const idByCluster = new Map<number, PlaceholderId>();
  const firstStart = (c: Cluster): number => Math.min(...c.mentions.map((m) => m.span.start));
  const order = clusters.map((_, i) => i).sort((a, b) => firstStart(clusters[a]!) - firstStart(clusters[b]!));

  for (const ci of order) {
    const c = clusters[ci]!;
    const entry = c.vaultEntryId ? vault.find((v) => v.id === c.vaultEntryId) : undefined;
    let forms = new Set<string>();
    for (const m of c.mentions) {
      forms.add(m.text);
      forms.add(stripPossessive(m.text));
      for (const x of m.extraForms) forms.add(x);
    }
    if (entry) for (const t of allTerms(entry)) forms.add(t);
    forms = new Set([...forms].filter((f) => f.trim().length > 0));

    let canonical = entry?.canonical;
    if (canonical === undefined) {
      let best: string | undefined;
      let bestTokens = -1;
      for (const raw of c.mentions.map((m) => stripPossessive(m.text))) {
        const n = tokensOf(key(raw, c.category)).size;
        if (best === undefined || n > bestTokens || (n === bestTokens && [...raw].length > [...best].length)) {
          best = raw;
          bestTokens = n;
        }
      }
      canonical = best ?? "";
    }
    let best: Accepted | undefined;
    for (const m of c.mentions) if (!best || DETECTOR_PRIORITY[m.detector] < DETECTOR_PRIORITY[best.detector]) best = m;
    const role: string | null = entry ? (entry.isUser ? "the user" : (entry.roleHint ?? null)) : (c.mentions.map((m) => m.roleHint).find((r) => r) ?? null);
    const confidence: Confidence = c.ambiguousWith.length === 0 ? c.mentions.map((m) => m.confidence).reduce((a, b) => (confidenceRank(a) >= confidenceRank(b) ? a : b)) : "medium";

    const foldedForms = new Set([...forms].map((f) => key(f, c.category)));
    const reuse = map.sorted().find(
      (e) =>
        e.category === c.category &&
        ((e.vaultEntryId != null && e.vaultEntryId === c.vaultEntryId) || [...e.surfaceForms].some((f) => foldedForms.has(key(f, c.category)))),
    );
    let id: PlaceholderId;
    if (reuse) {
      id = reuse.id;
      for (const f of forms) reuse.surfaceForms.add(f);
      for (const m of c.mentions) reuse.sources.add(m.detector);
      reuse.confidence = maxConfidence(reuse.confidence, confidence);
      if (reuse.roleHint == null) reuse.roleHint = role;
      map.upsert(reuse);
    } else {
      id = entry?.isUser ? ME : map.nextId(c.category);
      map.upsert(
        makeEntity({
          id, category: c.category, canonical, surfaceForms: forms, roleHint: role, action: PLACEHOLDER, sources: new Set(c.mentions.map((m) => m.detector)),
          confidence, subtype: best?.subtype ?? null, vaultEntryId: c.vaultEntryId,
        }),
      );
    }
    idByCluster.set(ci, id);
    for (const m of c.mentions) mentions.push({ span: m.span, entityId: id, text: m.text });
  }

  const ambiguous: Ambiguity[] = [];
  clusters.forEach((c, ci) => {
    const id = idByCluster.get(ci);
    if (!id) return;
    for (const other of c.ambiguousWith) {
      const o = idByCluster.get(other);
      if (o) ambiguous.push({ entity: id, possiblySameAs: o });
    }
  });
  mentions.sort((a, b) => compareSpans(a.span, b.span));
  return { entities: map, mentions, ambiguous };
}
