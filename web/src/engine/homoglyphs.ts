// Look-alike characters used to dodge filters ("Rаj" with a Cyrillic "а") — port of Homoglyphs.swift.

const PAIRS: [string, string][] = [
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["у", "y"], ["х", "x"], ["і", "i"], ["ј", "j"], ["ѕ", "s"], ["ԁ", "d"],
  ["һ", "h"], ["ԛ", "q"], ["ԝ", "w"], ["ӏ", "l"], ["ѵ", "v"],
  ["А", "A"], ["В", "B"], ["Е", "E"], ["К", "K"], ["М", "M"], ["Н", "H"], ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["У", "Y"],
  ["Х", "X"], ["І", "I"], ["Ј", "J"], ["Ѕ", "S"], ["Ԁ", "D"], ["Ԛ", "Q"], ["Ԝ", "W"],
  ["α", "a"], ["ο", "o"], ["ρ", "p"], ["ν", "v"], ["ι", "i"], ["κ", "k"], ["υ", "u"], ["ε", "e"],
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"], ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"], ["Ρ", "P"],
  ["Τ", "T"], ["Υ", "Y"], ["Χ", "X"],
];
const MAP = new Map(PAIRS);

/** Each listed confusable → the Latin letter it imitates; every mapping is one UTF-16 unit to one unit. */
export function skeleton(s: string): string {
  let out = "";
  for (const ch of s) out += MAP.get(ch) ?? ch;
  return out;
}

type Script = "latin" | "cyrillic" | "greek" | "other";

function script(cp: number): Script {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) return "latin";
  if (cp >= 0x400 && cp <= 0x52f) return "cyrillic";
  if (cp >= 0x370 && cp <= 0x3ff) return "greek";
  return "other";
}

/** UTF-16 spans of words that mix Latin with Cyrillic or Greek letters. */
export function mixedScriptWords(text: string): { start: number; end: number }[] {
  const result: { start: number; end: number }[] = [];
  let offset = 0;
  let wordStart = 0;
  let scripts = new Set<Script>();
  const close = (): void => {
    if (scripts.has("latin") && (scripts.has("cyrillic") || scripts.has("greek"))) result.push({ start: wordStart, end: offset });
    scripts = new Set();
  };
  for (const ch of text) {
    if (/\p{Alphabetic}/u.test(ch)) {
      if (scripts.size === 0) wordStart = offset;
      const s = script(ch.codePointAt(0) ?? 0);
      if (s !== "other") scripts.add(s);
    } else close();
    offset += ch.length;
  }
  close();
  return result;
}
