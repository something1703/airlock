// The ONLY web code that calls Firebase AI Logic (lint-enforced, ADR-08).
import {
  AgentPlatformBackend, FunctionCallingMode, getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource,
  type AI, type ChatSession, type FunctionDeclaration, type FunctionResponsePart, type GenerativeModel, type GroundingMetadata, type ModelParams,
} from "firebase/ai";
import type { FirebaseApp } from "firebase/app";
import type { AppConfig } from "../core/appConfig";
import {
  CHROME_ON_DEVICE_MODEL, EngineError, type AnswerQuality, type ClaimCheckEngine, type ClaimContext, type EngineChunk, type EngineProvider, type EngineResult,
  type GroundedResult, type GroundingSource, type GroundingSupportRef, type PhoneAvailability,
  type PhoneOnlyEngine, type PhoneOptions, type PhonePrompt, type SealedEngine, type SealedHistory, type SealedToolResponse, type TaskSpec,
  type ToolCall, type ToolChat, type ToolDeclaration, type ToolEngine, type ToolTurn,
} from "../engine/engines";
import { claimCheckPrompt } from "../engine/proof";
import type { PromptLibrary } from "../engine/prompts";
import type { Route, SealedText } from "../engine/types";
import { chromeAvailability } from "./chromeModel";
import { mapError } from "./errors";

type Mode = (typeof InferenceMode)[keyof typeof InferenceMode];

/** Route → Firebase `InferenceMode` (docs/02-ARCHITECTURE.md §4–5). */
export const MODE_FOR_ROUTE: Record<Route, Mode> = {
  phoneOnly: InferenceMode.ONLY_ON_DEVICE,
  phoneFirst: InferenceMode.PREFER_ON_DEVICE,
  cloudFirst: InferenceMode.PREFER_IN_CLOUD,
  cloudOnly: InferenceMode.ONLY_IN_CLOUD,
};

export interface WebModelPlan {
  route: Route;
  mode: Mode;
  cloudModel: string;
  instructionsId: string;
  /** With Model Armor expected, cloud-first runs cloud-only and retries on device only when offline. */
  manualOfflineFallback: boolean;
}

/** Pure route → plan (unit-tested). Raw-text routes never name a cloud model in a way that can be used. */
export function planFor(route: Route, config: AppConfig, quality: AnswerQuality): WebModelPlan {
  const deep = quality === "best" ? config.modelCloudMax : config.modelCloudDeep;
  switch (route) {
    case "phoneOnly": return { route, mode: InferenceMode.ONLY_ON_DEVICE, cloudModel: config.modelCloudQuick, instructionsId: "phone-system.v1", manualOfflineFallback: false };
    case "phoneFirst": return { route, mode: InferenceMode.PREFER_ON_DEVICE, cloudModel: config.modelCloudQuick, instructionsId: "phone-system.v1", manualOfflineFallback: false };
    case "cloudFirst":
      if (config.armorExpected) return { route, mode: InferenceMode.ONLY_IN_CLOUD, cloudModel: deep, instructionsId: "cloud-system.v1", manualOfflineFallback: true };
      return { route, mode: InferenceMode.PREFER_IN_CLOUD, cloudModel: deep, instructionsId: "cloud-system.v1", manualOfflineFallback: false };
    case "cloudOnly": return { route, mode: InferenceMode.ONLY_IN_CLOUD, cloudModel: deep, instructionsId: "cloud-system.v1", manualOfflineFallback: false };
  }
}

/**
 * Firebase AI Logic (web SDK, hybrid inference) implementation of every engine.
 * A new GenerativeModel per call (INV-4); raw text only ever goes to an ONLY_ON_DEVICE model (INV-3).
 */
export class FirebaseEngines implements EngineProvider {
  readonly ai: AI;

  constructor(
    app: FirebaseApp,
    readonly config: AppConfig,
    readonly prompts: PromptLibrary,
  ) {
    const backend = config.string("ai_backend") === "agentPlatform" ? new AgentPlatformBackend(config.string("ai_location") || "global") : new GoogleAIBackend();
    this.ai = getAI(app, { backend });
  }

  get phone(): PhoneOnlyEngine {
    return new FirebasePhoneEngine(this);
  }

  sealed(route: Route, quality: AnswerQuality): SealedEngine {
    return new FirebaseSealedEngine(this, planFor(route, this.config, quality));
  }

