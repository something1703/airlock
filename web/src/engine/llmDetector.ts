import { chunks, halve, type Chunk } from "./chunker";
import { ANALYSIS_OPTIONS, EngineError, type PhoneAvailability, type PhoneOnlyEngine } from "./engines";
import { isBoundary } from "./foldedSearch";
import type { PromptLibrary } from "./prompts";
import type { Candidate, Confidence, PrivacyCategory } from "./types";

export interface LLMDetectionReport {
  candidates: Candidate[];
  failedChunks: number[];
  refusedChunks: number[];
  hallucinatedDropped: number;
  repairsUsed: number;
  unavailable: PhoneAvailability | null;
  chunkCount: number;
  /**
   * `detect.v2`: the model's own "a large hospital" phrase for an ORG / LOCATION / HEALTH item, by `category:lower-cased text`.
   * Unchecked: the pipeline shape-checks it and the Sealer validates it before use.
   */
  generals: Map<string, string>;
}

/** Key into `LLMDetectionReport.generals`. */
export const generalKey = (category: PrivacyCategory, text: string): string => `${category}:${text.toLowerCase()}`;

/** The prompt that asks for the one-line format; anything else is answered as v1 JSON. */
export const DETECT_V2 = "detect.v2";
export const DETECT_V1 = "detect.v1";

export interface DetectorOptions {
  /** `detect.v1` (JSON, default) or `detect.v2` (lines). Both replies parse either way. */
  promptId?: string;
  /** Rule hits to hide from the model in the prompt (`[email]`, `[phone]`, `[id]`…) so it doesn't write them back out. */
  masks?: readonly Candidate[];
}

export const isComplete = (r: LLMDetectionReport): boolean => r.failedChunks.length === 0 && r.refusedChunks.length === 0 && r.unavailable === null;

interface Item {
  text: string;
  type: string;
  role: string | null;
  sameAs: string | null;
  confidence: Confidence;
  general: string | null;
}

/** First balanced `{…}` (code fences and prose around it are ignored). */
export function firstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * `detect.v2` reply: `TYPE | exact text | role | general`, one per line, `?TYPE` when unsure, `END` last. Returns null when
 * the reply holds neither a line in that form nor `END` (so it can be repaired). A bare `END` is a valid "nothing found".
 */
function parseLines(output: string): Item[] | null {
  const items: Item[] = [];
  let sawEnd = false;
  let sawLine = false;
  for (const raw of output.split(/\r?\n/u)) {
    const line = raw.trim().replace(/^[-*•]\s+/u, "");
    if (!line) continue;
    if (line.toUpperCase() === "END") {
      sawEnd = true;
      break;
    }
    const m = line.match(/^(\??)\s*([A-Za-z_ ]+?)\s*\|(.*)$/u);
    if (!m) continue;
    sawLine = true;
    const [, unsure, type, rest] = m;
    const fields = rest!.split("|").map((f) => f.trim());
    const text = fields[0] ?? "";
    if (!text) continue;
    const dash = (f: string | undefined): string | null => (f === undefined || f === "" || f === "-" ? null : f);
    items.push({ text, type: type!.toUpperCase(), role: dash(fields[1]), sameAs: null, confidence: unsure ? "low" : "high", general: dash(fields[2]) });
  }
  return sawLine || sawEnd ? items : null;
}

function parseItems(output: string): Item[] | null {
  const lines = parseLines(output);
  if (lines) return lines;
  const json = firstJsonObject(output);
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return null;
  }
  const items = (obj as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out: Item[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const d = raw as Record<string, unknown>;
    if (typeof d.text !== "string" || typeof d.type !== "string" || d.text.trim() === "") continue;
    const conf = typeof d.confidence === "string" ? d.confidence.toLowerCase() : "";
    out.push({
      text: d.text, type: d.type.toUpperCase(), role: typeof d.role === "string" ? d.role : null, sameAs: typeof d.same_as === "string" ? d.same_as : null,
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "medium", general: typeof d.general === "string" && d.general.trim() ? d.general.trim() : null,
    });
  }
  return out;
}

