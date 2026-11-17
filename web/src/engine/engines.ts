// Engine contracts (port of AirlockCore/Engines.swift). No Firebase here: src/ai/ implements these with
// Firebase AI Logic; mocks.ts implements them for tests and previews.
import type { Route, SealedText } from "./types";

/** Chrome on-device model state (from the Prompt API's `availability()`). */
export type PhoneAvailability = "available" | "downloadable" | "downloading" | "unavailable" | "unknown";

export type EngineErrorCode =
  | "unavailable" | "contextTooLong" | "refused" | "unsupportedLanguage" | "busy" | "parse" | "armorBlocked"
  | "cloudBlocked" | "quota" | "serviceUnavailable" | "offline" | "appCheck" | "cancelled" | "needsUserGesture" | "other";

/** Engine failure. Carries a code only — never prompt or answer text (INV-8). */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    readonly detail: string = "",
  ) {
    super(`Engine error: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "EngineError";
  }
  get isTransientCloud(): boolean {
    return this.code === "quota" || this.code === "serviceUnavailable";
  }
}

/** A prompt for the on-device model only. May contain raw text — it never leaves the device (INV-3). */
export interface PhonePrompt {
  /** Prompt id for logs and metrics (never content). */
  readonly promptId: string;
  readonly instructions?: string;
  readonly text: string;
}

export interface PhoneOptions {
  /** Deterministic sampling (temperature 0, topK 1). */
  greedy: boolean;
  temperature?: number;
}
export const ANALYSIS_OPTIONS: PhoneOptions = { greedy: true };

/** The model that answered (`ranOnDevice` comes from the SDK's `inferenceSource`, never assumed). */
export interface EngineResult {
  text: string;
  modelVersion: string;
  ranOnDevice: boolean;
  latencyMs: number;
}

/** Stand-in "model version" for Chrome's on-device model (the web SDK reports only inferenceSource). */
export const CHROME_ON_DEVICE_MODEL = "chrome-gemini-nano";

export interface TaskSpec {
  id: string;
  instruction: string;
  maxOutputTokens?: number;
}

/** Earlier turns of a sealed thread: user turns are SealedText; assistant turns are the model's own placeholder text. */
export type SealedTurn = { role: "user"; sealed: SealedText } | { role: "assistant"; modelText: string };
export interface SealedHistory {
  turns: SealedTurn[];
}

/** One streamed update. Cumulative. */
export interface EngineChunk {
  cumulativeText: string;
  modelVersion: string | null;
  ranOnDevice: boolean | null;
}

export type AnswerQuality = "auto" | "best";

/** The only engine that accepts a PhonePrompt (and thus raw text). */
export interface PhoneOnlyEngine {
  availability(): Promise<PhoneAvailability>;
  respond(prompt: PhonePrompt, options: PhoneOptions): Promise<EngineResult>;
}

/** Cloud-capable engine. Accepts ONLY SealedText (INV-1). */
export interface SealedEngine {
  readonly route: Route;
  respond(sealed: SealedText, task: TaskSpec, history?: SealedHistory): Promise<EngineResult>;
  stream(sealed: SealedText, task: TaskSpec, history?: SealedHistory): AsyncIterable<EngineChunk>;
}

export interface EngineProvider {
  readonly phone: PhoneOnlyEngine;
  sealed(route: Route, quality: AnswerQuality): SealedEngine;
}