  /** Function calling for private tools. Always ONLY_IN_CLOUD: the SDK never sends function responses on device. */
  tools(quality: AnswerQuality): ToolEngine {
    return new FirebaseToolEngine(this, planFor("cloudOnly", this.config, quality));
  }

  /** A cloud-only model that may call the declared tools (`FunctionCallingMode.AUTO`, no automatic execution). */
  toolModel(cloudModel: string, systemInstruction: string, declarations: readonly ToolDeclaration[], maxOutputTokens?: number): GenerativeModel {
    return getGenerativeModel(this.ai, {
      mode: InferenceMode.ONLY_IN_CLOUD,
      inCloudParams: {
        model: cloudModel, systemInstruction,
        tools: [{ functionDeclarations: declarations.map(toFunctionDeclaration) }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
        ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
      },
    });
  }

  get claimCheck(): ClaimCheckEngine {
    return new FirebaseClaimCheckEngine(this);
  }

  /** Must be called from a user gesture (click/keypress): may trigger Chrome's model download. */
  async initializeOnDevice(onProgress?: (fraction: number) => void): Promise<void> {
    try {
      await getGenerativeModel(this.ai, { mode: InferenceMode.ONLY_ON_DEVICE }).initializeDeviceModel(onProgress);
    } catch (e) {
      throw mapError(e);
    }
  }

  /** `tools` carries Google Search grounding (Proof); `temperature` is used only by AirlockBench's judge (`judge.v1` at 0). */
  model(mode: Mode, cloudModel: string, systemInstruction?: string, maxOutputTokens?: number, tools?: ModelParams["tools"], temperature?: number): GenerativeModel {
    const generationConfig = { ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) };
    return getGenerativeModel(this.ai, {
      mode,
      inCloudParams: { model: cloudModel, ...(systemInstruction ? { systemInstruction } : {}), ...(Object.keys(generationConfig).length ? { generationConfig } : {}), ...(tools ? { tools } : {}) },
    });
  }
}

/** Phone-only: an ONLY_ON_DEVICE model; the SDK throws rather than fall back to the cloud (verified in typings). */
class FirebasePhoneEngine implements PhoneOnlyEngine {
  constructor(private readonly engines: FirebaseEngines) {}

  availability(): Promise<PhoneAvailability> {
    return chromeAvailability();
  }

  async respond(prompt: PhonePrompt, _options: PhoneOptions): Promise<EngineResult> {
    const avail = await chromeAvailability();
    if (avail !== "available") throw new EngineError("unavailable", avail);
    const t0 = performance.now();
    try {
      const model = this.engines.model(InferenceMode.ONLY_ON_DEVICE, this.engines.config.modelCloudQuick);
      const text = prompt.instructions ? `${prompt.instructions}\n\n${prompt.text}` : prompt.text;
      const { response } = await model.generateContent(text);
      if (response.inferenceSource !== undefined && response.inferenceSource !== InferenceSource.ON_DEVICE) throw new EngineError("other", "not-on-device");
      return { text: response.text(), modelVersion: CHROME_ON_DEVICE_MODEL, ranOnDevice: true, latencyMs: performance.now() - t0 };
    } catch (e) {
      throw mapError(e);
    }
  }
}

class FirebaseSealedEngine implements SealedEngine {
  constructor(
    private readonly engines: FirebaseEngines,
    private readonly plan: WebModelPlan,
  ) {}

  get route(): Route {
    return this.plan.route;
  }

  private turn(sealed: SealedText, task: TaskSpec, history?: SealedHistory): { text: string; system?: string } {
    const userTurn = this.engines.prompts.cloudUserTurn(sealed, task, history);
    const instructions = this.engines.prompts.template(this.plan.instructionsId);
    // On-device-first routes: Chrome's model may not see the cloud system instruction, so inline it.
    if (this.plan.mode === InferenceMode.PREFER_ON_DEVICE || this.plan.mode === InferenceMode.ONLY_ON_DEVICE) return { text: `${instructions}\n\n${userTurn}` };
    return { text: userTurn, system: instructions };
  }

  /** The planned model, then the stable fallback (`model_cloud_fallback`) if they differ. */
  private models(): string[] {
    return [...new Set([this.plan.cloudModel, this.engines.config.modelCloudFallback])];
  }