const CATEGORY: Record<string, PrivacyCategory> = {
  PERSON: "person", NAME: "person", ORG: "org", ORGANIZATION: "org", ORGANISATION: "org", COMPANY: "org", LOCATION: "location", LOC: "location",
  PLACE: "location", ADDRESS: "location", CONTACT: "contact", EMAIL: "contact", PHONE: "contact", ID: "id", NUMBER: "id", DATE: "date", DOB: "date",
  HEALTH: "health", MEDICAL: "health", SECRET: "secret", PASSWORD: "secret",
};

/** Word-bounded occurrences: exact case first, then case-insensitive. */
function occurrences(needle: string, hay: string): { start: number; end: number }[] {
  const scan = (h: string, n: string): { start: number; end: number }[] => {
    const out: { start: number; end: number }[] = [];
    let from = 0;
    while (from < h.length) {
      const i = h.indexOf(n, from);
      if (i < 0) break;
      if (isBoundary(hay, i - 1) && isBoundary(hay, i + n.length)) out.push({ start: i, end: i + n.length });
      from = i + Math.max(1, n.length);
    }
    return out;
  };
  const exact = scan(hay, needle);
  if (exact.length) return exact;
  const lower = hay.toLowerCase();
  return lower.length === hay.length ? scan(lower, needle.toLowerCase()) : [];
}

type Outcome = { kind: "found"; candidates: Candidate[] } | { kind: "stop" };

/**
 * D4 — on-device LLM detection (port of LLMDetector.swift; prompt `detect.v1`). Phone-only (INV-3).
 * Every returned candidate is an exact substring of the input; invented items are dropped. Broken JSON
 * gets one `detect-repair.v1` attempt; `contextTooLong` halves the chunk (≤ 2 times); refusals and
 * failures are reported, never hidden.
 */
export class LLMDetector {
  readonly promptId: string;
  private readonly masks: readonly Candidate[];

  constructor(
    readonly engine: PhoneOnlyEngine,
    readonly prompts: PromptLibrary,
    readonly budgetTokens: number,
    options: DetectorOptions = {},
  ) {
    this.promptId = options.promptId ?? DETECT_V1;
    // Masking belongs to detect.v2 (its prompt tells the model what [email] means); detect.v1 sees the text as written.
    this.masks = this.promptId === DETECT_V2 ? (options.masks ?? []) : [];
  }

  async detect(text: string, progress: (section: number, of: number) => void = () => {}): Promise<LLMDetectionReport> {
    const report: LLMDetectionReport = { candidates: [], failedChunks: [], refusedChunks: [], hallucinatedDropped: 0, repairsUsed: 0, unavailable: null, chunkCount: 0, generals: new Map() };
    const availability = await this.engine.availability();
    if (availability !== "available") {
      report.unavailable = availability;
      return report;
    }
    const cs = chunks(text, this.budgetTokens);
    report.chunkCount = cs.length;
    const seen = new Set<string>();
    for (const chunk of cs) {
      progress(chunk.index + 1, cs.length);
      const outcome = await this.run(chunk, text, 0, report);
      if (outcome.kind === "stop") break;
      for (const c of outcome.candidates) {
        const key = `${c.span.start}:${c.span.end}:${c.category}`;
        if (!seen.has(key)) {
          seen.add(key);
          report.candidates.push(c);
        }
      }
    }
    report.candidates.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
    return report;
  }

  private async run(chunk: Chunk, fullText: string, depth: number, report: LLMDetectionReport): Promise<Outcome> {
    let output: string;
    try {
      output = (await this.engine.respond({ promptId: this.promptId, text: this.prompts.render(this.promptId, { chunk: maskChunk(chunk, this.masks) }) }, ANALYSIS_OPTIONS)).text;
    } catch (e) {
      return this.handle(e, chunk, fullText, depth, report);
    }
    const items = parseItems(output);
    if (items) return { kind: "found", candidates: this.locate(items, chunk, report) };

    report.repairsUsed++;
    let repaired: string;
    try {
      repaired = (await this.engine.respond({ promptId: "detect-repair.v1", text: this.prompts.render("detect-repair.v1", { broken: output }) }, ANALYSIS_OPTIONS)).text;
    } catch (e) {
      return this.handle(e, chunk, fullText, depth, report);
    }
    const again = parseItems(repaired);
    if (again) return { kind: "found", candidates: this.locate(again, chunk, report) };
    report.failedChunks.push(chunk.index);
    return { kind: "found", candidates: [] };
  }

