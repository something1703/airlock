import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS, CalendarTool, DateContextTool, DECLINED, EgressGate, EntityMap, EntityRoleTool, MockToolEngine, PatternDetector, PromptLibrary, ReceiptLedger, WITHHELD,
  answer, busyIntervals, freeSlots, makeEntity, parseDuration, parseIcs, runToolLoop, slotLabel, zonedToUtc,
  type AnswerEvent, type AnswerOutcome, type CalendarData, type ConsentBroker, type ConsentRequest, type PrivateTool, type SealDraft, type SealedText, type ToolContext, type VaultEntry,
} from "../src/engine";
import type { TaskSpec } from "../src/engine/engines";
import { MockEngines } from "../src/engine/mocks";

const patterns = new PatternDetector();
const prompts = new PromptLibrary();
const vault: VaultEntry[] = [{ id: "raj", canonical: "Raj Patel", aliases: ["Raj"], category: "person", roleHint: "my landlord", isUser: false }];
const entities = new EntityMap([
  makeEntity({ id: "PERSON_1", category: "person", canonical: "Raj Patel", sources: new Set(["vault"]), confidence: "high", roleHint: "my landlord", vaultEntryId: "raj" }),
  makeEntity({ id: "PERSON_ME", category: "person", canonical: "Maya Chen", sources: new Set(["vault"]), confidence: "high", roleHint: "me" }),
]);
const gate = new EgressGate(patterns, vault);
const TASK: TaskSpec = { id: "task.reply.v1", instruction: "Draft a reply." };
const ms = (iso: string): number => Date.parse(iso);

function sealed(text = "Hi [[PERSON_1]], can we meet next week to talk about the heater?"): SealedText {
  const draft: SealDraft = { text, legend: [{ placeholder: "PERSON_1", description: "the writer's landlord" }], replacements: [], entities, secretWarnings: [], revealedVaultIds: new Set(), keptValues: new Set() };
  return gate.seal(draft);
}

/** Fictional calendar for the week of Mon 23 Nov 2026 (UTC times). */
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Airlock tests//EN",
  "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19701101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD", "END:VTIMEZONE",
  // Daily stand-up 9:00–9:30 UTC, Mon–Fri, from the 2nd; skipped on Wed 25th.
  "BEGIN:VEVENT", "UID:standup-1", "DTSTART:20261102T090000Z", "DTEND:20261102T093000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "EXDATE:20261125T090000Z",
  "SUMMARY:Stand-up with Raj Patel", "ATTENDEE;CN=Raj Patel:mailto:raj@example.com", "END:VEVENT",
  // Mon 23: busy 9:30–17:00 UTC (whole working day).
  "BEGIN:VEVENT", "UID:a", "DTSTART:20261123T093000Z", "DTEND:20261123T170000Z", "SUMMARY:Offsite at Mercy General", "LOCATION:14 Elm St", "END:VEVENT",
  // Tue 24: 10:00–15:00 New York = 15:00–20:00 UTC → free 9:30–15:00 UTC.
  "BEGIN:VEVENT", "UID:b", "DTSTART;TZID=America/New_York:20261124T100000", "DTEND;TZID=America/New_York:20261124T150000", "SUMMARY:Doctor", "END:VEVENT",
  // Thu 26: all-day (blocks the day).
  "BEGIN:VEVENT", "UID:c", "DTSTART;VALUE=DATE:20261126", "DTEND;VALUE=DATE:20261127", "SUMMARY:Holiday", "END:VEVENT",
  // Fri 27: cancelled and transparent events don't block.
  "BEGIN:VEVENT", "UID:d", "DTSTART:20261127T093000Z", "DURATION:PT7H", "STATUS:CANCELLED", "SUMMARY:Cancelled", "END:VEVENT",
  "BEGIN:VEVENT", "UID:e", "DTSTART:20261127T093000Z", "DURATION:PT7H", "TRANSP:TRANSPARENT", "SUMMARY:Focus (free)", "END:VEVENT",
  // Wed 25: lunch 12:00–13:00 UTC, folded line, with an alarm (nested component ignored).
  "BEGIN:VEVENT", "UID:f", "DTSTART:20261125T120000Z", "DTEND:20261125T13", " 0000Z", "BEGIN:VALARM", "TRIGGER:-PT15M", "DTSTART:20990101T000000Z", "END:VALARM", "SUMMARY:Lunch", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ now: ms("2026-11-18T10:00:00Z"), timeZone: "UTC", entities, calendar: parseIcs(ICS), ...over });