  async respond(sealed: SealedText, task: TaskSpec, history?: SealedHistory): Promise<EngineResult> {
    const { text, system } = this.turn(sealed, task, history);
    try {
      let last: EngineError | null = null;
      for (const model of this.models()) {
        try {
          return await withRetry(() => this.once(this.plan.mode, model, text, system, task.maxOutputTokens));
        } catch (e) {
          last = mapError(e);
          if (!last.isTransientCloud) throw last;
        }
      }
      throw last ?? new EngineError("serviceUnavailable");
    } catch (e) {
      const err = mapError(e);
      if (err.code === "offline" && this.plan.manualOfflineFallback) return this.once(InferenceMode.ONLY_ON_DEVICE, this.plan.cloudModel, `${system ?? ""}\n\n${text}`, undefined, task.maxOutputTokens);
      throw err;
    }
  }

  private async once(mode: Mode, model: string, text: string, system: string | undefined, maxOutputTokens: number | undefined): Promise<EngineResult> {
    const t0 = performance.now();
    try {
      const { response } = await this.engines.model(mode, model, system, maxOutputTokens).generateContent(text, { timeout: this.engines.config.cloudTimeoutMs });
      const onDevice = response.inferenceSource === InferenceSource.ON_DEVICE;
      return { text: response.text(), modelVersion: onDevice ? CHROME_ON_DEVICE_MODEL : model, ranOnDevice: onDevice, latencyMs: performance.now() - t0 };
    } catch (e) {
      throw mapError(e);
    }
  }

  /**
   * Streams with a fallback chain: planned model → `model_cloud_fallback` → one unary call to the fallback.
   * A model is skipped only if it fails *before its first chunk* with a stall or a transient error
   * (503/429); once text has streamed, errors surface (no silent replays). The answer's modelVersion is
   * whichever model actually answered, so the route badge and receipt stay truthful.
   */
  async *stream(sealed: SealedText, task: TaskSpec, history?: SealedHistory): AsyncIterable<EngineChunk> {
    const { text, system } = this.turn(sealed, task, history);
    try {
      const models = this.models();
      for (const model of models) {
        const outcome = yield* this.streamOnce(this.plan.mode, model, text, system, task.maxOutputTokens);
        if (outcome === "done") return;
      }
      const r = await this.once(this.plan.mode, models[models.length - 1]!, text, system, task.maxOutputTokens);
      yield { cumulativeText: r.text, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice };
    } catch (e) {
      const err = mapError(e);
      if (err.code === "offline" && this.plan.manualOfflineFallback) {
        const r = await this.once(InferenceMode.ONLY_ON_DEVICE, this.plan.cloudModel, `${system ?? ""}\n\n${text}`, undefined, task.maxOutputTokens);
        yield { cumulativeText: r.text, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice };
        return;
      }
      throw err;
    }
  }

  /**
   * One streamed attempt. Returns "done", or "skip" when the model produced nothing and either stalled
   * (no first chunk within `cloud_first_chunk_ms`) or failed transiently. Throws otherwise. Aborts are
   * DOMExceptions, which the SDK never treats as a reason to fall back on device (verified in 3.1.0 source).
   */
  private async *streamOnce(mode: Mode, model: string, text: string, system: string | undefined, maxOutputTokens: number | undefined): AsyncGenerator<EngineChunk, "done" | "skip", void> {
    const cfg = this.engines.config;
    const ctl = new AbortController();
    let gotChunk = false;
    let stalled = false;
    let timedOut = false;
    const firstTimer = setTimeout(() => {
      if (!gotChunk) { stalled = true; ctl.abort(); }
    }, cfg.cloudFirstChunkMs);
    const totalTimer = setTimeout(() => { timedOut = true; ctl.abort(); }, cfg.cloudTimeoutMs);
    let acc = "";
    try {
      const { stream } = await this.engines.model(mode, model, system, maxOutputTokens).generateContentStream(text, { signal: ctl.signal, timeout: cfg.cloudTimeoutMs });
      for await (const chunk of stream) {
        gotChunk = true;
        acc += chunk.text();
        const src = chunk.inferenceSource;
        const onDevice = src === undefined ? null : src === InferenceSource.ON_DEVICE;
        yield { cumulativeText: acc, modelVersion: onDevice === null ? null : onDevice ? CHROME_ON_DEVICE_MODEL : model, ranOnDevice: onDevice };
      }
      return "done";
    } catch (e) {
      if (gotChunk) throw timedOut ? new EngineError("serviceUnavailable", "timeout") : mapError(e);
      if (stalled) return "skip";
      if (timedOut) throw new EngineError("serviceUnavailable", "timeout");
      const err = mapError(e);
      if (err.isTransientCloud) return "skip";
      throw err;
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
    }
  }
}

