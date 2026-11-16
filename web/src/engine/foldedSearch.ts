import type { TextSpan } from "./types";

/**
 * Case-, diacritic- and width-insensitive, word-bounded search (port of FoldedSearch.swift),
 * shared by the Vault matcher (D1), the egress gate (G1/G2/G5) and the restore fidelity check.
 *
 * A hit never starts or ends inside a word — the character before and after must not be a
 * letter, digit or combining mark — so "Raj" matches "Raj's" but never "Rajesh". Whitespace in
 * the needle matches any run of whitespace. All spans are UTF-16 offsets into the *original* text.
 */

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const MARK = /\p{M}/gu;

/** Lowercased (unless `keepCase`), diacritic-stripped, width-folded form. */
export function fold(s: string, keepCase = false): string {
  let out = "";
  for (const ch of s) out += foldChar(ch, keepCase);
  return out;
}

function foldChar(ch: string, keepCase: boolean): string {
  const n = ch.normalize("NFKD").replace(MARK, "");
  return keepCase ? n : n.toLowerCase();
}

interface Folded {
  text: string;
  /** For each folded UTF-16 unit: the original offset where its source character starts. */
  starts: number[];
  /** …and where it ends. */
  ends: number[];
}

function foldWithMap(s: string, keepCase: boolean): Folded {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let off = 0;
  for (const ch of s) {
    const f = foldChar(ch, keepCase);
    for (let i = 0; i < f.length; i++) {
      starts.push(off);
      ends.push(off + ch.length);
    }
    text += f;
    off += ch.length;
  }
  return { text, starts, ends };
}

/** True if the code point at UTF-16 `index` is outside the string or not part of a word. */
export function isBoundary(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return true;
  let i = index;
  const unit = text.charCodeAt(i);
  if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
    const prev = text.charCodeAt(i - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) i -= 1;
  }
  const cp = text.codePointAt(i);
  if (cp === undefined) return true;
  return !WORD_CHAR.test(String.fromCodePoint(cp));
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * All non-overlapping hits of `needle` in `haystack`, left to right.
 * `caseSensitive` keeps diacritic/width folding but requires exact letter case (used by the
 * gate's name-token check so "Will" the name doesn't match "will" the verb).
 */
export function ranges(needle: string, haystack: string, caseSensitive = false): TextSpan[] {
  const tokens = needle.trim().split(/\s+/u).filter((t) => t.length > 0).map((t) => fold(t, caseSensitive)).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const re = new RegExp(tokens.map(escapeRegExp).join("\\s+"), "gu");
  const f = foldWithMap(haystack, caseSensitive);
  const results: TextSpan[] = [];
  let searchStart = 0;
  while (searchStart < f.text.length) {
    re.lastIndex = searchStart;
    const m = re.exec(f.text);
    if (!m || m[0].length === 0) break;
    const fs = m.index;
    const fe = m.index + m[0].length;
    const start = f.starts[fs];
    const end = f.ends[fe - 1];
    if (start === undefined || end === undefined) break;
    if (isBoundary(haystack, start - 1) && isBoundary(haystack, end)) {
      results.push({ start, end });
      searchStart = fe;
    } else {
      searchStart = fs + 1;
    }
  }
  return results;
}

/** Whether `needle` occurs anywhere in `haystack` (word-bounded, folded). */
export function contains(needle: string, haystack: string, caseSensitive = false): boolean {
  return ranges(needle, haystack, caseSensitive).length > 0;
}
