// Private tools (WP-17, docs/02-ARCHITECTURE.md §6.3, docs/04-PROMPTS.md §6). Pure: no Firebase, no DOM.
//
// The cloud model answering a *sealed* request may ask for help from tools that run on this device:
//   today_context   — today's date and the coming days (no time zone or location: those are quasi-identifiers)
//   get_entity_role — the role behind a placeholder ("the user's landlord"), never the real value
//   find_free_slots — free times from a calendar the user imported (.ics, parsed here, never uploaded);
//                     only free ranges leave, never event titles, places or attendees (titles aren't even parsed)
// Every call asks the user first (ConsentBroker). Every result — including refusals — goes through
// `EgressGate.sealToolResult` before it is returned to the model (INV-5).
import { EngineError, type SealedHistory, type SealedToolResponse, type TaskSpec, type ToolCall, type ToolDeclaration, type ToolEngine, type ToolName } from "./engines";
import { type EgressGate, GateBlocked } from "./gate";
import { type EntityMap, type PrivacyCategory, type SealedText, idToken, parsePlaceholderId } from "./types";

// MARK: Declarations (what the model reads — descriptions matter)

export const TOOL_DECLARATIONS: Record<ToolName, ToolDeclaration> = {
  today_context: {
    name: "today_context",
    description: "Get today's date, the weekday, and the dates of this week, next week and the next 14 days, for scheduling and for resolving phrases like \"next Tuesday\". Does not reveal the user's location or time zone.",
  },
  find_free_slots: {
    name: "find_free_slots",
    description: "Find times when the user is free, to suggest meeting times. Returns only free time ranges in the user's local time, never event details.",
    parameters: {
      properties: {
        start_date: { type: "string", description: "First day to search, as an ISO date (YYYY-MM-DD)." },
        end_date: { type: "string", description: "Last day to search (inclusive), as an ISO date (YYYY-MM-DD)." },
        min_minutes: { type: "integer", description: "How long the meeting is, in minutes." },
        max_results: { type: "integer", description: "Maximum number of free slots to return (default 3)." },
      },
      required: ["start_date", "end_date", "min_minutes"],
    },
  },
  get_entity_role: {
    name: "get_entity_role",
    description: "Get more context about a placeholder's role, without revealing identity.",
    parameters: {
      properties: { placeholder: { type: "string", description: "The placeholder exactly as written, e.g. [[PERSON_1]]." } },
      required: ["placeholder"],
    },
  },
};

// MARK: Civil dates and time zones

/** A calendar date (month 1–12). */
export interface CivilDate {
  y: number;
  m: number;
  d: number;
}
/** A wall-clock date and time. */
export interface CivilDateTime extends CivilDate {
  h: number;
  mi: number;
  s: number;
}

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const pad = (n: number): string => String(n).padStart(2, "0");
export const dayNumber = (c: CivilDate): number => Math.floor(Date.UTC(c.y, c.m - 1, c.d) / DAY_MS);
export function fromDayNumber(n: number): CivilDate {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
/** 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (c: CivilDate): number => new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
export const isoDate = (c: CivilDate): string => `${c.y}-${pad(c.m)}-${pad(c.d)}`;
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const atMidnight = (c: CivilDate): CivilDateTime => ({ y: c.y, m: c.m, d: c.d, h: 0, mi: 0, s: 0 });

/** Strict `YYYY-MM-DD` (rejects 2026-02-30). */
export function parseIsoDate(v: unknown): CivilDate | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const c = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (c.m < 1 || c.m > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.m)) return null;
  return c;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of an instant in an IANA zone. */