/**
 * Our plain declaration → the SDK's `FunctionDeclaration`. No `functionReference`: the SDK must never run a
 * tool itself (that would skip consent and the egress gate) — `ChatSession` only auto-calls functions that
 * have one (verified in @firebase/ai 3.1.0 `_getCallableFunctionCalls`).
 */
export function toFunctionDeclaration(d: ToolDeclaration): FunctionDeclaration {
  if (!d.parameters) return { name: d.name, description: d.description };
  const properties = Object.fromEntries(Object.entries(d.parameters.properties).map(([k, p]) => [k, { type: p.type, description: p.description }]));
  return { name: d.name, description: d.description, parameters: { type: "object", properties, required: [...d.parameters.required] } };
}

/** Sealed JSON → the `response` object of a FunctionResponse (always an object, as the API requires). */
export function functionResponsePart(r: SealedToolResponse): FunctionResponsePart {
  let response: object;
  try {
    const v: unknown = JSON.parse(r.sealed.value);
    response = v && typeof v === "object" && !Array.isArray(v) ? v : { result: v };
  } catch {
    response = { result: r.sealed.value };
  }
  return { type: "functionResponse", functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response } };
}

class FirebaseToolEngine implements ToolEngine {
  constructor(
    private readonly engines: FirebaseEngines,
    private readonly plan: WebModelPlan,
  ) {}
  get route(): Route {
    return this.plan.route;
  }
  chat(declarations: readonly ToolDeclaration[], addendum: string): ToolChat {
    return new FirebaseToolChat(this.engines, this.plan, declarations, addendum);
  }
}

/**
 * One `ChatSession` per sealed request (INV-4). The SDK keeps the model's own parts — including Gemini 3
 * thought signatures — in chat history, which multi-turn function calling needs. The first turn may fall
 * back to `model_cloud_fallback` (nothing has been said yet); later turns stay on the model that started.
 */
class FirebaseToolChat implements ToolChat {
  private session: ChatSession | null = null;
  private model = "";

  constructor(
    private readonly engines: FirebaseEngines,
    private readonly plan: WebModelPlan,
    private readonly declarations: readonly ToolDeclaration[],
    private readonly addendum: string,
  ) {}

  async send(sealed: SealedText, task: TaskSpec, history: SealedHistory | undefined, onText?: (t: string) => void): Promise<ToolTurn> {
    const text = this.engines.prompts.cloudUserTurn(sealed, task, history);
    const system = `${this.engines.prompts.template(this.plan.instructionsId)}\n\n${this.addendum}`;
    let last: EngineError | null = null;
    for (const model of [...new Set([this.plan.cloudModel, this.engines.config.modelCloudFallback])]) {
      const chat = this.engines.toolModel(model, system, this.declarations, task.maxOutputTokens).startChat();
      try {
        const turn = await this.turn(chat, text, model, onText, true);
        this.session = chat;
        this.model = model;
        return turn;
      } catch (e) {
        last = mapError(e);
        if (!last.isTransientCloud) throw last;
      }
    }
    throw last ?? new EngineError("serviceUnavailable");
  }

  async respond(results: readonly SealedToolResponse[], onText?: (t: string) => void): Promise<ToolTurn> {
    if (!this.session) throw new EngineError("other", "respond-before-send");
    return this.turn(this.session, results.map(functionResponsePart), this.model, onText, false);
  }

