import { CHROME_ON_DEVICE_MODEL, EngineError, type ClaimCheckEngine, type ClaimContext, type GroundedResult, type EngineChunk, type EngineProvider, type EngineResult, type PhoneAvailability, type PhoneOnlyEngine, type PhoneOptions, type PhonePrompt, type SealedEngine, type SealedHistory, type TaskSpec, type AnswerQuality } from "./engines";
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
  ) {}

  async respond(sealed: SealedText, task: TaskSpec, _history?: SealedHistory): Promise<EngineResult> {
    this.received.push(sealed);
    const text = await this.handler(sealed, task);
    return { text, modelVersion: this.modelVersion, ranOnDevice: this.modelVersion === CHROME_ON_DEVICE_MODEL, latencyMs: 1 };
  }

  async *stream(sealed: SealedText, task: TaskSpec, history?: SealedHistory): AsyncIterable<EngineChunk> {
    const r = await this.respond(sealed, task, history);
    let acc = "";
    for (const ch of r.text) {
      acc += ch;
      if (acc.length % 12 === 0) yield { cumulativeText: acc, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice };
    }
    yield { cumulativeText: acc, modelVersion: r.modelVersion, ranOnDevice: r.ranOnDevice };
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
    readonly claimCheck?: ClaimCheckEngine,
  ) {}

  sealed(route: Route, _quality: AnswerQuality): SealedEngine {
    return this.sealedEngines[route] ?? new MockSealedEngine(route, () => "Here's a reply for [[PERSON_1]].");
  }
}
