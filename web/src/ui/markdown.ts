// A small Markdown subset for answers (docs/13-FIX-PLAN.md FX-01): headings, paragraphs, bullet and numbered lists
// (one level of nesting), rules, **bold**, *italic*, `code`. It works on restored segments, not a string, so a
// restored detail, hidden secret or unknown placeholder stays its own element anywhere it appears.
// Deliberately NOT supported: links, images, raw HTML. A URL is plain text — a restored value inside a link would
// send the real detail wherever the cloud model pointed it (docs/12-REVIEW.md PR-13).
import type { RestoredSegment } from "../engine/restore";

type Atom = Exclude<RestoredSegment, { kind: "text" }>;

export type Inline =
  | { t: "text"; s: string }
  | { t: "atom"; seg: Atom }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; s: string }
  | { t: "br" };

export interface ListItem { c: Inline[]; sub: ListBlock | null }
export interface ListBlock { t: "list"; ordered: boolean; start: number; items: ListItem[] }
export type Block = { t: "h"; level: 1 | 2; c: Inline[] } | { t: "p"; c: Inline[] } | { t: "hr" } | ListBlock;

type Part = { t: "text"; s: string } | { t: "atom"; seg: Atom };
type Line = Part[];

const HEADING = /^\s{0,3}(#{1,6})\s+/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+/;

function splitLines(segments: readonly RestoredSegment[]): Line[] {
  const lines: Line[] = [[]];
  for (const seg of segments) {
    if (seg.kind !== "text") {
      lines[lines.length - 1]!.push({ t: "atom", seg });
      continue;
    }
    const pieces = seg.text.replace(/\r\n?/g, "\n").split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece) lines[lines.length - 1]!.push({ t: "text", s: piece });
    });
  }
  return lines;
}

const leadingText = (line: Line): string => (line[0]?.t === "text" ? line[0].s : "");
const isBlank = (line: Line): boolean => line.every((p) => p.t === "text" && p.s.trim() === "");

/** Removes `n` characters from the start of the line's first text part. */
function dropPrefix(line: Line, n: number): Line {
  const first = line[0];
  if (first?.t !== "text") return line;
  const rest = first.s.slice(n);
  return rest ? [{ t: "text", s: rest }, ...line.slice(1)] : line.slice(1);
}

function trimEnd(line: Line): Line {
  const out = [...line];
  const last = out[out.length - 1];
  if (last?.t === "text") {
    const s = last.s.replace(/\s+$/, "");
    if (s) out[out.length - 1] = { t: "text", s };
    else out.pop();
  }
  return out;
}

export function parseMarkdown(segments: readonly RestoredSegment[]): Block[] {
  const blocks: Block[] = [];
  let para: Inline[] | null = null;
  let list: ListBlock | null = null;
  const endPara = (): void => {
    if (para) blocks.push({ t: "p", c: para });
    para = null;
  };
  const endList = (): void => {
    list = null;
  };

  for (const raw of splitLines(segments)) {
    if (isBlank(raw)) {
      endPara();
      continue; // A blank line inside a list keeps the list open (Gemini often spaces its items).
    }
    const lead = leadingText(raw);
    const onlyText = raw.every((p) => p.t === "text");
    if (onlyText && RULE.test(lead)) {
      endPara(); endList();
      blocks.push({ t: "hr" });
      continue;
    }
    const h = HEADING.exec(lead);
    if (h) {
      endPara(); endList();
      blocks.push({ t: "h", level: h[1]!.length <= 2 ? 1 : 2, c: inline(trimEnd(dropPrefix(raw, h[0].length))) });
      continue;
    }
    const m = ITEM.exec(lead);
    if (m) {
      endPara();
      const indent = m[1]!.replace(/\t/g, "  ").length;
      const ordered = /\d/.test(m[2]!);
      const content = inline(trimEnd(dropPrefix(raw, m[0].length)));
      const current = list as ListBlock | null;
      const parent = current?.items[current.items.length - 1];
      if (indent >= 2 && current && parent) {
        // One level of nesting under the last item.
        if (!parent.sub || parent.sub.ordered !== ordered) parent.sub = { t: "list", ordered, start: ordered ? parseInt(m[2]!, 10) : 1, items: [] };
        parent.sub.items.push({ c: content, sub: null });
        continue;
      }
      if (!current || current.ordered !== ordered) {
        const next: ListBlock = { t: "list", ordered, start: ordered ? parseInt(m[2]!, 10) : 1, items: [] };
        blocks.push(next);
        list = next;
      }
      (list as ListBlock | null)!.items.push({ c: content, sub: null });
      continue;
    }
    const current = list as ListBlock | null;
    if (current && /^\s{2,}/.test(lead)) {
      // An indented continuation line belongs to the last item.
      const item = current.items[current.items.length - 1]!;
      const target = item.sub ? item.sub.items[item.sub.items.length - 1]! : item;
      target.c.push({ t: "br" }, ...inline(trimEnd(dropPrefix(raw, lead.length - lead.trimStart().length))));
      continue;
    }
    endList();
    const content = inline(trimEnd(raw));
    if (para) (para as Inline[]).push({ t: "br" }, ...content);
    else para = content;
  }
  endPara();
  return blocks;
}