export function zonedParts(ms: number, tz: string): CivilDateTime {
  if (tz === "UTC") {
    const d = new Date(ms);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { y: out["year"]!, m: out["month"]!, d: out["day"]!, h: out["hour"]! % 24, mi: out["minute"]!, s: out["second"]! };
}

const offsetAt = (ms: number, tz: string): number => {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** The instant a wall-clock time happens in `tz` (DST gaps resolve forward, overlaps to the first). */
export function zonedToUtc(c: CivilDateTime, tz: string): number {
  const guess = Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
  if (tz === "UTC") return guess;
  const o1 = offsetAt(guess, tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

// MARK: .ics (RFC 5545) — just enough to know when the user is busy

export type IcsZone = { kind: "utc" } | { kind: "floating" } | { kind: "tz"; tz: string };
export interface IcsTime {
  date: CivilDateTime;
  zone: IcsZone;
  allDay: boolean;
}
export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcsTime;
  /** Weekdays (0 = Sunday); `n` is the ordinal for MONTHLY ("2TU" → n = 2, "-1FR" → n = -1, plain → 0). */
  byDay?: { wd: number; n: number }[];
  byMonthDay?: number[];
}
/** A busy block. Deliberately no title, description, location, organiser or attendees. */
export interface BusyEvent {
  start: IcsTime;
  /** Timed events: length in ms. */
  durationMs: number;
  /** All-day events: number of days. */
  days: number;
  rrule?: RRule;
  exdates: IcsTime[];
}
/** What Airlock keeps of an imported calendar (stored encrypted on this device, never synced). */
export interface CalendarData {
  v: 1;
  importedAt: number;
  events: BusyEvent[];
  /** VEVENTs ignored: cancelled, marked free, or unreadable. */
  skipped: number;
}

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Unfolds continuation lines (RFC 5545 §3.1). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line.length) out.push(line);
  }
  return out;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}
function parseLine(line: string): Prop | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value: line.slice(colon + 1) };
}

/** IANA zone from a TZID (also accepts Outlook-style "/mozilla.org/…/Europe/London" prefixes); else floating. */
function zoneFor(tzid: string | undefined): IcsZone {
  if (!tzid) return { kind: "floating" };
  if (isValidTimeZone(tzid)) return { kind: "tz", tz: tzid };
  const tail = /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_]+)?)$/.exec(tzid)?.[1];
  if (tail && isValidTimeZone(tail)) return { kind: "tz", tz: tail };
  return { kind: "floating" };
}

function parseIcsTime(value: string, params: Record<string, string>): IcsTime | null {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || params["VALUE"] === "DATE") {
    if (!d) return null;
    return { date: { y: +d[1]!, m: +d[2]!, d: +d[3]!, h: 0, mi: 0, s: 0 }, zone: { kind: "floating" }, allDay: true };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return null;
  const date = { y: +t[1]!, m: +t[2]!, d: +t[3]!, h: +t[4]!, mi: +t[5]!, s: +t[6]! };
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > daysInMonth(date.y, date.m) || date.h > 23 || date.mi > 59) return null;
  return { date, zone: t[7] ? { kind: "utc" } : zoneFor(params["TZID"]), allDay: false };
}

/** ISO 8601 duration as used by iCalendar (P1W, P1D, PT1H30M …) → ms; null if unreadable or negative. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m || m[1] === "-") return null;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => Number(x ?? 0)) as [number, number, number, number, number];
  return (((w * 7 + d) * 24 + h) * 60 + mi) * MIN_MS + s * 1000;
}

function parseRRule(v: string): RRule | null {
  const parts: Record<string, string> = {};
  for (const kv of v.split(";")) {
    const eq = kv.indexOf("=");
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1);
  }
  const freq = parts["FREQ"];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const rule: RRule = { freq, interval: Math.max(1, Number(parts["INTERVAL"] ?? 1) || 1) };
  if (parts["COUNT"]) rule.count = Math.max(1, Number(parts["COUNT"]) || 1);
  if (parts["UNTIL"]) rule.until = parseIcsTime(parts["UNTIL"], {}) ?? undefined;
  if (parts["BYDAY"]) {
    rule.byDay = parts["BYDAY"].split(",").flatMap((code) => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(code.trim().toUpperCase());
      return m ? [{ wd: WEEKDAY_CODES.indexOf(m[2]!), n: m[1] ? Number(m[1]) : 0 }] : [];
    });
  }
  if (parts["BYMONTHDAY"]) rule.byMonthDay = parts["BYMONTHDAY"].split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31);
  return rule;
}

/** Instant of an iCalendar time; floating and all-day times are read in the user's zone. */
export function instantOf(t: IcsTime, localTz: string): number {
  if (t.allDay) return zonedToUtc(atMidnight(t.date), localTz);
  if (t.zone.kind === "utc") return Date.UTC(t.date.y, t.date.m - 1, t.date.d, t.date.h, t.date.mi, t.date.s);
  return zonedToUtc(t.date, t.zone.kind === "tz" ? t.zone.tz : localTz);
}

