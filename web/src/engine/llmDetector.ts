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
}

export const isComplete = (r: LLMDetectionReport): boolean => r.failedChunks.length === 0 && r.refusedChunks.length === 0 && r.unavailable === null;

interface Item {
  text: string;
  type: string;
  role: string | null;
  sameAs: string | null;
  confidence: Confidence;
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

function parseItems(output: string): Item[] | null {
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
      confidence: conf === "high" || conf === "medium" || conf === "low" ? conf : "medium",
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
  constructor(
    readonly engine: PhoneOnlyEngine,
    readonly prompts: PromptLibrary,
    readonly budgetTokens: number,
  ) {}

  async detect(text: string, progress: (section: number, of: number) => void = () => {}): Promise<LLMDetectionReport> {
    const report: LLMDetectionReport = { candidates: [], failedChunks: [], refusedChunks: [], hallucinatedDropped: 0, repairsUsed: 0, unavailable: null, chunkCount: 0 };
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
      output = (await this.engine.respond({ promptId: "detect.v1", text: this.prompts.render("detect.v1", { chunk: chunk.text }) }, ANALYSIS_OPTIONS)).text;
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
      const category = CATEGORY[item.type];
      if (!category) continue;
      const ranges = occurrences(item.text, chunk.text);
      if (ranges.length === 0) {
        report.hallucinatedDropped++;
        continue;
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
