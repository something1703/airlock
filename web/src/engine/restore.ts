import { contains, fold } from "./foldedSearch";
import { type Entity, type EntityMap, type PlaceholderId, type TextSpan, CATEGORY_PREFIX, idToken, isMe, mustNotEgress, parsePlaceholderId } from "./types";

// MARK: Placeholder parser

export interface PlaceholderToken {
  span: TextSpan;
  /** Exactly what the model wrote, e.g. `[[ Person_1 ]]`. */
  original: string;
  id: PlaceholderId;
  /** True only for the exact canonical form `[[PERSON_1]]`. */
  isCanonical: boolean;
}

export const MAX_TOKEN_LENGTH = 24;
const CATS = "PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET";
const BRACKETED = new RegExp(String.raw`(\[\[|\[|【)[ ]{0,2}(${CATS})([_ ])(\d{1,4}|ME)[ ]{0,2}(\]\]|\]|】)`, "giu");
const BARE = new RegExp(String.raw`(?<![A-Za-z0-9_\[【])(${CATS})_(\d{1,4}|ME)(?![A-Za-z0-9_\]】])`, "gu");

function canonicalId(cat: string, idx: string): PlaceholderId | null {
  const p = parsePlaceholderId(`${cat}_${idx}`);
  if (!p) return null;
  return p.index === "ME" ? "PERSON_ME" : `${CATEGORY_PREFIX[p.category]}_${p.index}`;
}

/**
 * Finds placeholders in model output. The canonical form is always returned (unknown ids become
 * "unknown" chips); tolerated variants — `[PERSON_1]`, bare `PERSON_1`, `[[ PERSON_1 ]]`,
 * `[[Person_1]]`, `[[PERSON 1]]`, `【PERSON_1】` — only when the id is in `knownIds`.
 */
export class PlaceholderParser {
  constructor(readonly knownIds: ReadonlySet<PlaceholderId>) {}

  tokens(text: string): PlaceholderToken[] {
    const found: PlaceholderToken[] = [];
    for (const m of text.matchAll(BRACKETED)) {
      const id = canonicalId(m[2]!, m[4]!);
      if (!id) continue;
      const original = m[0];
      const canonical = m[1] === "[[" && m[5] === "]]" && m[3] === "_" && original === idToken(id);
      if (!canonical && !this.knownIds.has(id)) continue;
      found.push({ span: { start: m.index!, end: m.index! + original.length }, original, id, isCanonical: canonical });
    }
    for (const m of text.matchAll(BARE)) {
      const span = { start: m.index!, end: m.index! + m[0].length };
      if (found.some((f) => f.span.start < span.end && span.start < f.span.end)) continue;
      const id = canonicalId(m[1]!, m[2]!);
      if (!id || !this.knownIds.has(id) || m[0] !== id) continue;
      found.push({ span, original: m[0], id, isCanonical: false });
    }
    return found.sort((a, b) => a.span.start - b.span.start);
  }
}

// MARK: Restore

export interface RestoreContext {
  entities: EntityMap;
  /** Used for `[[PERSON_ME]]` only in drafts written as the user. */
  userFirstName?: string | null;
  writingAsUser?: boolean;
  /** Plain-text stand-in for secrets in copied text. Secrets are never restored. */
  secretDisplay?: string;
}

export type RestoredSegment =
  | { kind: "text"; text: string }
  | { kind: "restored"; id: PlaceholderId; display: string; original: string }
  | { kind: "secret"; id: PlaceholderId; original: string }
  | { kind: "unknown"; id: PlaceholderId; original: string };

export function segmentOutput(seg: RestoredSegment, secretDisplay: string): string {
  switch (seg.kind) {
    case "text": return seg.text;
    case "restored": return seg.display;
    case "secret": return secretDisplay;
    case "unknown": return seg.original;
  }
}

