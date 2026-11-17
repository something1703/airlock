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

describe("cloud stream guards", () => {
  async function engineWith(fake: object, remote: Record<string, string> = {}) {
    const { initializeApp } = await import("firebase/app");
    const { FirebaseEngines } = await import("../src/ai/firebaseEngines");
    const { PromptLibrary } = await import("../src/engine/prompts");
    const app = initializeApp({ apiKey: "test", projectId: "test", appId: "1:1:web:1" }, `t-${Math.random()}`);
    const engines = new FirebaseEngines(app, new AppConfig(remote), new PromptLibrary());
    (engines as unknown as { model: (mode: string, model: string) => object }).model = (_mode, model) => (typeof fake === "function" ? (fake as (m: string) => object)(model) : fake);
    const sealed = engines.sealed("cloudFirst", "auto") as unknown as { stream(s: unknown, t: unknown): AsyncIterable<{ cumulativeText: string; modelVersion: string | null }>; turn: unknown };
    (sealed as { turn: unknown }).turn = () => ({ text: "sealed text", system: "sys" });
    const out: { cumulativeText: string; modelVersion: string | null }[] = [];
    return { run: async () => { for await (const c of sealed.stream({}, { id: "task.help.v1", instruction: "", maxOutputTokens: 100 })) out.push(c); return out; } };
  }
  const abortable = (o: { signal: AbortSignal }) => new Promise<never>((_r, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  const okStream = (text: string) => ({ stream: (async function* () { yield { text: () => text, inferenceSource: "in_cloud" }; })() });
  const c = new AppConfig();

  it("a stalled deep model falls back to the stable model; the answer names the model that answered", async () => {
    const calls: string[] = [];
    const fake = (model: string) => ({
      generateContentStream: (_t: string, o: { signal: AbortSignal }) => { calls.push(`stream:${model}`); return model === c.modelCloudDeep ? abortable(o) : Promise.resolve(okStream("fallback answer")); },
      generateContent: async () => { calls.push(`unary:${model}`); return { response: { text: () => "x", inferenceSource: "in_cloud" } }; },
    });
    const out = await (await engineWith(fake, { cloud_first_chunk_ms: "1000" })).run();
    expect(calls).toEqual([`stream:${c.modelCloudDeep}`, `stream:${c.modelCloudFallback}`]);
    expect(out.at(-1)).toMatchObject({ cumulativeText: "fallback answer", modelVersion: c.modelCloudFallback });
  });

  it("an overloaded (503) model is skipped immediately; if every stream fails, one unary call to the fallback", async () => {
    const calls: string[] = [];
    const fake = (model: string) => ({
      generateContentStream: async () => { calls.push(`stream:${model}`); throw new AIError("fetch-error" as never, "overloaded", { status: 503 } as never); },
      generateContent: async () => { calls.push(`unary:${model}`); return { response: { text: () => "unary answer", inferenceSource: "in_cloud" } }; },
    });
    const out = await (await engineWith(fake)).run();
    expect(calls).toEqual([`stream:${c.modelCloudDeep}`, `stream:${c.modelCloudFallback}`, `unary:${c.modelCloudFallback}`]);
    expect(out.at(-1)).toMatchObject({ cumulativeText: "unary answer", modelVersion: c.modelCloudFallback });
  });

  it("non-transient errors are not retried on another model", async () => {
    const calls: string[] = [];
    const fake = (model: string) => ({
      generateContentStream: async () => { calls.push(`stream:${model}`); throw new AIError("fetch-error" as never, "bad", { status: 400 } as never); },
      generateContent: async () => { calls.push("unary"); return { response: { text: () => "x" } }; },
    });
    const e = await (await engineWith(fake)).run().catch((x: unknown) => x);
    expect((e as EngineError).code).toBe("other");
    expect(calls).toEqual([`stream:${c.modelCloudDeep}`]);
  });

  it("a stream that started is never replayed; the total timeout surfaces as serviceUnavailable", async () => {
    const calls: string[] = [];
    const fake = {
      generateContentStream: async (_t: string, o: { signal: AbortSignal }) => {
        calls.push("stream");
        async function* gen() {
          yield { text: () => "Hello", inferenceSource: "in_cloud" };
          await new Promise((_r, rej) => o.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
        }
        return { stream: gen() };
      },
      generateContent: async () => { calls.push("unary"); return { response: { text: () => "x", inferenceSource: "in_cloud" } }; },
    };
    const e = await (await engineWith(fake, { cloud_first_chunk_ms: "1000", cloud_timeout_ms: "5000" })).run().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe("serviceUnavailable");
    expect(calls).toEqual(["stream"]);
  }, 10_000);
});