/**
 * Parses an .ics file into busy blocks. Reads only timing properties (DTSTART, DTEND, DURATION, RRULE,
 * EXDATE, RECURRENCE-ID, STATUS, TRANSP, UID): SUMMARY, DESCRIPTION, LOCATION, ATTENDEE and ORGANIZER are
 * never read, so they cannot be stored, shown to a model, or leak.
 */
export function parseIcs(text: string, now = Date.now()): CalendarData {
  const events: (BusyEvent & { uid?: string })[] = [];
  const overridden = new Map<string, IcsTime[]>();
  let skipped = 0;
  let cur: Prop[] | null = null;
  let nested = 0;
  for (const line of unfold(text)) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      if (p.value.toUpperCase() === "VEVENT" && cur === null) cur = [];
      else if (cur) nested++;
      continue;
    }
    if (p.name === "END") {
      if (nested > 0) nested--;
      else if (p.value.toUpperCase() === "VEVENT" && cur) {
        const ev = buildEvent(cur, overridden);
        if (ev) events.push(ev);
        else skipped++;
        cur = null;
      }
      continue;
    }
    if (cur && nested === 0) cur.push(p);
  }
  for (const ev of events) {
    if (ev.uid && ev.rrule) ev.exdates.push(...(overridden.get(ev.uid) ?? []));
    delete ev.uid;
  }
  return { v: 1, importedAt: now, events, skipped };
}

