import {
  CHROME_ON_DEVICE_MODEL, EngineError, type AnswerQuality, type ClaimCheckEngine, type ClaimContext, type EngineChunk, type EngineProvider, type EngineResult, type GroundedResult, type PhoneAvailability, type PhoneOnlyEngine, type PhoneOptions, type PhonePrompt, type SealedEngine, type SealedHistory, type SealedToolResponse, type TaskSpec, type ToolCall, type ToolChat, type ToolDeclaration, type ToolEngine, type ToolTurn,
} from "./engines";
import type { Route, SealedText } from "./types";

/** Scriptable on-device engine. Records every call so tests can prove what reached which engine. */
export class MockPhoneEngine implements PhoneOnlyEngine {
  readonly calls: { promptId: string; text: string }[] = [];

  constructor(
    private readonly handler: (promptId: string, text: string) => string | Promise<string>,
    private readonly avail: PhoneAvailability = "available",
  ) {}

  static answering(text: string, avail: PhoneAvailability = "available"): MockPhoneEngine {
    return new MockPhoneEngine(() => text, avail);
  }

  async availability(): Promise<PhoneAvailability> {
    return this.avail;
  }

  async respond(prompt: PhonePrompt, _options: PhoneOptions): Promise<EngineResult> {
    this.calls.push({ promptId: prompt.promptId, text: prompt.text });
    if (this.avail !== "available") throw new EngineError("unavailable", this.avail);
    const text = await this.handler(prompt.promptId, prompt.text);
    return { text, modelVersion: CHROME_ON_DEVICE_MODEL, ranOnDevice: true, latencyMs: 0 };
  }

  get calledPromptIds(): string[] {
    return this.calls.map((c) => c.promptId);
  }
}

/** Scriptable sealed engine; records every SealedText it receives; streams cumulative snapshots. */
export class MockSealedEngine implements SealedEngine {
  readonly received: SealedText[] = [];

  constructor(
    readonly route: Route,
    private readonly handler: (sealed: SealedText, task: TaskSpec) => string | Promise<string>,
    private readonly modelVersion = "mock-gemini",
    /** Simulates a reply cut off at the output-token limit. */
    private readonly truncated = false,
  ) {}

  async respond(sealed: SealedText, task: TaskSpec, _history?: SealedHistory): Promise<EngineResult> {
    this.received.push(sealed);
    const text = await this.handler(sealed, task);
    return { text, modelVersion: this.modelVersion, ranOnDevice: this.modelVersion === CHROME_ON_DEVICE_MODEL, latencyMs: 1, ...(this.truncated ? { truncated: true } : {}) };
  }

  async *stream(sealed: SealedText, task: TaskSpec, history?: SealedHistory): AsyncIterable<EngineChunk> {
    const r = await this.respond(sealed, task, history);
    let acc = "";
    for (const ch of r.text) {
      acc += ch;
      if (acc.length % 12 === 0) yield { cumulativeText: acc, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice };
    }
    yield { cumulativeText: acc, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice, ...(r.truncated ? { truncated: true } : {}) };
  }
}

export interface ScriptedToolTurn {
  text?: string;
  calls?: ToolCall[];
}
/** `round` 0 answers the sealed request; round n answers the n-th batch of function responses. */
export type ToolScript = (
  round: number,
  ctx: { sealed: SealedText; task: TaskSpec; results: readonly SealedToolResponse[]; declarations: readonly ToolDeclaration[] },
) => ScriptedToolTurn | Promise<ScriptedToolTurn>;

/**
 * Scriptable function-calling engine. Records every sealed request and every batch of function responses,
 * so tests can prove exactly what reached the "cloud" (INV-5).
 */
export class MockToolEngine implements ToolEngine {
  readonly route: Route = "cloudOnly";
  readonly received: SealedText[] = [];
  readonly responses: SealedToolResponse[][] = [];
  readonly declarations: ToolDeclaration[][] = [];
  readonly addenda: string[] = [];

  constructor(
    private readonly script: ToolScript,
    private readonly modelVersion = "mock-gemini",
  ) {}

  chat(declarations: readonly ToolDeclaration[], addendum: string): ToolChat {
    this.declarations.push([...declarations]);
    this.addenda.push(addendum);
    let round = 0;
    let request: { sealed: SealedText; task: TaskSpec } | null = null;
    const turn = async (results: readonly SealedToolResponse[], onText?: (t: string) => void): Promise<ToolTurn> => {
      if (!request) throw new EngineError("other", "respond-before-send");
      const out = await this.script(round++, { ...request, results, declarations });
      const text = out.text ?? "";
      if (text && onText) {
        onText(text.slice(0, Math.ceil(text.length / 2)));
        onText(text);
      }
      return { text, calls: out.calls ?? [], modelVersion: this.modelVersion, ranOnDevice: false };
    };
    return {
      send: (sealed, task, _history, onText) => {
        this.received.push(sealed);
        request = { sealed, task };
        return turn([], onText);
      },
      respond: (results, onText) => {
        this.responses.push([...results]);
        return turn(results, onText);
      },
    };
  }

  /** Every function-response JSON that was returned to the model. */
  get sentResults(): string[] {
    return this.responses.flat().map((r) => r.sealed.value);
  }
}

/** Scriptable search-grounded claim check; records every SealedText (and context) it receives. */
export class MockClaimCheckEngine implements ClaimCheckEngine {
  readonly received: { sealed: SealedText; context: ClaimContext }[] = [];

  constructor(private readonly handler: (sealed: SealedText, context: ClaimContext) => Partial<GroundedResult> | Promise<Partial<GroundedResult>>) {}

  async check(sealed: SealedText, context: ClaimContext): Promise<GroundedResult> {
    this.received.push({ sealed, context });
    const r = await this.handler(sealed, context);
    return { text: "VERDICT: UNCLEAR", modelVersion: "mock-gemini-search", ranOnDevice: false, latencyMs: 1, sources: [], supports: [], searchEntryPointHtml: null, webSearchQueries: [], ...r };
  }
}

export class MockEngines implements EngineProvider {
  constructor(
    readonly phone: PhoneOnlyEngine = MockPhoneEngine.answering('{"items":[]}'),
    private readonly sealedEngines: Partial<Record<Route, SealedEngine>> = {},
    readonly toolEngine: ToolEngine = new MockToolEngine(() => ({ text: "Here's a reply for [[PERSON_1]]." })),

    readonly claimCheck?: ClaimCheckEngine,
  ) {}

  sealed(route: Route, _quality: AnswerQuality): SealedEngine {
    return this.sealedEngines[route] ?? new MockSealedEngine(route, () => "Here's a reply for [[PERSON_1]].");
  }

  tools(_quality: AnswerQuality): ToolEngine {
    return this.toolEngine;
  }
}
