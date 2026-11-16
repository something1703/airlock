import type { TextSpan } from "./types";

/** Text after normalisation, with a map back to the original (port of Normaliser.swift). */
export interface NormalisedText {
  text: string;
  /** `originalOffsets.length === text.length + 1`; the last element is the original length. */
  originalOffsets: number[];
}

export function toOriginal(n: NormalisedText, span: TextSpan): TextSpan {
  const last = n.originalOffsets.length - 1;
  const start = n.originalOffsets[Math.min(span.start, last)] ?? 0;
  const end = n.originalOffsets[Math.min(span.end, last)] ?? start;
  return { start, end: Math.max(start, end) };
}

/** Maximum input accepted for sealing (≈ 15k words). */
export const MAX_INPUT_UTF16 = 60_000;

const INVISIBLE = new Set<number>([
  0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
  0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

const QUOTES: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201a: "'", 0x201b: "'", 0x2032: "'", 0x02bc: "'",
  0x201c: '"', 0x201d: '"', 0x201e: '"', 0x201f: '"', 0x2033: '"',
};

const NEWLINE_LIKE = new Set<number>([0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isHorizontalWhitespace(s: string): boolean {
  if (s.length === 0) return false;
  for (const ch of s) if (!/\s/u.test(ch) || NEWLINE_LIKE.has(ch.codePointAt(0) ?? 0)) return false;
  return true;
}

/**
 * Stage 1 — per character: strip zero-width/invisible characters, straighten smart quotes,
 * NFKC, collapse horizontal whitespace runs to one space, CRLF/CR → "\n". Idempotent (used by gate G6).
 */
export function normalise(input: string): NormalisedText {
  let out = "";
  const offsets: number[] = [];
  let originalOffset = 0;
  let lastWasSpace = false;
  const push = (s: string, from: number): void => {
    out += s;
    for (let i = 0; i < s.length; i++) offsets.push(from);
  };

  for (const { segment } of segmenter.segment(input)) {
    const originalLength = segment.length;
    const at = originalOffset;
    originalOffset += originalLength;

    if (segment === "\r\n" || segment === "\r" || segment === "\n") {
      push("\n", at);
      lastWasSpace = false;
      continue;
    }
    let cleaned = "";
    for (const ch of segment) {
      const cp = ch.codePointAt(0) ?? 0;
      if (INVISIBLE.has(cp)) continue;
      cleaned += QUOTES[cp] ?? ch;
    }
    if (cleaned.length === 0) continue;
    const nfkc = cleaned.normalize("NFKC");
    if (isHorizontalWhitespace(nfkc)) {
      if (!lastWasSpace) {
        push(" ", at);
        lastWasSpace = true;
      }
      continue;
    }
    push(nfkc, at);
    lastWasSpace = false;
  }
  offsets.push(originalOffset);
  return { text: out, originalOffsets: offsets };
}

export const isNormalised = (text: string): boolean => normalise(text).text === text;
