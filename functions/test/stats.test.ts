import { describe, expect, it } from "vitest";
import { deltaFor, isoWeek } from "../src/stats.js";
import { mapFindings, MAX_SCAN_CHARS, validateScanInput } from "../src/scan.js";

describe("isoWeek", () => {
  it("matches ISO-8601 week numbering, including year boundaries", () => {
    expect(isoWeek("2026-11-17T10:00:00Z")).toBe("2026-W47");
    expect(isoWeek("2026-01-01T00:00:00Z")).toBe("2026-W01"); // Thursday
    expect(isoWeek("2027-01-01T00:00:00Z")).toBe("2026-W53"); // Friday → last week of 2026
    expect(isoWeek("2024-12-30T00:00:00Z")).toBe("2025-W01");
    expect(() => isoWeek("nope")).toThrow();
  });
});

describe("deltaFor (mirrors web ledger stats)", () => {
  const base = { id: "rcpt_0001", createdAt: "2026-11-17T10:00:00Z", armor: "notConfigured" };
  it("counts categories + generalised as sealed details and classifies the answer", () => {
    const d = deltaFor({ ...base, modelVersion: "gemini-3.8-flash", counts: { person: 2, location: 1, generalised: 1, redteamApplied: 3 } });
    expect(d).toEqual({ requests: 1, sealedDetails: 4, generalised: 1, onDeviceAnswers: 0, cloudAnswers: 1, blocked: 0, byCategory: { person: 2, location: 1 } });
  });
  it("on-device and Model Armor blocks are not cloud answers", () => {
    expect(deltaFor({ ...base, modelVersion: "chrome-gemini-nano", counts: {} })).toMatchObject({ onDeviceAnswers: 1, cloudAnswers: 0 });
    expect(deltaFor({ ...base, modelVersion: "blocked", armor: "blocked", counts: {} })).toMatchObject({ blocked: 1, cloudAnswers: 0 });
  });
  it("ignores junk counts", () => {
    expect(deltaFor({ ...base, modelVersion: "x", counts: { person: -3, org: Number.NaN, id: 1.7 } as Record<string, number> }).byCategory).toEqual({ id: 1 });
  });
});

describe("scanSealed input + findings", () => {
  it("validates", () => {
    expect(validateScanInput({ text: "Hi [[PERSON_1]]" })).toEqual({ text: "Hi [[PERSON_1]]" });
    expect(validateScanInput({ text: "  " })).toEqual({ error: "missing-text" });
    expect(validateScanInput(null)).toEqual({ error: "missing-text" });
    expect(validateScanInput({ text: "x".repeat(MAX_SCAN_CHARS + 1) })).toEqual({ error: "too-long" });
  });
  it("maps and sorts DLP findings", () => {
    const got = mapFindings([
      { infoType: { name: "PHONE_NUMBER" }, likelihood: "LIKELY", quote: "312", location: { codepointRange: { start: "20", end: "23" } } },
      { infoType: { name: "PERSON_NAME" }, likelihood: 4, quote: "Ann", location: { codepointRange: { start: 3, end: 6 } } },
    ]);
    expect(got.map((f) => f.infoType)).toEqual(["PERSON_NAME", "PHONE_NUMBER"]);
    expect(got[1]).toEqual({ infoType: "PHONE_NUMBER", likelihood: "LIKELY", start: 20, end: 23, quote: "312" });
    expect(mapFindings(undefined)).toEqual([]);
  });
});