function buildEvent(props: Prop[], overridden: Map<string, IcsTime[]>): (BusyEvent & { uid?: string }) | null {
  const get = (n: string): Prop | undefined => props.find((p) => p.name === n);
  const uid = get("UID")?.value.trim();
  const dtstart = get("DTSTART");
  const start = dtstart ? parseIcsTime(dtstart.value, dtstart.params) : null;
  const recurrenceId = get("RECURRENCE-ID");
  if (recurrenceId && uid) {
    // A moved or cancelled occurrence of a recurring event: the original slot is no longer busy.
    const rid = parseIcsTime(recurrenceId.value, recurrenceId.params);
    if (rid) overridden.set(uid, [...(overridden.get(uid) ?? []), rid]);
  }
  if (!start) return null;
  if (get("STATUS")?.value.trim().toUpperCase() === "CANCELLED") return null;
  if (get("TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT") return null;

  const dtend = get("DTEND");
  const end = dtend ? parseIcsTime(dtend.value, dtend.params) : null;
  const duration = get("DURATION") ? parseDuration(get("DURATION")!.value) : null;
  let durationMs = 0;
  let days = 0;
  if (start.allDay) {
    days = end?.allDay ? dayNumber(end.date) - dayNumber(start.date) : duration !== null ? Math.round(duration / DAY_MS) : 1;
    if (days <= 0) return null;
  } else {
    durationMs = end && !end.allDay ? instantOf(end, "UTC") - instantOf(start, "UTC") : (duration ?? 0);
    if (durationMs <= 0) return null;
  }
  const rr = get("RRULE");
  const rrule = rr ? parseRRule(rr.value) ?? undefined : undefined;
  const exdates: IcsTime[] = [];
  for (const ex of props.filter((p) => p.name === "EXDATE")) {
    for (const v of ex.value.split(",")) {
      const t = parseIcsTime(v, ex.params);
      if (t) exdates.push(t);
    }
  }
  return { start, durationMs, days, ...(rrule ? { rrule } : {}), exdates, ...(uid ? { uid } : {}) };
}

/** Candidate start dates of a recurrence, ascending, starting at DTSTART. */
function* recurrenceDates(start: CivilDate, r: RRule): Generator<CivilDate> {
  const startDay = dayNumber(start);
  const plainDays = (r.byDay ?? []).filter((b) => b.n === 0).map((b) => b.wd);
  switch (r.freq) {
    case "DAILY":
      for (let k = 0; ; k++) {
        const c = fromDayNumber(startDay + k * r.interval);
        if (plainDays.length === 0 || plainDays.includes(weekdayOf(c))) yield c;
      }
    case "WEEKLY": {
      const monday = startDay - ((weekdayOf(start) + 6) % 7);
      const offsets = [...new Set((plainDays.length ? plainDays : [weekdayOf(start)]).map((wd) => (wd + 6) % 7))].sort((a, b) => a - b);
      for (let w = 0; ; w++) {
        for (const off of offsets) {
          const day = monday + w * 7 * r.interval + off;
          if (day >= startDay) yield fromDayNumber(day);
        }
      }
    }
    case "MONTHLY":
      for (let k = 0; ; k++) {
        const mi = start.m - 1 + k * r.interval;
        const y = start.y + Math.floor(mi / 12);
        const m = (mi % 12) + 1;
        const dim = daysInMonth(y, m);
        const ds = new Set<number>();
        if (r.byMonthDay?.length) for (const n of r.byMonthDay) ds.add(n > 0 ? n : dim + 1 + n);
        else if (r.byDay?.length) {
          for (const b of r.byDay) {
            const all: number[] = [];
            for (let d = 1; d <= dim; d++) if (weekdayOf({ y, m, d }) === b.wd) all.push(d);
            if (b.n === 0) all.forEach((d) => ds.add(d));
            else {
              const pick = b.n > 0 ? all[b.n - 1] : all[all.length + b.n];
              if (pick !== undefined) ds.add(pick);
            }
          }
        } else ds.add(start.d);
        for (const d of [...ds].sort((a, b) => a - b)) {
          if (d < 1 || d > dim) continue;
          const c = { y, m, d };
          if (dayNumber(c) >= startDay) yield c;
        }
      }
    case "YEARLY":
      for (let k = 0; ; k++) {
        const y = start.y + k * r.interval;
        if (start.d <= daysInMonth(y, start.m)) yield { y, m: start.m, d: start.d };
      }
  }
}

export interface Interval {
  start: number;
  end: number;
}

const MAX_RECURRENCE_STEPS = 20_000;

/** Busy intervals of one event that overlap [fromMs, toMs). */
export function occurrences(ev: BusyEvent, fromMs: number, toMs: number, localTz: string): Interval[] {
  const out: Interval[] = [];
  const at = (c: CivilDate): Interval => {
    const t: IcsTime = { ...ev.start, date: { ...ev.start.date, y: c.y, m: c.m, d: c.d } };
    const s = instantOf(t, localTz);
    const e = ev.start.allDay ? zonedToUtc(atMidnight(fromDayNumber(dayNumber(c) + ev.days)), localTz) : s + ev.durationMs;
    return { start: s, end: e };
  };
  const push = (iv: Interval): void => {
    if (iv.end > fromMs && iv.start < toMs) out.push(iv);
  };
  if (!ev.rrule) {
    push(at(ev.start.date));
    return out;
  }
  const r = ev.rrule;
  const untilMs = r.until ? (r.until.allDay ? zonedToUtc(atMidnight(fromDayNumber(dayNumber(r.until.date) + 1)), localTz) - 1 : instantOf(r.until, localTz)) : Infinity;
  const untilDay = r.until ? dayNumber(r.until.date) + 1 : Infinity;
  const excluded = new Set(ev.exdates.map((x) => (x.allDay || ev.start.allDay ? `d${dayNumber(x.date)}` : `t${instantOf(x, localTz)}`)));
  // Days well before the window are skipped without time-zone maths (unless COUNT needs them counted).
  const spanDays = ev.start.allDay ? ev.days : Math.ceil(ev.durationMs / DAY_MS);
  const firstUsefulDay = Math.floor(fromMs / DAY_MS) - 2 - spanDays;
  const lastDay = Math.floor(toMs / DAY_MS) + 2;
  let count = 0;
  let steps = 0;
  for (const c of recurrenceDates(ev.start.date, r)) {
    if (++steps > MAX_RECURRENCE_STEPS) break;
    const dn = dayNumber(c);
    if (dn > untilDay || dn > lastDay) break;
    count++;
    if (r.count !== undefined && count > r.count) break;
    if (dn < firstUsefulDay) continue;
    const iv = at(c);
    if (iv.start > untilMs) break;
    if (excluded.has(ev.start.allDay ? `d${dn}` : `t${iv.start}`)) continue;
    push(iv);
  }
  return out;
}

/** All busy intervals in [fromMs, toMs), sorted and merged. */
export function busyIntervals(cal: CalendarData, fromMs: number, toMs: number, localTz: string): Interval[] {
  const all = cal.events.flatMap((e) => occurrences(e, fromMs, toMs, localTz)).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of all) {
    const last = merged.at(-1);
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else merged.push({ ...iv });
  }
  return merged;
}

