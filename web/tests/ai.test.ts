import { AIError, InferenceMode } from "firebase/ai";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/core/appConfig";
import { MODE_FOR_ROUTE, planFor } from "../src/ai/firebaseEngines";
import { mapError } from "../src/ai/errors";
import { EngineError } from "../src/engine/engines";

describe("route → InferenceMode plan", () => {
  const c = new AppConfig();
  it("maps the four routes to the four SDK modes", () => {
    expect(MODE_FOR_ROUTE).toEqual({ phoneOnly: "only_on_device", phoneFirst: "prefer_on_device", cloudFirst: "prefer_in_cloud", cloudOnly: "only_in_cloud" });
    expect(planFor("phoneFirst", c, "auto")).toMatchObject({ mode: InferenceMode.PREFER_ON_DEVICE, cloudModel: c.modelCloudQuick, instructionsId: "phone-system.v1" });
    expect(planFor("cloudFirst", c, "auto")).toMatchObject({ mode: InferenceMode.PREFER_IN_CLOUD, cloudModel: c.modelCloudDeep, instructionsId: "cloud-system.v1" });
    expect(planFor("cloudOnly", c, "best").cloudModel).toBe(c.modelCloudMax);
  });
  it("INV-3: the phone-only route is always ONLY_ON_DEVICE, whatever the config", () => {
    for (const remote of [{}, { armor_expected: "true" }, { model_cloud_quick: "x" }] as Record<string, string>[]) {
      for (const q of ["auto", "best"] as const) expect(planFor("phoneOnly", new AppConfig(remote), q).mode).toBe(InferenceMode.ONLY_ON_DEVICE);
    }
  });
  it("with Model Armor expected, cloud-first is cloud-only with an offline-only device fallback", () => {
    expect(planFor("cloudFirst", new AppConfig({ armor_expected: "true" }), "auto")).toMatchObject({ mode: InferenceMode.ONLY_IN_CLOUD, manualOfflineFallback: true });
  });
});

describe("error mapping", () => {
  const ai = (code: string, data?: object): AIError => new AIError(code as never, "Raj Patel at 14 Elm St said", data as never);
  it("HTTP statuses and blocks", () => {
    expect(mapError(ai("fetch-error", { status: 429 })).code).toBe("quota");
    expect(mapError(ai("fetch-error", { status: 503 })).code).toBe("serviceUnavailable");
    expect(mapError(ai("fetch-error", { status: 403 })).code).toBe("appCheck");
    expect(mapError(ai("response-error", { response: { promptFeedback: { blockReason: "MODEL_ARMOR" } } })).code).toBe("armorBlocked");
    expect(mapError(ai("response-error", { response: { promptFeedback: { blockReason: "SAFETY" } } })).code).toBe("cloudBlocked");
    expect(mapError(ai("unsupported")).code).toBe("unavailable");
  });
  it("Chrome on-device errors", () => {
    expect(mapError(new DOMException("too long", "QuotaExceededError")).code).toBe("contextTooLong");
    expect(mapError(new DOMException("x", "NotAllowedError")).code).toBe("needsUserGesture");
    expect(mapError(new DOMException("x", "AbortError")).code).toBe("cancelled");
    expect(mapError(new TypeError("Failed to fetch")).code).toBe("offline");
    const e = new EngineError("refused");
    expect(mapError(e)).toBe(e);
  });
  it("INV-8: no SDK message text survives mapping", () => {
    for (const err of [ai("fetch-error", { status: 400 }), ai("weird-code"), new DOMException("Raj Patel", "UnknownError"), new Error("Raj Patel")]) {
      const m = mapError(err);
      expect(m.message + m.detail).not.toMatch(/Raj|Elm/);
    }
  });
});
