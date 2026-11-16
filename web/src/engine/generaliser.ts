import { contains, fold, ranges } from "./foldedSearch";
import type { PatternDetector } from "./patterns";
import { entityTerms } from "./terms";
import { type Entity, type EntityMap, mustNotEgress } from "./types";

export const MAX_WORDS = 8;
const DAY_MS = 86_400_000;

/** Swift's `.rounded()` — half away from zero (JS `Math.round` rounds half up). */
const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

// MARK: Date parsing (en_US_POSIX, UTC, non-lenient — port of DateText)

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(name: string): number | null {
  const n = name.toLowerCase();
  const full = MONTHS.indexOf(n);
  if (full >= 0) return full;
  const abbr = MONTHS.findIndex((m) => m.slice(0, 3) === n);
  return n.length === 3 && abbr >= 0 ? abbr : null;
}

function validDate(y: number, m: number, d: number): number | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, m, d);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === m && back.getUTCDate() === d ? ms : null;
}

/** Two-digit years map into [today − 80, today + 20] like DateFormatter's `yy`. */
function expandYear(yy: number, today: Date): number {
  const current = today.getUTCFullYear();
  let year = Math.floor(current / 100) * 100 + yy;
  if (year > current + 20) year -= 100;
  else if (year < current - 80) year += 100;
  return year;
}

export function parseDate(raw: string, today: Date): Date | null {
  const s = raw.replaceAll(",", " ").replaceAll(".", " ").replace(/(\d)(st|nd|rd|th)\b/gu, "$1").split(/\s+/u).filter(Boolean).join(" ");
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})$/))) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const y = m[4]!.length === 2 ? expandYear(Number(m[4]), today) : Number(m[4]);
    const [mm, dd] = a > 12 ? [b - 1, a] : [a - 1, b];
    const ms = validDate(y, mm, dd);
    return ms === null ? null : new Date(ms);
  }
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const ms = validDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return ms === null ? null : new Date(ms);
  }
  let day: number | undefined;
  let month: number | null = null;
  let year: number | undefined;
  if ((m = s.match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/))) [day, month, year] = [Number(m[1]), monthIndex(m[2]!), Number(m[3])];
  else if ((m = s.match(/^([A-Za-z]+) (\d{1,2}) (\d{4})$/))) [day, month, year] = [Number(m[2]), monthIndex(m[1]!), Number(m[3])];
  else if ((m = s.match(/^([A-Za-z]+) (\d{1,2})$/))) [day, month] = [Number(m[2]), monthIndex(m[1]!)];
  else if ((m = s.match(/^(\d{1,2}) ([A-Za-z]+)$/))) [day, month] = [Number(m[1]), monthIndex(m[2]!)];
  else return null;
  if (month === null || day === undefined) return null;
  if (year !== undefined) {
    const ms = validDate(year, month, day);
    return ms === null ? null : new Date(ms);
  }
  // No year: the most recent such date, not more than ~6 months ahead.
  const thisYear = today.getUTCFullYear();
  const candidate = validDate(thisYear, month, day);
  if (candidate === null) return null;
  return new Date(candidate - today.getTime() > 183 * DAY_MS ? (validDate(thisYear - 1, month, day) ?? candidate) : candidate);
}

// MARK: Ladder defaults

/** "late 30s" (balanced) or "30s" (coarse). Children/teens are never given exact ages. */
export function ageDescription(dob: Date, today: Date, coarse: boolean): string {
  let years = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < dob.getUTCMonth() || (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) years -= 1;
  if (years < 0) return "an adult";
  if (years < 13) return "a child";
  if (years < 20) return "a teenager";
  const decade = Math.floor(years / 10) * 10;
  if (coarse) return `${decade}s`;
  const pos = years % 10;
  return `${pos <= 3 ? "early" : pos <= 6 ? "mid" : "late"} ${decade}s`;
}

/** "3 weeks ago", "in 2 days", "about 2 years ago". */
export function relativeDescription(date: Date, today: Date): string {
  const days = roundHalfAway((date.getTime() - today.getTime()) / DAY_MS);
  const n = Math.abs(days);
  const future = days > 0;
  const phrase = (k: number, unit: string): string => {
    const u = k === 1 ? unit : unit + "s";
    return future ? `in ${k} ${u}` : `${k} ${u} ago`;
  };
  if (n === 0) return "today";
  if (n === 1) return future ? "tomorrow" : "yesterday";
  if (n < 7) return phrase(n, "day");
  if (n < 60) return phrase(roundHalfAway(n / 7), "week");
  if (n < 365) return phrase(roundHalfAway(n / 30.4), "month");
  const years = roundHalfAway(n / 365.25);
  const s = years === 1 ? "" : "s";
  return future ? `in about ${years} year${s}` : `about ${years} year${s} ago`;
}

export function ladderDefault(e: Entity, level: number, today: Date = new Date()): string {
  switch (e.category) {
    case "org": return "an organisation";
    case "location": return level >= 3 ? "a place" : "a city";
    case "health": return level >= 3 ? "a health matter" : "a medical condition";
    case "quasi": return "a specific detail";
    case "date": {
      const date = parseDate(e.canonical, today);
      if (!date) return e.subtype === "dob" ? "an adult" : "a recent date";
      return e.subtype === "dob" ? ageDescription(date, today, level >= 3) : relativeDescription(date, today);
    }
    case "person": return "a person";
    case "contact": return "contact details";
    case "id": return "a reference number";
    case "secret": return "a secret";
  }
}

// MARK: Validation of model rewrites

/**
 * A rewrite is accepted only if it is non-empty, ≤ 8 words, different from the phrase, contains no
 * entity term (surface forms, partial names, distinctive words) and no pattern hit outside dates.
 */
export function validateRewrite(rewrite: string, phrase: string, entities: EntityMap, patterns: PatternDetector): boolean {
  const r = rewrite.trim();
  if (r.length === 0 || r.split(/\s+/u).length > MAX_WORDS) return false;
  if (fold(r) === fold(phrase)) return false;
  if (r.includes("[[")) return false;
  for (const e of entities.sorted()) {
    if (e.category === "date" && !mustNotEgress(e.action)) continue;
    for (const term of entityTerms(e)) if (ranges(term.text, r, term.caseSensitive).length > 0) return false;
  }
  return !patterns.detect(r).some((c) => c.category !== "date");
}

export { contains };
