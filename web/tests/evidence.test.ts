import { describe, expect, it } from "vitest";
import { loadEvidence, parseEvidence, pickEvidence } from "../src/app/evidence";

const base = { schemaVersion: 1, runId: "r", createdAt: "2026-11-20T00:00:00Z", dataset: "synth-v1", split: "test", n: 10, languages: ["en"], leakRate: { value: 0.1, low: 0.05, high: 0.2, n: 10 }, namesCaught: { value: 0.9, low: 0.8, high: 0.95, n: 20 }, quality: { value: 0.8, low: 0.7, high: 0.9, n: 10 }, ablation: [{ config: "B", label: "Rules", leak: { value: 0.5, low: 0.4, high: 0.6, n: 10 } }], misses: [], method: "https://example.org" };

describe("evidence", () => {
  it("never accepts a mock run without its label, or malformed data", () => {
    expect(parseEvidence({ ...base, mock: true })).toBeNull();
    expect(parseEvidence({ ...base, mock: true, label: "MOCK RUN — not real model results" })).not.toBeNull();
    expect(parseEvidence({ ...base, mock: false, leakRate: { value: "x" } })).toBeNull();
    expect(parseEvidence({ ...base, mock: false, schemaVersion: 2 })).toBeNull();
    expect(parseEvidence(null)).toBeNull();
  });
  it("prefers real runs over mock runs, then the newest", () => {
    const mockNew = { ...base, mock: true, label: "MOCK", runId: "mock", createdAt: "2026-11-30T00:00:00Z" };
    const realOld = { ...base, mock: false, runId: "real-old", createdAt: "2026-11-20T00:00:00Z" };
    const realNew = { ...base, mock: false, runId: "real-new", createdAt: "2026-11-25T00:00:00Z" };
    expect(pickEvidence([mockNew, realOld, realNew])?.runId).toBe("real-new");
    expect(pickEvidence([mockNew])?.runId).toBe("mock");
  });
  it("Remote Config wins; otherwise the bundled reports (today: the labelled mock sample)", () => {
    expect(loadEvidence(JSON.stringify({ ...base, mock: false, runId: "from-rc" }))?.runId).toBe("from-rc");
    const bundled = loadEvidence("{}");
    expect(bundled).not.toBeNull();
    expect(bundled!.mock ? bundled!.label : "real").toBeTruthy();
    expect(loadEvidence("not json")?.runId).toBe(bundled!.runId);
  });
});