// MARK: Free slots

export interface SlotQuery {
  startDate: CivilDate;
  endDate: CivilDate;
  minMinutes: number;
  maxResults: number;
}
export interface SlotOptions {
  now: number;
  timeZone: string;
  /** Working hours, local time. */
  dayStartHour?: number;
  dayEndHour?: number;
  weekdaysOnly?: boolean;
  /** Slots start on these boundaries (minutes). */
  alignMinutes?: number;
}
export interface Slot extends Interval {
  label: string;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const clock = (p: CivilDateTime): { t: string; ap: string } => ({ t: `${p.h % 12 === 0 ? 12 : p.h % 12}:${pad(p.mi)}`, ap: p.h < 12 ? "am" : "pm" });
/** "Tue 24 Nov" */
export const dayLabel = (c: CivilDate): string => `${WEEKDAY_SHORT[weekdayOf(c)]} ${c.d} ${MONTH_SHORT[c.m - 1]}`;

/** "Tue 24 Nov, 3:00–4:00 pm" (local time; the meridiem is repeated only when it changes). */
export function slotLabel(start: number, end: number, tz: string): string {
  const a = zonedParts(start, tz);
  const b = zonedParts(end, tz);
  const ca = clock(a);
  const cb = clock(b);
  return `${dayLabel(a)}, ${ca.ap === cb.ap ? ca.t : `${ca.t} ${ca.ap}`}–${cb.t} ${cb.ap}`;
}

/**
 * Free slots of `minMinutes` within working hours, never in the past (≥ 1 h from now). Spreads across days:
 * the first free slot of each day comes first, then second slots, so two proposals are on different days.
 */
export function freeSlots(cal: CalendarData | null, q: SlotQuery, o: SlotOptions): Slot[] {
  const tz = o.timeZone;
  const align = (o.alignMinutes ?? 30) * MIN_MS;
  const len = q.minMinutes * MIN_MS;
  const startDay = dayNumber(q.startDate);
  const endDay = dayNumber(q.endDate);
  const from = zonedToUtc(atMidnight(q.startDate), tz);
  const to = zonedToUtc(atMidnight(fromDayNumber(endDay + 1)), tz);
  const busy = cal ? busyIntervals(cal, from, to, tz) : [];
  const earliest = o.now + 60 * MIN_MS;
  const perDay: Slot[][] = [];
  for (let dn = startDay; dn <= endDay; dn++) {
    const day = fromDayNumber(dn);
    const wd = weekdayOf(day);
    if ((o.weekdaysOnly ?? true) && (wd === 0 || wd === 6)) continue;
    const ws = Math.max(zonedToUtc({ ...day, h: o.dayStartHour ?? 9, mi: 0, s: 0 }, tz), earliest);
    const we = zonedToUtc({ ...day, h: o.dayEndHour ?? 17, mi: 0, s: 0 }, tz);
    const slots: Slot[] = [];
    let cursor = ws;
    for (const b of [...busy.filter((x) => x.end > ws && x.start < we), { start: we, end: we }]) {
      const s = Math.ceil(cursor / align) * align;
      if (s + len <= Math.min(b.start, we)) slots.push({ start: s, end: s + len, label: slotLabel(s, s + len, tz) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= we) break;
    }
    if (slots.length) perDay.push(slots);
  }
  const picked: Slot[] = [];
  for (let round = 0; picked.length < q.maxResults && perDay.some((d) => d.length > round); round++) {
    for (const d of perDay) {
      const s = d[round];
      if (s && picked.length < q.maxResults) picked.push(s);
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

// MARK: The tools

/** Everything a tool may read. Raw values in `entities` must never appear in a tool's output (the gate checks). */
export interface ToolContext {
  now: number;
  /** The user's IANA zone (local computations only — it is never sent). */
  timeZone: string;
  entities: EntityMap;
  calendar: CalendarData | null;
}

export type ToolPayload = Record<string, unknown>;

export interface PrivateTool {
  readonly name: ToolName;
  readonly declaration: ToolDeclaration;
  /** Consent-card copy for this call: what Gemini asked for, and exactly what would be shared. */
  describe(args: Record<string, unknown>, ctx: ToolContext): { title: string; shares: string };
  run(args: Record<string, unknown>, ctx: ToolContext): ToolPayload;
}

function weekOf(today: CivilDate, offsetWeeks: number): { start: CivilDate; end: CivilDate } {
  const monday = dayNumber(today) - ((weekdayOf(today) + 6) % 7) + offsetWeeks * 7;
  return { start: fromDayNumber(monday), end: fromDayNumber(monday + 6) };
}
const todayIn = (ctx: ToolContext): CivilDate => zonedParts(ctx.now, ctx.timeZone);

/** Monday–Friday of next week as ISO dates, in `tz`. */
export function nextWorkWeek(now: number, tz: string): { start: string; end: string; monday: CivilDate } {
  const w = weekOf(zonedParts(now, tz), 1);
  return { start: isoDate(w.start), end: isoDate(fromDayNumber(dayNumber(w.start) + 4)), monday: w.start };
}
const dayEntry = (c: CivilDate): string => `${WEEKDAY_SHORT[weekdayOf(c)]} ${isoDate(c)}`;

export const DateContextTool: PrivateTool = {
  name: "today_context",
  declaration: TOOL_DECLARATIONS.today_context,
  describe: () => ({ title: "Gemini wants to know today’s date", shares: "Today’s date and weekday, so it can work out dates like “next Tuesday”. Not your location or time zone." }),
  run: (_args, ctx) => {
    const today = todayIn(ctx);
    const tw = weekOf(today, 0);
    const nw = weekOf(today, 1);
    const upcoming = Array.from({ length: 14 }, (_, i) => dayEntry(fromDayNumber(dayNumber(today) + 1 + i)));
    return { today: isoDate(today), weekday: WEEKDAY_LONG[weekdayOf(today)], this_week: `${dayEntry(tw.start)} to ${dayEntry(tw.end)}`, next_week: `${dayEntry(nw.start)} to ${dayEntry(nw.end)}`, upcoming };
  },
};

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/** Validated, clamped query: never before today, at most 31 days, 15–240 minutes, 1–5 results. */
export function slotQueryFrom(args: Record<string, unknown>, ctx: ToolContext): SlotQuery | null {
  const s = parseIsoDate(args["start_date"]);
  const e = parseIsoDate(args["end_date"]);
  if (!s || !e || dayNumber(e) < dayNumber(s)) return null;
  const today = dayNumber(todayIn(ctx));
  const startDay = Math.max(dayNumber(s), today);
  const endDay = Math.min(dayNumber(e), startDay + 30);
  if (endDay < startDay) return null;
  return { startDate: fromDayNumber(startDay), endDate: fromDayNumber(endDay), minMinutes: clampInt(args["min_minutes"], 15, 240, 30), maxResults: clampInt(args["max_results"], 1, 5, 3) };
}

function rangePhrase(q: SlotQuery, ctx: ToolContext): string {
  const today = todayIn(ctx);
  for (const [offset, name] of [[0, "this week"], [1, "next week"]] as const) {
    const w = weekOf(today, offset);
    const s = dayNumber(q.startDate);
    const e = dayNumber(q.endDate);
    if (s >= dayNumber(w.start) && e <= dayNumber(w.end) && e - s >= 3) return name;
  }
  return dayNumber(q.startDate) === dayNumber(q.endDate) ? `on ${dayLabel(q.startDate)}` : `from ${dayLabel(q.startDate)} to ${dayLabel(q.endDate)}`;
}

export const CalendarTool: PrivateTool = {
  name: "find_free_slots",
  declaration: TOOL_DECLARATIONS.find_free_slots,
  describe: (args, ctx) => {
    const q = slotQueryFrom(args, ctx);
    return {
      title: q ? `Gemini wants to check your free time ${rangePhrase(q, ctx)}` : "Gemini wants to check your free time",
      shares: `Up to ${q?.maxResults ?? 3} free ${q ? `${q.minMinutes}-minute ` : ""}slots from the calendar you imported. Never event names, places or who you’re meeting.`,
    };
  },
  run: (args, ctx) => {
    if (!ctx.calendar) return { error: "no_calendar", message: "The user hasn't shared a calendar. Suggest times without it." };
    const q = slotQueryFrom(args, ctx);
    if (!q) return { error: "invalid_dates", message: "Use ISO dates (YYYY-MM-DD), start on or before end." };
    const slots = freeSlots(ctx.calendar, q, { now: ctx.now, timeZone: ctx.timeZone });
    return slots.length
      ? { slots: slots.map((s) => s.label), duration_minutes: q.minMinutes, note: "Times are in the user's local time." }
      : { slots: [], note: "The user has no free time of that length in that range." };
  },
};

const CATEGORY_NOUN: Record<PrivacyCategory, string> = { person: "Person", org: "Organisation", location: "Place", contact: "Contact", id: "ID", date: "Date", health: "Health detail", secret: "Secret", quasi: "Detail" };

function placeholderOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().replace(/^\[\[|\]\]$/g, "").toUpperCase();
  return parsePlaceholderId(id) ? id : null;
}
/** A role hint in third person ("my landlord" → "the user's landlord"). */
const thirdPerson = (role: string): string => role.trim().replace(/^my\b/i, "the user's").replace(/^me$/i, "the user");

export const EntityRoleTool: PrivateTool = {
  name: "get_entity_role",
  declaration: TOOL_DECLARATIONS.get_entity_role,
  describe: (args, ctx) => {
    const id = placeholderOf(args["placeholder"]);
    const e = id ? ctx.entities.get(id) : undefined;
    const label = e ? (e.id === "PERSON_ME" ? "you" : `${CATEGORY_NOUN[e.category]} ${e.id.split("_")[1]}`) : "a placeholder";
    return { title: `Gemini wants more context about ${label}`, shares: e?.roleHint ? `Only the role you see on the chip (“${thirdPerson(e.roleHint)}”). Never the real name or detail.` : "Only the kind of detail it is. Never the real name or detail." };
  },
  run: (args, ctx) => {
    const id = placeholderOf(args["placeholder"]);
    const e = id ? ctx.entities.get(id) : undefined;
    if (!id || !e) return { error: "unknown_placeholder" };
    if (e.id === "PERSON_ME") return { placeholder: idToken(id), kind: "person", role: "the user — the person you are helping" };
    return { placeholder: idToken(id), kind: e.category, role: e.roleHint ? thirdPerson(e.roleHint) : "no further context available" };
  },
};

export const ALL_TOOLS: readonly PrivateTool[] = [DateContextTool, EntityRoleTool, CalendarTool];

// MARK: Consent

export type ConsentDecision = "allow" | "deny";
export interface ConsentRequest {
  id: string;
  tool: ToolName;
  title: string;
  shares: string;
}
/** Asks the user. The UI shows a card ("Allow once" / "Don't allow") and resolves the promise. */
export interface ConsentBroker {
  request(req: ConsentRequest): Promise<ConsentDecision>;
}

// MARK: The tool loop

export type ToolStatus = "asking" | "allowed" | "declined" | "withheld" | "invalid" | "limit";
/** One tool call as the user sees it afterwards. `shared` is the exact JSON returned to Gemini (gate-checked). */
export interface ToolActivity {
  id: string;
  tool: string;
  title: string;
  status: ToolStatus;
  shared: string | null;
}

export const DECLINED: ToolPayload = { error: "user_declined" };
export const WITHHELD: ToolPayload = { error: "withheld", message: "This result contained private details, so it was not shared." };
const LIMIT: ToolPayload = { error: "tool_limit_reached", message: "Answer now without more tools." };

export interface ToolLoopArgs {
  engine: ToolEngine;
  tools: readonly PrivateTool[];
  context: ToolContext;
  gate: EgressGate;
  broker: ConsentBroker;
  /** Rounds of tool calls (each may hold several parallel calls) before the model must answer. */
  maxRounds: number;
  addendum: string;
  sealed: SealedText;
  task: TaskSpec;
  history?: SealedHistory;
  alwaysAllow?: ReadonlySet<ToolName>;
  onText?: (cumulative: string) => void;
  onActivity?: (activity: ToolActivity[]) => void;
}
export interface ToolLoopResult {
  text: string;
  modelVersion: string;
  ranOnDevice: boolean;
  rounds: number;
  activity: ToolActivity[];
}

/**
 * Runs one sealed request with private tools (port target of ToolLoop.swift). Parallel calls in a turn
 * run concurrently (their consent cards show together). A tool the user declined is declined again,
 * silently, for the rest of this answer. After `maxRounds` the model gets `tool_limit_reached` and must
 * answer. Every function response — results, refusals, errors — is sealed by the gate (INV-5); a result
 * the gate blocks is replaced by `WITHHELD`, so private text never reaches the engine.
 */
export async function runToolLoop(a: ToolLoopArgs): Promise<ToolLoopResult> {
  const chat = a.engine.chat(a.tools.map((t) => t.declaration), a.addendum);
  const activity: ToolActivity[] = [];
  const declined = new Set<string>();
  const publish = (): void => a.onActivity?.(activity.map((x) => ({ ...x })));
  let seq = 0;

  const seal = (call: ToolCall, payload: ToolPayload): { response: SealedToolResponse; withheld: boolean } => {
    const respond = (p: ToolPayload): SealedToolResponse => ({ ...(call.id ? { id: call.id } : {}), name: call.name, sealed: a.gate.sealToolResult(JSON.stringify(p), a.context.entities) });
    try {
      return { response: respond(payload), withheld: false };
    } catch (e) {
      if (e instanceof GateBlocked) return { response: respond(WITHHELD), withheld: true };
      throw e;
    }
  };

  const execute = async (call: ToolCall): Promise<SealedToolResponse> => {
    const id = `tool-${++seq}`;
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
    const tool = a.tools.find((t) => t.name === call.name);
    if (!tool) {
      const { response } = seal(call, { error: "unknown_tool" });
      activity.push({ id, tool: call.name.slice(0, 64), title: "Gemini asked for a tool Airlock doesn’t have", status: "invalid", shared: response.sealed.value });
      publish();
      return response;
    }
    const desc = tool.describe(args, a.context);
    const act: ToolActivity = { id, tool: tool.name, title: desc.title, status: "asking", shared: null };
    activity.push(act);
    publish();
    let decision: ConsentDecision;
    if (declined.has(tool.name)) decision = "deny";
    else if (a.alwaysAllow?.has(tool.name)) decision = "allow";
    else decision = await a.broker.request({ id, tool: tool.name, title: desc.title, shares: desc.shares });
    let payload: ToolPayload;
    if (decision === "deny") {
      declined.add(tool.name);
      payload = DECLINED;
      act.status = "declined";
    } else {
      try {
        payload = tool.run(args, a.context);
        act.status = "allowed";
      } catch {
        payload = { error: "tool_failed" };
        act.status = "invalid";
      }
    }
    const { response, withheld } = seal(call, payload);
    if (withheld) act.status = "withheld";
    act.shared = response.sealed.value;
    publish();
    return response;
  };

  let turn = await chat.send(a.sealed, a.task, a.history, a.onText);
  let rounds = 0;
  while (turn.calls.length > 0) {
    if (rounds >= a.maxRounds) {
      const results = turn.calls.map((c) => {
        const { response } = seal(c, LIMIT);
        activity.push({ id: `tool-${++seq}`, tool: c.name.slice(0, 64), title: "Gemini asked for more than Airlock allows in one answer", status: "limit", shared: response.sealed.value });
        return response;
      });
      publish();
      turn = await chat.respond(results, a.onText);
      break;
    }
    rounds++;
    const results = await Promise.all(turn.calls.map(execute));
    turn = await chat.respond(results, a.onText);
  }
  if (!turn.text.trim()) throw new EngineError("other", "tool-loop-no-answer");
  return { text: turn.text, modelVersion: turn.modelVersion, ranOnDevice: turn.ranOnDevice, rounds, activity };
}

/** Minimal async queue: bridges callback events into an async generator. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private failWaiting: ((e: unknown) => void) | null = null;
  private closed = false;
  private error: unknown = null;

  push(v: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = this.failWaiting = null;
      w({ value: v, done: false });
    } else this.items.push(v);
  }
  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error ?? null;
    if (this.waiting) {
      const w = this.waiting;
      const f = this.failWaiting;
      this.waiting = this.failWaiting = null;
      if (error !== undefined && f) f(error);
      else w({ value: undefined as never, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return this.error !== null ? Promise.reject(this.error) : Promise.resolve({ value: undefined as never, done: true });
        return new Promise((ok, fail) => {
          this.waiting = ok;
          this.failWaiting = fail;
        });
      },
    };
  }
}