  private async handle(e: unknown, chunk: Chunk, fullText: string, depth: number, report: LLMDetectionReport): Promise<Outcome> {
    const code = e instanceof EngineError ? e.code : "other";
    if (code === "contextTooLong" && depth < 2) {
      const found: Candidate[] = [];
      for (const half of halve(chunk, fullText)) {
        if (half.span.start === chunk.span.start && half.span.end === chunk.span.end) continue;
        const o = await this.run(half, fullText, depth + 1, report);
        if (o.kind === "stop") return o;
        found.push(...o.candidates);
      }
      return { kind: "found", candidates: found };
    }
    if (code === "refused") {
      report.refusedChunks.push(chunk.index);
      return { kind: "found", candidates: [] };
    }
    if (code === "unavailable") {
      report.unavailable = "unavailable";
      return { kind: "stop" };
    }
    if (code === "cancelled") return { kind: "stop" };
    report.failedChunks.push(chunk.index);
    return { kind: "found", candidates: [] };
  }

  private locate(items: Item[], chunk: Chunk, report: LLMDetectionReport): Candidate[] {
    const out: Candidate[] = [];
    for (const item of items) {
      if (/^\[[^\]]*\]$/u.test(item.text.trim())) continue; // a mask token ("[email]") the model echoed back: not a detail
      const category = CATEGORY[item.type];
      if (!category) continue;
      const ranges = occurrences(item.text, chunk.text);
      if (ranges.length === 0) {
        report.hallucinatedDropped++;
        continue;
      }
      if (item.general && (category === "org" || category === "location" || category === "health")) {
        const k = generalKey(category, item.text);
        if (!report.generals.has(k)) report.generals.set(k, item.general);
      }
      const subtype = category === "location" ? (/\p{N}/u.test(item.text) ? "address" : "place") : category === "date" ? "dob" : null;
      for (const r of ranges) {
        out.push({
          span: { start: chunk.span.start + r.start, end: chunk.span.start + r.end }, text: chunk.text.slice(r.start, r.end), category, subtype,
          detector: "llm", confidence: item.confidence, roleHint: item.role, sameAs: item.sameAs,
        });
      }
    }
    return out;
  }
}

const MASK_TOKEN: Record<string, string> = { email: "[email]", phone: "[phone]", url: "[link]", handle: "[handle]" };

/**
 * The chunk as the model sees it for `detect.v2`: contact, ID and secret hits the rules already found become `[email]`,
 * `[phone]`, `[id]`, `[secret]`, so the model doesn't spend output tokens copying them back. Locating spans still uses
 * the original chunk text. With no masks the chunk is returned unchanged.
 */
export function maskChunk(chunk: Chunk, masks: readonly Candidate[]): string {
  const inside = masks
    .filter((c) => (c.category === "contact" || c.category === "id" || c.category === "secret") && c.span.start >= chunk.span.start && c.span.end <= chunk.span.end)
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end);
  if (!inside.length) return chunk.text;
  let out = "";
  let at = chunk.span.start;
  for (const c of inside) {
    if (c.span.start < at) continue; // overlaps a mask already applied
    out += chunk.text.slice(at - chunk.span.start, c.span.start - chunk.span.start);
    out += c.category === "contact" ? (MASK_TOKEN[c.subtype ?? ""] ?? "[contact]") : c.category === "secret" ? "[secret]" : "[id]";
    at = c.span.end;
  }
  return out + chunk.text.slice(at - chunk.span.start);
}