describe(".ics parsing", () => {
  it("keeps only timing: titles, places and attendees are never read or stored", () => {
    const cal = parseIcs(ICS);
    const stored = JSON.stringify(cal);
    for (const leak of ["Raj", "Mercy", "Elm", "Doctor", "Holiday", "Lunch", "example.com", "Stand-up"]) expect(stored).not.toContain(leak);
    expect(cal.events).toHaveLength(5);
    expect(cal.skipped).toBe(2);
  });
  it("UTC, TZID, all-day, DURATION and folded lines resolve to the right instants", () => {
    const cal = parseIcs(ICS);
    const busy = busyIntervals(cal, ms("2026-11-23T00:00:00Z"), ms("2026-11-28T00:00:00Z"), "UTC").map((b) => [new Date(b.start).toISOString(), new Date(b.end).toISOString()]);
    expect(busy).toEqual([
      ["2026-11-23T09:00:00.000Z", "2026-11-23T17:00:00.000Z"], // stand-up + offsite merged
      ["2026-11-24T09:00:00.000Z", "2026-11-24T09:30:00.000Z"],
      ["2026-11-24T15:00:00.000Z", "2026-11-24T20:00:00.000Z"], // New York EST = UTC−5
      ["2026-11-25T12:00:00.000Z", "2026-11-25T13:00:00.000Z"], // stand-up EXDATE'd
      ["2026-11-26T00:00:00.000Z", "2026-11-27T00:00:00.000Z"], // all-day
      ["2026-11-27T09:00:00.000Z", "2026-11-27T09:30:00.000Z"], // cancelled + transparent ignored
    ]);
  });
  it("RRULE basics: DAILY with INTERVAL and COUNT, WEEKLY with UNTIL, MONTHLY by ordinal weekday, RECURRENCE-ID moves an occurrence", () => {
    const ics = (body: string[]): CalendarData => parseIcs(["BEGIN:VCALENDAR", ...body, "END:VCALENDAR"].join("\n"));
    const days = (cal: CalendarData, from: string, to: string): string[] => busyIntervals(cal, ms(from), ms(to), "UTC").map((b) => new Date(b.start).toISOString().slice(0, 16));
    const daily = ics(["BEGIN:VEVENT", "DTSTART:20261101T080000Z", "DTEND:20261101T083000Z", "RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3", "END:VEVENT"]);
    expect(days(daily, "2026-10-01T00:00:00Z", "2026-12-31T00:00:00Z")).toEqual(["2026-11-01T08:00", "2026-11-03T08:00", "2026-11-05T08:00"]);
    const weekly = ics(["BEGIN:VEVENT", "DTSTART:20261104T140000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;UNTIL=20261118T235959Z", "END:VEVENT"]);
    expect(days(weekly, "2026-11-01T00:00:00Z", "2026-12-31T00:00:00Z")).toEqual(["2026-11-04T14:00", "2026-11-11T14:00", "2026-11-18T14:00"]);
    const monthly = ics(["BEGIN:VEVENT", "DTSTART:20260901T100000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4", "END:VEVENT"]);
    expect(days(monthly, "2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z")).toEqual(["2026-09-25T10:00", "2026-10-30T10:00", "2026-11-27T10:00", "2026-12-25T10:00"]);
    const moved = ics([
      "BEGIN:VEVENT", "UID:x", "DTSTART:20261123T100000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=3", "END:VEVENT",
      "BEGIN:VEVENT", "UID:x", "RECURRENCE-ID:20261124T100000Z", "DTSTART:20261124T160000Z", "DURATION:PT1H", "END:VEVENT",
    ]);
    expect(days(moved, "2026-11-23T00:00:00Z", "2026-11-26T00:00:00Z")).toEqual(["2026-11-23T10:00", "2026-11-24T16:00", "2026-11-25T10:00"]);
  });
  it("floating times and all-day events follow the user's zone; DST is respected", () => {
    const cal = parseIcs(["BEGIN:VEVENT", "DTSTART:20261123T090000", "DURATION:PT1H", "END:VEVENT", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261124", "END:VEVENT"].join("\n"));
    const b = busyIntervals(cal, ms("2026-11-20T00:00:00Z"), ms("2026-11-30T00:00:00Z"), "Asia/Kolkata");
    expect(new Date(b[0]!.start).toISOString()).toBe("2026-11-23T03:30:00.000Z");
    expect(new Date(b[1]!.start).toISOString()).toBe("2026-11-23T18:30:00.000Z");
    expect(zonedToUtc({ y: 2026, m: 7, d: 1, h: 9, mi: 0, s: 0 }, "Europe/London")).toBe(ms("2026-07-01T08:00:00Z"));
    expect(zonedToUtc({ y: 2026, m: 12, d: 1, h: 9, mi: 0, s: 0 }, "Europe/London")).toBe(ms("2026-12-01T09:00:00Z"));
  });
  it("tolerates junk: unknown lines, bad dates, negative durations, no calendar wrapper", () => {
    const cal = parseIcs("hello\nBEGIN:VEVENT\nDTSTART:2026-11-23\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20261123T100000Z\nDURATION:-PT1H\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20261123T100000Z\nDTEND:20261123T110000Z\nRRULE:FREQ=SECONDLY\nEND:VEVENT");
    expect(cal.events).toHaveLength(1);
    expect(cal.skipped).toBe(2);
    expect(parseDuration("P1W")).toBe(7 * 86_400_000);
    expect(parseDuration("PT1H30M")).toBe(90 * 60_000);
  });
});

describe("free slots", () => {
  it("finds real free times next week, one per day first, never during events", () => {
    const c = ctx();
    const slots = freeSlots(c.calendar, { startDate: { y: 2026, m: 11, d: 23 }, endDate: { y: 2026, m: 11, d: 29 }, minMinutes: 60, maxResults: 3 }, { now: c.now, timeZone: "UTC" });
    expect(slots.map((s) => s.label)).toEqual(["Tue 24 Nov, 9:30–10:30 am", "Wed 25 Nov, 9:00–10:00 am", "Fri 27 Nov, 9:30–10:30 am"]);
    const busy = busyIntervals(c.calendar!, ms("2026-11-23T00:00:00Z"), ms("2026-11-30T00:00:00Z"), "UTC");
    for (const s of slots) for (const b of busy) expect(s.end <= b.start || s.start >= b.end).toBe(true);
  });
  it("second slots fill in when there are fewer days than results; past times and weekends are skipped", () => {
    const now = ms("2026-11-24T11:10:00Z");
    const slots = freeSlots(parseIcs(ICS), { startDate: { y: 2026, m: 11, d: 24 }, endDate: { y: 2026, m: 11, d: 25 }, minMinutes: 30, maxResults: 4 }, { now, timeZone: "UTC" });
    expect(slots.map((s) => s.label)).toEqual(["Tue 24 Nov, 12:30–1:00 pm", "Wed 25 Nov, 9:00–9:30 am", "Wed 25 Nov, 1:00–1:30 pm"]);
    expect(slots.every((s) => s.start >= now + 3_600_000)).toBe(true);
    expect(freeSlots(null, { startDate: { y: 2026, m: 11, d: 28 }, endDate: { y: 2026, m: 11, d: 29 }, minMinutes: 30, maxResults: 3 }, { now, timeZone: "UTC" })).toEqual([]);
  });
  it("labels are local time with the meridiem repeated only when it changes", () => {
    expect(slotLabel(ms("2026-11-24T11:30:00Z"), ms("2026-11-24T12:30:00Z"), "UTC")).toBe("Tue 24 Nov, 11:30 am–12:30 pm");
    expect(slotLabel(ms("2026-11-24T15:00:00Z"), ms("2026-11-24T16:00:00Z"), "America/New_York")).toBe("Tue 24 Nov, 10:00–11:00 am");
  });
});

describe("the private tools", () => {
  it("today_context: dates for scheduling, no time zone or location", () => {
    const out = DateContextTool.run({}, ctx({ timeZone: "America/Chicago" }));
    expect(out).toMatchObject({ today: "2026-11-18", weekday: "Wednesday", next_week: "Mon 2026-11-23 to Sun 2026-11-29" });
    expect(JSON.stringify(out)).not.toMatch(/Chicago|America|UTC|GMT/);
    expect(() => gate.sealToolResult(JSON.stringify(out), entities)).not.toThrow();
  });
  it("find_free_slots: only time ranges; validated and clamped; gate-clean", () => {
    const out = CalendarTool.run({ start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60, max_results: 2 }, ctx());
    expect(out).toEqual({ slots: ["Tue 24 Nov, 9:30–10:30 am", "Wed 25 Nov, 9:00–10:00 am"], duration_minutes: 60, note: "Times are in the user's local time." });
    expect(() => gate.sealToolResult(JSON.stringify(out), entities)).not.toThrow();
    expect(CalendarTool.run({ start_date: "next week", end_date: "2026-11-27", min_minutes: 60 }, ctx())).toMatchObject({ error: "invalid_dates" });
    expect(CalendarTool.run({ start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60 }, ctx({ calendar: null }))).toMatchObject({ error: "no_calendar" });
    expect(CalendarTool.describe({ start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60 }, ctx()).title).toBe("Gemini wants to check your free time next week");
  });
  it("get_entity_role: the role, never the name", () => {
    const out = EntityRoleTool.run({ placeholder: "[[PERSON_1]]" }, ctx());
    expect(out).toEqual({ placeholder: "[[PERSON_1]]", kind: "person", role: "the user's landlord" });
    expect(JSON.stringify(out)).not.toContain("Raj");
    expect(() => gate.sealToolResult(JSON.stringify(out), entities)).not.toThrow();
    expect(EntityRoleTool.run({ placeholder: "PERSON_9" }, ctx())).toEqual({ error: "unknown_placeholder" });
    expect(EntityRoleTool.describe({ placeholder: "PERSON_1" }, ctx()).title).toBe("Gemini wants more context about Person 1");
  });
});

/** A broker that records requests and answers them with `decide` (optionally only once `waitFor` requests are open). */
function broker(decide: (r: ConsentRequest) => "allow" | "deny", waitFor = 1): ConsentBroker & { requests: ConsentRequest[]; maxOpen: number } {
  const requests: ConsentRequest[] = [];
  const pending: (() => void)[] = [];
  const b = {
    requests, maxOpen: 0,
    request(r: ConsentRequest) {
      requests.push(r);
      return new Promise<"allow" | "deny">((ok) => {
        pending.push(() => ok(decide(r)));
        b.maxOpen = Math.max(b.maxOpen, pending.length);
        if (pending.length >= waitFor) pending.splice(0).forEach((f) => f());
      });
    },
  };
  return b;
}

const MEETING = (results: string[]): string =>
  results.some((r) => r.includes("slots"))
    ? `Hi [[PERSON_1]], could we meet ${JSON.parse(results.find((r) => r.includes("slots"))!).slots.slice(0, 2).join(" or ")}?\n\n[[PERSON_ME]]`
    : "Hi [[PERSON_1]], could we find a time next week to talk about the heater? Let me know what suits you.\n\n[[PERSON_ME]]";

function meetingEngine(): MockToolEngine {
  return new MockToolEngine((round, { results }) => {
    if (round === 0) return { calls: [{ id: "c1", name: "today_context", args: {} }, { id: "c2", name: "find_free_slots", args: { start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60 } }] };
    return { text: MEETING(results.map((r) => r.sealed.value)) };
  });
}

describe("ToolLoop", () => {
  it("parallel calls: both consent cards are open together; results return in call order with ids; real slots reach the draft", async () => {
    const engine = meetingEngine();
    const b = broker(() => "allow", 2);
    const res = await runToolLoop({ engine, tools: ALL_TOOLS, context: ctx(), gate, broker: b, maxRounds: 3, addendum: "tools", sealed: sealed(), task: TASK });
    expect(b.maxOpen).toBe(2);
    expect(engine.responses[0]!.map((r) => [r.id, r.name])).toEqual([["c1", "today_context"], ["c2", "find_free_slots"]]);
    expect(res.text).toContain("Tue 24 Nov, 9:30–10:30 am or Wed 25 Nov, 9:00–10:00 am");
    expect(res.rounds).toBe(1);
    expect(res.activity.map((a) => a.status)).toEqual(["allowed", "allowed"]);
    expect(res.activity[1]!.shared).toBe(engine.sentResults[1]);
    expect(engine.declarations[0]!.map((d) => d.name)).toEqual(["today_context", "get_entity_role", "find_free_slots"]);
  });

  it("declining consent returns user_declined, the draft still works, and the tool isn't asked again this answer", async () => {
    let round2Calls = 0;
    const engine = new MockToolEngine((round, { results }) => {
      if (round === 0) return { calls: [{ name: "find_free_slots", args: { start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60 } }] };
      if (round === 1) {
        round2Calls++;
        return { calls: [{ name: "find_free_slots", args: { start_date: "2026-11-30", end_date: "2026-12-04", min_minutes: 60 } }] };
      }
      return { text: MEETING(results.map((r) => r.sealed.value)) };
    });
    const b = broker(() => "deny");
    const res = await runToolLoop({ engine, tools: ALL_TOOLS, context: ctx(), gate, broker: b, maxRounds: 3, addendum: "tools", sealed: sealed(), task: TASK });
    expect(b.requests).toHaveLength(1);
    expect(round2Calls).toBe(1);
    expect(engine.sentResults).toEqual([JSON.stringify(DECLINED), JSON.stringify(DECLINED)]);
    expect(res.text).toContain("could we find a time next week");
    expect(res.activity.map((a) => a.status)).toEqual(["declined", "declined"]);
  });

  it("max rounds: after N rounds the model is told to answer; the loop always ends", async () => {
    const engine = new MockToolEngine((round, { results }) => (results.some((r) => r.sealed.value.includes("tool_limit_reached")) ? { text: "Here is a draft for [[PERSON_1]]." } : { calls: [{ name: "today_context", args: {} }] }));
    const b = broker(() => "allow");
    const res = await runToolLoop({ engine, tools: ALL_TOOLS, context: ctx(), gate, broker: b, maxRounds: 2, addendum: "tools", sealed: sealed(), task: TASK });
    expect(res.rounds).toBe(2);
    expect(b.requests).toHaveLength(2);
    expect(engine.responses).toHaveLength(3);
    expect(res.activity.at(-1)!.status).toBe("limit");
    expect(res.text).toBe("Here is a draft for [[PERSON_1]].");

    const stubborn = new MockToolEngine(() => ({ calls: [{ name: "today_context", args: {} }] }));
    await expect(runToolLoop({ engine: stubborn, tools: ALL_TOOLS, context: ctx(), gate, broker: b, maxRounds: 1, addendum: "", sealed: sealed(), task: TASK })).rejects.toMatchObject({ code: "other" });
  });

  it("INV-5: a tool result containing a Vault name is blocked by the gate and never reaches the engine", async () => {
    const leaky: PrivateTool = { ...CalendarTool, run: () => ({ slots: ["Tue 24 Nov, 3:00–4:00 pm"], busy_with: "Stand-up with Raj Patel" }) };
    const sneaky: PrivateTool = { ...EntityRoleTool, run: () => ({ role: "landlord, phone 312-555-0147, rаj@example.com" }) };
    const engine = new MockToolEngine((round) => (round === 0 ? { calls: [{ name: "find_free_slots", args: { start_date: "2026-11-23", end_date: "2026-11-27", min_minutes: 60 } }, { name: "get_entity_role", args: { placeholder: "[[PERSON_1]]" } }] } : { text: "Hi [[PERSON_1]], when suits you?" }));
    const res = await runToolLoop({ engine, tools: [leaky, sneaky], context: ctx(), gate, broker: broker(() => "allow"), maxRounds: 3, addendum: "", sealed: sealed(), task: TASK });
    const sent = [...engine.received.map((s) => s.value), ...engine.sentResults].join("\n");
    for (const leak of ["Raj", "312-555", "example.com", "Stand-up"]) expect(sent).not.toContain(leak);
    expect(engine.sentResults).toEqual([JSON.stringify(WITHHELD), JSON.stringify(WITHHELD)]);
    expect(res.activity.map((a) => a.status)).toEqual(["withheld", "withheld"]);
    // Every function response is a gate-made SealedText.
    for (const r of engine.responses.flat()) expect(r.sealed.gateReport.checksPassed).toHaveLength(7);
  });

  it("unknown tools, bad arguments and failing tools return errors, not crashes", async () => {
    const broken: PrivateTool = { ...DateContextTool, run: () => { throw new Error("Raj Patel"); } };
    const engine = new MockToolEngine((round) => (round === 0 ? { calls: [{ name: "send_email", args: {} }, { name: "today_context", args: null as never }] } : { text: "Done for [[PERSON_1]]." }));
    const res = await runToolLoop({ engine, tools: [broken], context: ctx(), gate, broker: broker(() => "allow"), maxRounds: 3, addendum: "", sealed: sealed(), task: TASK });
    expect(engine.sentResults).toEqual(['{"error":"unknown_tool"}', '{"error":"tool_failed"}']);
    expect(res.activity.map((a) => a.status)).toEqual(["invalid", "invalid"]);
  });

  it("'Always allow' skips the card for that tool only", async () => {
    const b = broker(() => "allow");
    await runToolLoop({ engine: meetingEngine(), tools: ALL_TOOLS, context: ctx(), gate, broker: b, maxRounds: 3, addendum: "", sealed: sealed(), task: TASK, alwaysAllow: new Set(["today_context"]) });
    expect(b.requests.map((r) => r.tool)).toEqual(["find_free_slots"]);
  });
});

describe("answer() with private tools", () => {
  async function run(task: Parameters<typeof answer>[0]["task"], preference: "auto" | "phoneOnly", decide: "allow" | "deny") {
    const toolEngine = meetingEngine();
    const engines = new MockEngines(undefined, {}, toolEngine);
    const events: AnswerEvent[] = [];
    for await (const ev of answer({
      engines, prompts, ledger: new ReceiptLedger(), sealed: sealed(), task, restore: { entities, userFirstName: "Maya" }, preference, threadId: "t1",
      tools: { tools: ALL_TOOLS, context: ctx(), gate, broker: broker(() => decide, decide === "allow" ? 2 : 1), maxRounds: 3 },
    })) events.push(ev);
    const outcome = (events.at(-1) as { outcome: AnswerOutcome }).outcome;
    return { events, outcome, toolEngine };
  }

  it("Propose a meeting time: cloud-only tool loop, two real free slots in the restored draft, a receipt", async () => {
    const { events, outcome, toolEngine } = await run({ kind: "meeting" }, "auto", "allow");
    expect(outcome.route).toBe("cloudOnly");
    expect(outcome.restored.text).toContain("Hi Raj Patel, could we meet Tue 24 Nov, 9:30–10:30 am or Wed 25 Nov, 9:00–10:00 am?");
    expect(outcome.restored.text).toContain("Maya");
    expect(outcome.tools?.map((t) => t.status)).toEqual(["allowed", "allowed"]);
    expect(outcome.receipt).not.toBeNull();
    expect(events.some((e) => e.kind === "tools")).toBe(true);
    expect(toolEngine.addenda[0]).toBe(prompts.template("tools-addendum.v1"));
    expect(toolEngine.received[0]!.value).not.toContain("Raj");
  });

  it("declining still yields a sensible draft", async () => {
    const { outcome } = await run({ kind: "meeting" }, "auto", "deny");
    expect(outcome.restored.text).toContain("Hi Raj Patel, could we find a time next week");
    expect(outcome.tools?.map((t) => t.status)).toEqual(["declined", "declined"]);
  });

  it("phone-only preference never uses the cloud tool engine", async () => {
    const { outcome, toolEngine } = await run({ kind: "meeting" }, "phoneOnly", "allow");
    expect(outcome.route).toBe("phoneOnly");
    expect(toolEngine.received).toHaveLength(0);
  });
});
