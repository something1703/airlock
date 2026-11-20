// Engine contracts (port of AirlockCore/Engines.swift). No Firebase here: src/ai/ implements these with
// Firebase AI Logic; mocks.ts implements them for tests and previews.
import type { SenderType, TacticId } from "./proof";
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
  /** The model stopped because it hit the output-token limit (finish reason MAX_TOKENS). */
  truncated?: boolean;
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
  /** The model stopped because it hit the output-token limit (finish reason MAX_TOKENS). */
  truncated?: boolean;
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

// MARK: Private tools (function calling) — docs/02-ARCHITECTURE.md §6.3, docs/04-PROMPTS.md §6

export type ToolName = "today_context" | "find_free_slots" | "get_entity_role";

export interface ToolParam {
  type: "string" | "integer";
  description: string;
}

/** A function the cloud model may call. Plain data: the Firebase engine maps it to a `FunctionDeclaration`. */
export interface ToolDeclaration {
  name: ToolName;
  description: string;
  parameters?: { properties: Record<string, ToolParam>; required: string[] };
}

/** A function call the model asked for. `args` came from the cloud: untrusted input. */
export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A function response that passed `EgressGate.sealToolResult` (INV-5). `sealed.value` is the JSON object
 * sent back to the model — the type makes it impossible to hand an engine an unchecked tool result.
 */
export interface SealedToolResponse {
  id?: string;
  name: string;
  sealed: SealedText;
}

/** One model turn in a tool conversation: text so far, and any function calls it asked for. */
export interface ToolTurn {
  text: string;
  calls: ToolCall[];
  modelVersion: string;
  ranOnDevice: boolean;
}

/**
 * One multi-turn tool conversation about one sealed request (INV-4: never reused for another request).
 * `onText` receives cumulative text while a turn streams.
 */
export interface ToolChat {
  send(sealed: SealedText, task: TaskSpec, history: SealedHistory | undefined, onText?: (cumulative: string) => void): Promise<ToolTurn>;
  respond(results: readonly SealedToolResponse[], onText?: (cumulative: string) => void): Promise<ToolTurn>;
}

/** Cloud-only engine with function calling. Accepts only SealedText and SealedToolResponse (INV-1, INV-5). */
export interface ToolEngine {
  readonly route: Route;
  chat(declarations: readonly ToolDeclaration[], addendum: string): ToolChat;
}

/** One web page the cloud model used to ground its answer (`groundingMetadata.groundingChunks[i].web`). */
export interface GroundingSource {
  /** Index into the response's `groundingChunks` (what `GroundingSupport.groundingChunkIndices` refer to). */
  chunkIndex: number;
  title: string;
  uri: string;
}

/** A piece of the answer text and the chunks that support it (`groundingMetadata.groundingSupports`). */
export interface GroundingSupportRef {
  text: string;
  chunkIndices: number[];
}

/**
 * A Google Search–grounded answer. `searchEntryPointHtml` is Google's Search Suggestions snippet
 * (`searchEntryPoint.renderedContent`) — it must be displayed, unmodified, with the answer.
 */
export interface GroundedResult extends EngineResult {
  sources: GroundingSource[];
  supports: GroundingSupportRef[];
  searchEntryPointHtml: string | null;
  webSearchQueries: string[];
}

/** What the claim check may know besides the sealed claim: fixed vocabularies only, never user text. */
export interface ClaimContext {
  tactics: readonly TacticId[];
  senderType: SenderType;
}

/**
 * Proof mode's cloud check (`claimcheck.v1`): cloud-only Gemini with Google Search grounding.
 * Accepts ONLY SealedText plus fixed-vocabulary context (INV-1); never runs on device.
 */
export interface ClaimCheckEngine {
  check(sealedClaim: SealedText, context: ClaimContext): Promise<GroundedResult>;
}

export interface EngineProvider {
  readonly phone: PhoneOnlyEngine;
  sealed(route: Route, quality: AnswerQuality): SealedEngine;
  /** Function-calling engine for private tools (always cloud-only: function responses can't run on device). */
  tools(quality: AnswerQuality): ToolEngine;

  /** Search-grounded claim check (Proof mode). Absent when there is no cloud (no Firebase config). */
  readonly claimCheck?: ClaimCheckEngine;
}
