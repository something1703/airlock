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

describe("private tools over Firebase AI Logic (function calling)", () => {
  const c = new AppConfig();
  const sealedReq = { value: "Hi [[PERSON_1]]", legend: [{ placeholder: "PERSON_1", description: "the writer's landlord" }], gateReport: {} } as never;
  const result = (value: string, id?: string) => ({ ...(id ? { id } : {}), name: "today_context" as const, sealed: { value } as never });

  async function toolEngineWith(fakeChat: (model: string) => object) {
    const { initializeApp } = await import("firebase/app");
    const { FirebaseEngines } = await import("../src/ai/firebaseEngines");
    const { PromptLibrary } = await import("../src/engine/prompts");
    const app = initializeApp({ apiKey: "test", projectId: "test", appId: "1:1:web:1" }, `t-${Math.random()}`);
    const engines = new FirebaseEngines(app, c, new PromptLibrary());
    const models: { model: string; system: string; names: string[] }[] = [];
    (engines as unknown as { toolModel: unknown }).toolModel = (model: string, system: string, decls: { name: string }[]) => {
      models.push({ model, system, names: decls.map((d) => d.name) });
      return { startChat: () => fakeChat(model) };
    };
    return { engine: engines.tools("auto"), models, real: engines };
  }
  const turn = (text: string, calls?: object[]) => ({
    stream: (async function* () { if (text) yield { text: () => text }; })(),
    response: Promise.resolve({ text: () => text, functionCalls: () => calls, inferenceSource: "in_cloud" }),
  });

  it("declarations carry no functionReference (the SDK never runs a tool itself); responses are FunctionResponseParts", async () => {
    const { toFunctionDeclaration, functionResponsePart } = await import("../src/ai/firebaseEngines");
    const { TOOL_DECLARATIONS } = await import("../src/engine/tools");
    const d = toFunctionDeclaration(TOOL_DECLARATIONS.find_free_slots);
    expect(d).not.toHaveProperty("functionReference");
    expect(d.parameters).toMatchObject({ type: "object", required: ["start_date", "end_date", "min_minutes"], properties: { min_minutes: { type: "integer" } } });
    expect(toFunctionDeclaration(TOOL_DECLARATIONS.today_context)).toEqual({ name: "today_context", description: TOOL_DECLARATIONS.today_context.description });
    expect(functionResponsePart(result('{"error":"user_declined"}', "c1"))).toEqual({ type: "functionResponse", functionResponse: { id: "c1", name: "today_context", response: { error: "user_declined" } } });
  });

  it("one ChatSession per request: function calls out, gate-sealed responses back on the same chat; system = cloud-system + addendum", async () => {
    const sent: unknown[] = [];
    const chat = {
      sendMessageStream: async (req: unknown) => {
        sent.push(req);
        return sent.length === 1 ? turn("", [{ id: "c1", name: "today_context", args: {} }]) : turn("Hi [[PERSON_1]], how about Tuesday?");
      },
    };
    const { engine, models } = await toolEngineWith(() => chat);
    expect(engine.route).toBe("cloudOnly");
    const tc = engine.chat([{ name: "today_context", description: "d" }], "ADDENDUM");
    const t1 = await tc.send(sealedReq, { id: "task.reply.v1", instruction: "Draft a reply." }, undefined);
    expect(t1.calls).toEqual([{ id: "c1", name: "today_context", args: {} }]);
    expect(typeof sent[0]).toBe("string");
    const streamed: string[] = [];
    const t2 = await tc.respond([result('{"today":"2026-11-18"}', "c1")], (t) => streamed.push(t));
    expect(sent[1]).toEqual([{ type: "functionResponse", functionResponse: { id: "c1", name: "today_context", response: { today: "2026-11-18" } } }]);
    expect(t2).toMatchObject({ text: "Hi [[PERSON_1]], how about Tuesday?", calls: [], modelVersion: c.modelCloudDeep, ranOnDevice: false });
    expect(streamed).toEqual(["Hi [[PERSON_1]], how about Tuesday?"]);
    expect(models).toHaveLength(1);
    expect(models[0]!.system.endsWith("\n\nADDENDUM")).toBe(true);
  });

  it("the first turn falls back to the stable model on 503; later turns stay on the model that started", async () => {
    const used: string[] = [];
    const { engine } = await toolEngineWith((model) => ({
      sendMessageStream: async () => {
        used.push(model);
        if (model === c.modelCloudDeep) throw new AIError("fetch-error" as never, "overloaded", { status: 503 } as never);
        return turn("", [{ name: "today_context", args: {} }]);
      },
    }));
    const tc = engine.chat([], "");
    await tc.send(sealedReq, { id: "x", instruction: "" }, undefined);
    await tc.respond([result("{}")]);
    expect(used).toEqual([c.modelCloudDeep, c.modelCloudFallback, c.modelCloudFallback]);
  });

  it("the real toolModel is ONLY_IN_CLOUD with AUTO function calling", async () => {
    const { real } = await toolEngineWith(() => ({}));
    const m = (real as unknown as { constructor: { prototype: { toolModel: (...a: unknown[]) => { tools?: unknown[]; toolConfig?: unknown; _apiSettings: { inferenceMode?: string } } } } }).constructor.prototype.toolModel.call(real, "m", "sys", [{ name: "today_context", description: "d" }]);
    expect(m._apiSettings.inferenceMode).toBe(InferenceMode.ONLY_IN_CLOUD);
    expect(m.tools).toEqual([{ functionDeclarations: [{ name: "today_context", description: "d" }] }]);
    expect(m.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });
});

describe("Proof claim check (ONLY_IN_CLOUD + Google Search)", () => {
  it("sends the sealed claim to the proof model with the googleSearch tool, and maps grounding metadata", async () => {
    const { initializeApp } = await import("firebase/app");
    const { FirebaseEngines } = await import("../src/ai/firebaseEngines");
    const { PromptLibrary } = await import("../src/engine/prompts");
    const { EgressGate } = await import("../src/engine/gate");
    const { PatternDetector } = await import("../src/engine/patterns");
    const { EntityMap } = await import("../src/engine/types");
    const app = initializeApp({ apiKey: "test", projectId: "test", appId: "1:1:web:1" }, `t-${Math.random()}`);
    const config = new AppConfig();
    const engines = new FirebaseEngines(app, config, new PromptLibrary());
    const sealed = new EgressGate(new PatternDetector(), []).seal({ text: "A parcel is held until a fee is paid", legend: [], replacements: [], entities: new EntityMap(), secretWarnings: [], revealedVaultIds: new Set(), keptValues: new Set() });
    const requests: { url: string; body: { tools?: unknown; contents: { parts: { text: string }[] }[] } }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { body: string }) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        candidates: [{
          index: 0, content: { role: "model", parts: [{ text: "VERDICT: LIKELY_SCAM\nWHY: Couriers don't ask for fees by text." }] },
          groundingMetadata: {
            searchEntryPoint: { renderedContent: "<div>chips</div>" }, webSearchQueries: ["parcel fee text scam"],
            groundingChunks: [{ web: { uri: "https://consumer-advice.example/a", title: "consumer-advice.example" } }, {}],
            groundingSupports: [{ segment: { partIndex: 0, startIndex: 0, endIndex: 10, text: "Couriers don't ask for fees by text." }, groundingChunkIndices: [0] }],
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    try {
      const r = await engines.claimCheck.check(sealed, { tactics: ["link", "urgency"], senderType: "a delivery company" });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain(`models/${config.modelCloudProof}:generateContent`);
      expect(requests[0]!.body.tools).toEqual([{ googleSearch: {} }]);
      const sent = requests[0]!.body.contents[0]!.parts[0]!.text;
      expect(sent).toContain("A parcel is held until a fee is paid");
      expect(sent).toContain("Claimed sender type: a delivery company");
      expect(r).toMatchObject({ ranOnDevice: false, modelVersion: config.modelCloudProof, searchEntryPointHtml: "<div>chips</div>", webSearchQueries: ["parcel fee text scam"] });
      expect(r.sources).toEqual([{ chunkIndex: 0, uri: "https://consumer-advice.example/a", title: "consumer-advice.example" }]);
      expect(r.supports).toEqual([{ text: "Couriers don't ask for fees by text.", chunkIndices: [0] }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
