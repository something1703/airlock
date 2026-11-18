// A fictional calendar for trying "Propose a meeting time" without real data (Settings → Private tools,
// demo mode). Built relative to today so "next week" always has a believable mix of busy and free time.
// Floating local times, so it reads the same in every time zone.
import { dayNumber, fromDayNumber, nextWorkWeek, type CivilDate } from "../engine/tools";

const stamp = (c: CivilDate, h: number, mi = 0): string => `${c.y}${String(c.m).padStart(2, "0")}${String(c.d).padStart(2, "0")}T${String(h).padStart(2, "0")}${String(mi).padStart(2, "0")}00`;
const date = (c: CivilDate): string => stamp(c, 0).slice(0, 8);

export function sampleCalendarIcs(now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): string {
  const mon = nextWorkWeek(now, tz).monday;
  const day = (offset: number): CivilDate => fromDayNumber(dayNumber(mon) + offset);
  const ev = (uid: string, summary: string, start: string, end: string, extra: string[] = []): string[] => ["BEGIN:VEVENT", `UID:${uid}@sample.airlock`, `DTSTART${start.length === 8 ? ";VALUE=DATE" : ""}:${start}`, `DTEND${end.length === 8 ? ";VALUE=DATE" : ""}:${end}`, `SUMMARY:${summary}`, ...extra, "END:VEVENT"];
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Airlock//Sample calendar (fictional)//EN",
    ...ev("standup", "Team stand-up", stamp(day(-7), 9), stamp(day(-7), 9, 30), ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]),
    ...ev("workshop", "Planning workshop", stamp(day(0), 9, 30), stamp(day(0), 17)),
    ...ev("dentist", "Dentist", stamp(day(1), 10), stamp(day(1), 11, 30)),
    ...ev("review", "Design review", stamp(day(1), 13), stamp(day(1), 15)),
    ...ev("focus", "Focus time", stamp(day(2), 9, 30), stamp(day(2), 14)),
    ...ev("away", "Day off", date(day(3)), date(day(4))),
    ...ev("lunch", "Lunch with a friend", stamp(day(4), 12), stamp(day(4), 13, 30)),
    ...ev("call", "Weekly call", stamp(day(4), 15), stamp(day(4), 17)),
    "END:VCALENDAR",
  ].join("\r\n");
}
