import type { TextSpan } from "./types";

/** A piece of normalised text sized for the on-device window. */
export interface Chunk {
  index: number;
  span: TextSpan;
  text: string;
}

const DENSE = /[Ѐ-ԯ֐-ࣿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/u;
const WS = /\s/u;

/** Conservative token estimate: chars / 3.2 (Latin-like), chars / 1.8 (CJK, Indic, Arabic, Cyrillic). */
export function estimateTokens(s: string): number {
  let weighted = 0;
  for (const ch of s) weighted += DENSE.test(ch) ? 1 / 1.8 : 1 / 3.2;
  return Math.ceil(weighted - 1e-9);
}

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

/** Contiguous sentence spans (trailing whitespace belongs to the sentence before it). */
function sentenceSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const s of sentenceSegmenter.segment(text)) spans.push({ start: s.index, end: s.index + s.segment.length });
  return spans.length ? spans : [{ start: 0, end: text.length }];
}

function hardSplit(span: TextSpan, text: string, budget: number): TextSpan[] {
  if (estimateTokens(text.slice(span.start, span.end)) <= budget) return [span];
  const pieces: TextSpan[] = [];
  let start = span.start;
  while (start < span.end) {
    let end = Math.min(span.end, start + Math.floor(budget * 1.8));
    if (end < span.end) {
      let k = end;
      while (k > start + 1 && !WS.test(text[k - 1] ?? "")) k--;
      if (k > start + 1) end = k;
      const c = text.charCodeAt(end);
      if (c >= 0xdc00 && c <= 0xdfff) end += 1;
    }
    pieces.push({ start, end });
    start = end;
  }
  return pieces;
}

/**
 * Stage 2 — chunking for the on-device window (port of Chunker.swift). Chunks cover the whole text in
 * order, consecutive chunks overlap by one sentence, and each stays within the token budget unless a
 * single unbreakable run is longer than it.
 */
export function chunks(text: string, budgetTokens: number): Chunk[] {
  const budget = Math.max(50, budgetTokens);
  if (text.length === 0) return [];
  const sentences = sentenceSpans(text).flatMap((s) => hardSplit(s, text, budget));
  const result: TextSpan[] = [];
  let i = 0;
  while (i < sentences.length) {
    let j = i;
    let end = sentences[i]!.end;
    while (j + 1 < sentences.length) {
      const candidate = text.slice(sentences[i]!.start, sentences[j + 1]!.end);
      if (estimateTokens(candidate) > budget) break;
      j++;
      end = sentences[j]!.end;
    }
    result.push({ start: sentences[i]!.start, end });
    if (j + 1 >= sentences.length) break;
    i = j > i ? j : j + 1;
  }
  return result.map((span, index) => ({ index, span, text: text.slice(span.start, span.end) }));
}

/** Splits a chunk in two near the middle at whitespace (for `contextTooLong`). */
export function halve(chunk: Chunk, fullText: string): Chunk[] {
  const mid = chunk.span.start + Math.floor((chunk.span.end - chunk.span.start) / 2);
  let cut = mid;
  while (cut > chunk.span.start + 1 && !WS.test(fullText[cut] ?? "")) cut--;
  if (cut <= chunk.span.start + 1) cut = mid;
  const c = fullText.charCodeAt(cut);
  if (c >= 0xdc00 && c <= 0xdfff) cut += 1;
  if (cut <= chunk.span.start || cut >= chunk.span.end) return [chunk];
  const a = { start: chunk.span.start, end: cut };
  const b = { start: cut, end: chunk.span.end };
  return [
    { index: chunk.index, span: a, text: fullText.slice(a.start, a.end) },
    { index: chunk.index, span: b, text: fullText.slice(b.start, b.end) },
  ];
}
