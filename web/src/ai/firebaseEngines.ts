// The ONLY web code that calls Firebase AI Logic (lint-enforced, ADR-08).
import { AgentPlatformBackend, getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, type AI, type GenerativeModel } from "firebase/ai";
import type { FirebaseApp } from "firebase/app";
import type { AppConfig } from "../core/appConfig";
import {
  CHROME_ON_DEVICE_MODEL, EngineError, type AnswerQuality, type EngineChunk, type EngineProvider, type EngineResult, type PhoneAvailability,
  type PhoneOnlyEngine, type PhoneOptions, type PhonePrompt, type SealedEngine, type SealedHistory, type TaskSpec,
} from "../engine/engines";
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

  /** Must be called from a user gesture (click/keypress): may trigger Chrome's model download. */
  async initializeOnDevice(onProgress?: (fraction: number) => void): Promise<void> {
    try {
      await getGenerativeModel(this.ai, { mode: InferenceMode.ONLY_ON_DEVICE }).initializeDeviceModel(onProgress);
    } catch (e) {
      throw mapError(e);
    }
  }

  model(mode: Mode, cloudModel: string, systemInstruction?: string, maxOutputTokens?: number): GenerativeModel {
    return getGenerativeModel(this.ai, {
      mode,
      inCloudParams: { model: cloudModel, ...(systemInstruction ? { systemInstruction } : {}), ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}) },
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

  async respond(sealed: SealedText, task: TaskSpec, history?: SealedHistory): Promise<EngineResult> {
    const { text, system } = this.turn(sealed, task, history);
    try {
      return await withRetry(() => this.once(this.plan.mode, text, system, task.maxOutputTokens));
    } catch (e) {
      const err = mapError(e);
      if (err.code === "offline" && this.plan.manualOfflineFallback) return this.once(InferenceMode.ONLY_ON_DEVICE, `${system ?? ""}\n\n${text}`, undefined, task.maxOutputTokens);
      throw err;
    }
  }

  private async once(mode: Mode, text: string, system: string | undefined, maxOutputTokens: number | undefined): Promise<EngineResult> {
    const t0 = performance.now();
    try {
      const { response } = await this.engines.model(mode, this.plan.cloudModel, system, maxOutputTokens).generateContent(text);
      const onDevice = response.inferenceSource === InferenceSource.ON_DEVICE;
      return { text: response.text(), modelVersion: onDevice ? CHROME_ON_DEVICE_MODEL : this.plan.cloudModel, ranOnDevice: onDevice, latencyMs: performance.now() - t0 };
    } catch (e) {
      throw mapError(e);
    }
  }

  async *stream(sealed: SealedText, task: TaskSpec, history?: SealedHistory): AsyncIterable<EngineChunk> {
    const { text, system } = this.turn(sealed, task, history);
    try {
      yield* this.streamOnce(this.plan.mode, text, system, task.maxOutputTokens);
    } catch (e) {
      const err = mapError(e);
      if (err.code === "offline" && this.plan.manualOfflineFallback) {
        yield* this.streamOnce(InferenceMode.ONLY_ON_DEVICE, `${system ?? ""}\n\n${text}`, undefined, task.maxOutputTokens);
        return;
      }
      throw err;
    }
  }

  private async *streamOnce(mode: Mode, text: string, system: string | undefined, maxOutputTokens: number | undefined): AsyncIterable<EngineChunk> {
    let acc = "";
    try {
      const { stream } = await this.engines.model(mode, this.plan.cloudModel, system, maxOutputTokens).generateContentStream(text);
      for await (const chunk of stream) {
        acc += chunk.text();
        const src = chunk.inferenceSource;
        const onDevice = src === undefined ? null : src === InferenceSource.ON_DEVICE;
        yield { cumulativeText: acc, modelVersion: onDevice === null ? null : onDevice ? CHROME_ON_DEVICE_MODEL : this.plan.cloudModel, ranOnDevice: onDevice };
      }
    } catch (e) {
      throw mapError(e);
    }
  }
}

/** Exponential backoff ×3 (0.5 s, 1 s, 2 s) for 429/503. */
async function withRetry<T>(op: () => Promise<T>): Promise<T> {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const err = mapError(e);
      if (!err.isTransientCloud || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}
