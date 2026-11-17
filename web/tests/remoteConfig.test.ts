import { describe, expect, it, vi } from "vitest";

const state = { values: {} as Record<string, { source: string; value: string }>, fetch: (): Promise<boolean> => Promise.resolve(true) };
vi.mock("firebase/remote-config", () => ({
  getRemoteConfig: () => ({ settings: {} }),
  activate: () => Promise.resolve(true),
  fetchAndActivate: () => state.fetch(),
  getAll: () => Object.fromEntries(Object.entries(state.values).map(([k, v]) => [k, { getSource: () => v.source, asString: () => v.value }])),
}));

const { loadRemoteConfig } = await import("../src/ai/remoteConfig");
const { AppConfig } = await import("../src/core/appConfig");
const app = {} as never;

describe("web Remote Config", () => {
  it("passes through only server values; AppConfig validates them", async () => {
    state.values = { model_cloud_deep: { source: "remote", value: "gemini-x" }, cloud_timeout_ms: { source: "remote", value: "not a number" }, model_cloud_quick: { source: "default", value: "ignored" } };
    const remote = await loadRemoteConfig(app);
    expect(remote).toEqual({ model_cloud_deep: "gemini-x", cloud_timeout_ms: "not a number" });
    const c = new AppConfig(remote);
    expect(c.modelCloudDeep).toBe("gemini-x");
    expect(c.cloudTimeoutMs).toBe(new AppConfig().cloudTimeoutMs);
    expect(c.modelCloudQuick).toBe(new AppConfig().modelCloudQuick);
  });
  it("a failed or slow fetch never blocks startup beyond the wait", async () => {
    state.values = {};
    state.fetch = () => Promise.reject(new Error("offline"));
    expect(await loadRemoteConfig(app)).toEqual({});
    state.fetch = () => new Promise(() => {});
    const t = Date.now();
    expect(await loadRemoteConfig(app, 50)).toEqual({});
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