const TITLES = new Set(["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "prof", "prof."]);
const byLength = (a: string, b: string): number => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);

/** First mention canonical; later person mentions use the shortest surface form no other person shares. */
function displayForms(map: EntityMap): Map<PlaceholderId, { first: string; later: string }> {
  const people = map.sorted().filter((e) => e.category === "person");
  const result = new Map<PlaceholderId, { first: string; later: string }>();
  for (const e of map.sorted()) {
    if (e.category !== "person") {
      result.set(e.id, { first: e.canonical, later: e.canonical });
      continue;
    }
    const others = people.filter((o) => o.id !== e.id);
    const otherForms = new Set<string>();
    for (const o of others) {
      for (const f of o.surfaceForms) otherForms.add(fold(f));
      for (const w of o.canonical.split(" ")) otherForms.add(fold(w));
    }
    const short = [...e.surfaceForms].filter((f) => !TITLES.has(f.toLowerCase()) && !otherForms.has(fold(f))).sort(byLength)[0] ?? e.canonical;
    result.set(e.id, { first: e.canonical, later: short });
  }
  return result;
}

/**
 * Streaming-safe restore (port of StreamingRestorer). For any split of a response into chunks —
 * deltas or cumulative snapshots — the segments equal restoring the whole response at once.
 * Only the last ≤ `HOLD_BACK` UTF-16 units are held back; secrets are never restored.
 */
export class StreamingRestorer {
  static readonly HOLD_BACK = 32;
  private readonly parser: PlaceholderParser;
  private readonly forms: Map<PlaceholderId, { first: string; later: string }>;
  private buffer = "";
  private emitted = 0;
  private readonly seen = new Set<PlaceholderId>();
  segments: RestoredSegment[] = [];
  finished = false;

  constructor(readonly context: RestoreContext) {
    this.parser = new PlaceholderParser(new Set(context.entities.keys()));
    this.forms = displayForms(context.entities);
  }

  append(delta: string): RestoredSegment[] {
    if (this.finished) throw new Error("restorer already finished");
    this.buffer += delta;
    return this.process(false);
  }

  update(cumulative: string): RestoredSegment[] {
    return cumulative.length > this.buffer.length ? this.append(cumulative.slice(this.buffer.length)) : [];
  }

  finish(): RestoredSegment[] {
    const out = this.process(true);
    this.finished = true;
    return out;
  }

  get text(): string {
    const sd = this.context.secretDisplay ?? "(hidden code)";
    return this.segments.map((s) => segmentOutput(s, sd)).join("");
  }

  private process(final: boolean): RestoredSegment[] {
    const buf = this.buffer;
    const tokens = this.parser.tokens(buf);
    let safeEnd = final ? buf.length : Math.max(this.emitted, buf.length - StreamingRestorer.HOLD_BACK);
    if (!final) {
      const spanning = tokens.find((t) => t.span.start < safeEnd && t.span.end > safeEnd);
      if (spanning) safeEnd = Math.max(this.emitted, spanning.span.start);
    }
    // Never cut between the two UTF-16 halves of one character.
    if (!final && safeEnd > this.emitted && safeEnd < buf.length) {
      const prev = buf.charCodeAt(safeEnd - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) safeEnd -= 1;
    }
    if (safeEnd <= this.emitted) return [];

    const out: RestoredSegment[] = [];
    let cursor = this.emitted;
    for (const t of tokens) {
      if (t.span.start < this.emitted || t.span.end > safeEnd) continue;
      if (t.span.start > cursor) out.push({ kind: "text", text: buf.slice(cursor, t.span.start) });
      out.push(this.resolve(t));
      cursor = t.span.end;
    }
    if (safeEnd > cursor) out.push({ kind: "text", text: buf.slice(cursor, safeEnd) });
    this.emitted = safeEnd;
    for (const seg of out) {
      const last = this.segments.at(-1);
      if (seg.kind === "text" && last?.kind === "text") this.segments[this.segments.length - 1] = { kind: "text", text: last.text + seg.text };
      else this.segments.push(seg);
    }
    return out;
  }

  private resolve(t: PlaceholderToken): RestoredSegment {
    if (t.id.startsWith("SECRET_")) return { kind: "secret", id: t.id, original: t.original };
    if (isMe(t.id)) {
      const display = this.context.writingAsUser ? (this.context.userFirstName ?? "me") : "you";
      return { kind: "restored", id: t.id, display, original: t.original };
    }
    const forms = this.forms.get(t.id);
    if (!forms) return { kind: "unknown", id: t.id, original: t.original };
    const display = this.seen.has(t.id) ? forms.later : forms.first;
    this.seen.add(t.id);
    return { kind: "restored", id: t.id, display, original: t.original };
  }
}

export interface RestoreResult {
  text: string;
  segments: RestoredSegment[];
  /** Where restored values sit in `text` (UTF-16), for underlining. */
  restoredRanges: { span: TextSpan; id: PlaceholderId }[];
  unknownIds: PlaceholderId[];
  secretsHidden: number;
}

export function resultFrom(r: StreamingRestorer): RestoreResult {
  const sd = r.context.secretDisplay ?? "(hidden code)";
  const restoredRanges: RestoreResult["restoredRanges"] = [];
  const unknownIds: PlaceholderId[] = [];
  let secretsHidden = 0;
  let offset = 0;
  for (const seg of r.segments) {
    const len = segmentOutput(seg, sd).length;
    if (seg.kind === "restored") restoredRanges.push({ span: { start: offset, end: offset + len }, id: seg.id });
    else if (seg.kind === "unknown") unknownIds.push(seg.id);
    else if (seg.kind === "secret") secretsHidden++;
    offset += len;
  }
  return { text: r.text, segments: r.segments, restoredRanges, unknownIds, secretsHidden };
}

/** Unary restore — one streaming append plus finish, so streaming and non-streaming can never disagree. */
export function restore(modelOutput: string, context: RestoreContext): RestoreResult {
  const s = new StreamingRestorer(context);
  s.append(modelOutput);
  s.finish();
  return resultFrom(s);
}

export interface FidelityReport {
  /** Canonical placeholders the phone couldn't resolve. */
  unknownIds: PlaceholderId[];
  /** Entities whose real value appears in the model's own output — it guessed a real name. */
  guessedEntities: PlaceholderId[];
  isClean: boolean;
}

/** Runs on the model's raw output (before restore), so any real value found there wasn't introduced by restore. */
export function fidelityCheck(modelOutput: string, context: RestoreContext): FidelityReport {
  const unknownIds = restore(modelOutput, context).unknownIds;
  const guessedEntities = context.entities
    .sorted()
    .filter((e: Entity) => mustNotEgress(e.action) && [...e.surfaceForms].some((f) => f.length >= 3 && contains(f, modelOutput)))
    .map((e) => e.id);
  return { unknownIds, guessedEntities, isClean: unknownIds.length === 0 && guessedEntities.length === 0 };
}