  private async turn(chat: ChatSession, request: string | FunctionResponsePart[], model: string, onText: ((t: string) => void) | undefined, guardFirstChunk: boolean): Promise<ToolTurn> {
    const cfg = this.engines.config;
    const ctl = new AbortController();
    let gotChunk = false;
    let stalled = false;
    const firstTimer = guardFirstChunk ? setTimeout(() => { if (!gotChunk) { stalled = true; ctl.abort(); } }, cfg.cloudFirstChunkMs) : undefined;
    const totalTimer = setTimeout(() => ctl.abort(), cfg.cloudTimeoutMs);
    try {
      const { stream, response } = await chat.sendMessageStream(request, { signal: ctl.signal, timeout: cfg.cloudTimeoutMs });
      response.catch(() => {});
      let acc = "";
      for await (const chunk of stream) {
        gotChunk = true;
        const t = chunk.text();
        if (t) {
          acc += t;
          onText?.(acc);
        }
      }
      const final = await response;
      if (final.inferenceSource === InferenceSource.ON_DEVICE) throw new EngineError("other", "tool-turn-on-device");
      const calls: ToolCall[] = (final.functionCalls() ?? []).map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, args: (c.args && typeof c.args === "object" ? c.args : {}) as Record<string, unknown> }));
      return { text: acc || final.text(), calls, modelVersion: model, ranOnDevice: false };
    } catch (e) {
      if (stalled || (ctl.signal.aborted && !gotChunk)) throw new EngineError("serviceUnavailable", stalled ? "stall" : "timeout");
      if (ctl.signal.aborted) throw new EngineError("serviceUnavailable", "timeout");
      throw mapError(e);
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
    }
  }
}

/**
 * Proof mode's claim check (`claimcheck.v1`): ONLY_IN_CLOUD with the Google Search tool — never on device
 * (built-in tools aren't supported there), never a hybrid mode. Takes only SealedText + fixed-vocabulary context.
 * A new GenerativeModel per call (INV-4). Grounding metadata comes from the first candidate
 * (`candidates[0].groundingMetadata`, verified in @firebase/ai 3.1.0 typings).
 */
class FirebaseClaimCheckEngine implements ClaimCheckEngine {
  constructor(private readonly engines: FirebaseEngines) {}

  async check(sealedClaim: SealedText, context: ClaimContext): Promise<GroundedResult> {
    const text = claimCheckPrompt(this.engines.prompts, sealedClaim, context);
    const cfg = this.engines.config;
    let last: EngineError | null = null;
    for (const model of [...new Set([cfg.modelCloudProof, cfg.modelCloudFallback])]) {
      try {
        // One retry per model: a grounded request that gets 429 is usually a quota, not a blip (seen live 18 Nov).
        return await withRetry(() => this.once(model, text), 1);
      } catch (e) {
        last = mapError(e);
        if (!last.isTransientCloud) throw last;
      }
    }
    throw last ?? new EngineError("serviceUnavailable");
  }

  private async once(model: string, text: string): Promise<GroundedResult> {
    const t0 = performance.now();
    try {
      const { response } = await this.engines.model(InferenceMode.ONLY_IN_CLOUD, model, undefined, 1200, [{ googleSearch: {} }]).generateContent(text, { timeout: this.engines.config.cloudTimeoutMs });
      if (response.inferenceSource === InferenceSource.ON_DEVICE) throw new EngineError("other", "not-in-cloud");
      return { text: response.text(), modelVersion: model, ranOnDevice: false, latencyMs: performance.now() - t0, ...grounding(response.candidates?.[0]?.groundingMetadata) };
    } catch (e) {
      throw mapError(e);
    }
  }
}

/** Grounding metadata → plain data (sources keep their chunk index so supports can point at them). */
export function grounding(meta: GroundingMetadata | undefined): Pick<GroundedResult, "sources" | "supports" | "searchEntryPointHtml" | "webSearchQueries"> {
  const sources: GroundingSource[] = [];
  (meta?.groundingChunks ?? []).forEach((c, chunkIndex) => {
    if (c.web?.uri) sources.push({ chunkIndex, uri: c.web.uri, title: c.web.title ?? c.web.domain ?? "" });
  });
  const supports: GroundingSupportRef[] = (meta?.groundingSupports ?? []).flatMap((s) => (s.segment?.text ? [{ text: s.segment.text, chunkIndices: [...(s.groundingChunkIndices ?? [])] }] : []));
  const html = meta?.searchEntryPoint?.renderedContent;
  return { sources, supports, searchEntryPointHtml: html && html.trim() ? html : null, webSearchQueries: [...(meta?.webSearchQueries ?? [])] };
}

/** Exponential backoff (default ×3: 0.5 s, 1 s, 2 s) for 429/503. */
async function withRetry<T>(op: () => Promise<T>, maxRetries = 3): Promise<T> {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const err = mapError(e);
      if (!err.isTransientCloud || attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