// MARK: Inline

type Tok = { t: "text"; s: string } | { t: "atom"; seg: Atom } | { t: "code"; s: string } | { t: "mark"; m: "**" | "*" | "_"; open: boolean; close: boolean };

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

function tokenize(line: Line): Tok[] {
  const out: Tok[] = [];
  for (const part of line) {
    if (part.t === "atom") {
      out.push(part);
      continue;
    }
    const s = part.s;
    let buf = "";
    const flush = (): void => {
      if (buf) out.push({ t: "text", s: buf });
      buf = "";
    };
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c === "`") {
        const j = s.indexOf("`", i + 1);
        if (j > i + 1) {
          flush();
          out.push({ t: "code", s: s.slice(i + 1, j) });
          i = j;
          continue;
        }
      }
      if (c === "*" || c === "_") {
        const m: "**" | "*" | "_" = c === "*" && s[i + 1] === "*" ? "**" : c;
        const before = s[i - 1];
        const after = s[i + m.length];
        let open = !isSpace(after);
        let close = !isSpace(before);
        // `_` inside a word (snake_case, file names) is never emphasis.
        if (m === "_") {
          open = open && !isWord(before);
          close = close && !isWord(after);
        }
        if (open || close) {
          flush();
          out.push({ t: "mark", m, open, close });
          i += m.length - 1;
          continue;
        }
      }
      buf += c;
    }
    flush();
  }
  return out;
}

/** Pairs emphasis markers; anything unmatched (e.g. a `**` still streaming) is shown as typed. */
function inline(line: Line): Inline[] {
  const toks = tokenize(line);
  const partner = new Map<number, number>();
  const stack: number[] = [];
  toks.forEach((tok, i) => {
    if (tok.t !== "mark") return;
    if (tok.close) {
      for (let k = stack.length - 1; k >= 0; k--) {
        const j = stack[k]!;
        if ((toks[j] as Extract<Tok, { t: "mark" }>).m === tok.m) {
          partner.set(j, i);
          stack.length = k; // openers in between stay unmatched
          return;
        }
      }
    }
    if (tok.open) stack.push(i);
  });
  const build = (from: number, to: number): Inline[] => {
    const out: Inline[] = [];
    const text = (s: string): void => {
      const last = out[out.length - 1];
      if (last?.t === "text") last.s += s;
      else out.push({ t: "text", s });
    };
    for (let i = from; i < to; i++) {
      const tok = toks[i]!;
      if (tok.t === "text") text(tok.s);
      else if (tok.t === "atom") out.push({ t: "atom", seg: tok.seg });
      else if (tok.t === "code") out.push({ t: "code", s: tok.s });
      else {
        const end = partner.get(i);
        if (end !== undefined && end > i) {
          out.push({ t: tok.m === "**" ? "strong" : "em", c: build(i + 1, end) });
          i = end;
        } else text(tok.m);
      }
    }
    return out;
  };
  return build(0, toks.length);
}
