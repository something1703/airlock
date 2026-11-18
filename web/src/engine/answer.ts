import { CHROME_ON_DEVICE_MODEL, EngineError, type AnswerQuality, type EngineProvider, type SealedHistory, type TaskSpec, type ToolName } from "./engines";
import type { EgressGate } from "./gate";
import type { Receipt } from "./hashchain";
import type { ReceiptLedger } from "./ledger";
import type { PromptLibrary } from "./prompts";
import { fidelityCheck, resultFrom, StreamingRestorer, type FidelityReport, type RestoreContext, type RestoreResult, type RestoredSegment } from "./restore";
import { AsyncQueue, runToolLoop, type ConsentBroker, type PrivateTool, type ToolActivity, type ToolContext } from "./tools";
import { renderedLegend, type Route, type SealedText } from "./types";

export type TaskKind =
  | { kind: "help" } | { kind: "explain" } | { kind: "questions" } | { kind: "summary" } | { kind: "actions" }
  | { kind: "reply"; tone: string } | { kind: "rewrite"; tone: string } | { kind: "custom" } | { kind: "meeting" };

/** "Propose a meeting time" is a reply draft (`task.reply.v1`) with this tone; the tools supply the dates. */
export const MEETING_TONE = "friendly and clear, proposing 2 specific meeting times that work for me";

export const promptIdOf = (t: TaskKind): string => (t.kind === "meeting" ? "task.reply.v1" : `task.${t.kind}.v1`);
/** Quick tasks run phone-first; deep ones cloud-first (docs/02-ARCHITECTURE.md §5). */
export const isQuick = (t: TaskKind): boolean => t.kind === "summary" || t.kind === "actions" || t.kind === "rewrite" || t.kind === "explain";
export const writesAsUser = (t: TaskKind): boolean => t.kind === "reply" || t.kind === "rewrite" || t.kind === "meeting";
/** Tasks where Gemini may call private tools (dates, roles, free time): drafting replies and proposing meetings. */
export const usesTools = (t: TaskKind): boolean => t.kind === "reply" || t.kind === "meeting";

export type AnswerPreference = "auto" | "phoneOnly" | "best";

/** Sealed text above this (UTF-16) goes cloud-only: too big for the on-device window with instructions and output. */
export const ON_DEVICE_LIMIT = 16_000;

export function route(task: TaskKind, sealed: SealedText, preference: AnswerPreference): { route: Route; quality: AnswerQuality } {
  if (preference === "phoneOnly") return { route: "phoneOnly", quality: "auto" };
  const size = sealed.value.length + renderedLegend(sealed).length;
  const quality: AnswerQuality = preference === "best" && !isQuick(task) ? "best" : "auto";
  if (size > ON_DEVICE_LIMIT) return { route: "cloudOnly", quality };
  return { route: isQuick(task) ? "phoneFirst" : "cloudFirst", quality };
}

/** Renders `task.*.v1`; `question` (required for custom) must itself be sealed. */
export function taskSpec(prompts: PromptLibrary, t: TaskKind, question?: SealedText): TaskSpec {
  const id = promptIdOf(t);
  const instruction =
    t.kind === "reply" || t.kind === "rewrite" ? prompts.render(id, { tone: t.tone })
    : t.kind === "meeting" ? prompts.render(id, { tone: MEETING_TONE })
    : t.kind === "custom" ? prompts.render(id, { user_question: question?.value ?? "Help me with this." })
    : prompts.render(id);
  return { id, instruction, maxOutputTokens: isQuick(t) ? 600 : 1500 };
}

/** Private tools for one answer. Only used for `usesTools` tasks on a cloud route (never phone-only). */
export interface ToolSetup {
  tools: readonly PrivateTool[];
  context: ToolContext;
  gate: EgressGate;
  broker: ConsentBroker;
  maxRounds: number;
  alwaysAllow?: ReadonlySet<ToolName>;
}

export interface AnswerOutcome {
  /** What the model wrote (placeholders) — the only answer text that may ever sync (INV-7). */
  modelText: string;
  /** Real names back in — local only. */
  restored: RestoreResult;
  fidelity: FidelityReport;
  route: Route;
  modelVersion: string;
  ranOnDevice: boolean;
  fellBackToPhone: boolean;
  latencyMs: number;
  receipt: Receipt | null;
  /** Private tool calls made while answering (with the exact gate-checked JSON that was returned to Gemini). */
  tools?: ToolActivity[];
}

export type AnswerEvent =
  | { kind: "started"; route: Route }
  | { kind: "partial"; text: string; segments: RestoredSegment[] }
  | { kind: "tools"; activity: ToolActivity[] }
  | { kind: "finished"; outcome: AnswerOutcome };

/**
 * Answers a sealed request: route → engine → streaming restore → receipt (port of AnswerService.swift).
 * Only SealedText reaches an engine; restore happens here. A receipt is written whenever the request may
 * have left the device (including a Model Armor block), but not for a phone-first answer that ran on device.
 * With `tools` (and a reply/meeting task on a cloud route) the answer runs cloud-only through the tool loop:
 * function responses are consented and gate-sealed (INV-5) before they leave.
 */
export async function* answer(args: {
  engines: EngineProvider;
  prompts: PromptLibrary;
  ledger: ReceiptLedger;
  sealed: SealedText;
  task: TaskKind;
  question?: SealedText;
  history?: SealedHistory;
  restore: RestoreContext;
  preference?: AnswerPreference;
  threadId: string;
  sealMs?: number;
  armorExpected?: boolean;
  tools?: ToolSetup;
}): AsyncGenerator<AnswerEvent, void, void> {
  const planned = route(args.task, args.sealed, args.preference ?? "auto");
  const quality = planned.quality;
  const withTools = !!args.tools && args.tools.tools.length > 0 && usesTools(args.task) && (planned.route === "cloudFirst" || planned.route === "cloudOnly");
  // Function responses can't be answered on device (verified in the SDK), so the tool loop is cloud-only.
  const r: Route = withTools ? "cloudOnly" : planned.route;
  const spec = taskSpec(args.prompts, args.task, args.question);
  yield { kind: "started", route: r };

  const ctx: RestoreContext = { ...args.restore, writingAsUser: writesAsUser(args.task) };
  let restorer = new StreamingRestorer(ctx);
  let modelText = "";
  let modelVersion = "";
  let ranOnDevice = false;
  let activity: ToolActivity[] | undefined;
  const t0 = performance.now();
  try {
    if (withTools && args.tools) {
      const setup = args.tools;
      const q = new AsyncQueue<AnswerEvent>();
      const onText = (t: string): void => {
        // Each model turn streams its own text; a new turn starts a fresh restore.
        if (!t.startsWith(modelText)) restorer = new StreamingRestorer(ctx);
        modelText = t;
        restorer.update(t);
        q.push({ kind: "partial", text: restorer.text, segments: [...restorer.segments] });
      };
      const run = runToolLoop({
        engine: args.engines.tools(quality), tools: setup.tools, context: setup.context, gate: setup.gate, broker: setup.broker, maxRounds: setup.maxRounds,
        addendum: args.prompts.template("tools-addendum.v1"), sealed: args.sealed, task: spec, history: args.history, alwaysAllow: setup.alwaysAllow,
        onText, onActivity: (a) => { activity = a; q.push({ kind: "tools", activity: a }); },
      });
      run.then(() => q.close(), (e: unknown) => q.close(e ?? new EngineError("other")));
      for await (const ev of q) yield ev;
      const res = await run;
      activity = res.activity;
      if (res.text !== modelText) {
        if (!res.text.startsWith(modelText)) restorer = new StreamingRestorer(ctx);
        modelText = res.text;
        restorer.update(modelText);
      }
      modelVersion = res.modelVersion;
      ranOnDevice = res.ranOnDevice;
    } else {
      for await (const chunk of args.engines.sealed(r, quality).stream(args.sealed, spec, args.history)) {
        modelText = chunk.cumulativeText;
        if (chunk.modelVersion) modelVersion = chunk.modelVersion;
        if (chunk.ranOnDevice !== null) ranOnDevice = chunk.ranOnDevice;
        restorer.update(modelText);
        yield { kind: "partial", text: restorer.text, segments: [...restorer.segments] };
      }
    }
  } catch (e) {
    if (e instanceof EngineError && e.code === "armorBlocked") {
      await args.ledger.append(args.sealed, args.threadId, r, "blocked", "blocked", args.sealMs ?? 0, performance.now() - t0);
    }
    throw e;
  }
  restorer.finish();
  yield { kind: "partial", text: restorer.text, segments: [...restorer.segments] };
  const latencyMs = performance.now() - t0;
  if (modelVersion === CHROME_ON_DEVICE_MODEL) ranOnDevice = true;
  const leftDevice = r !== "phoneOnly" && !(r === "phoneFirst" && ranOnDevice);
  const receipt = leftDevice
    ? await args.ledger.append(args.sealed, args.threadId, r, modelVersion, args.armorExpected ? "pass" : "notConfigured", args.sealMs ?? 0, latencyMs)
    : (args.ledger.recordOnDeviceAnswer(), null);
  yield {
    kind: "finished",
    outcome: {
      modelText, restored: resultFrom(restorer), fidelity: fidelityCheck(modelText, ctx), route: r, modelVersion, ranOnDevice,
      fellBackToPhone: ranOnDevice && (r === "cloudFirst" || r === "cloudOnly"), latencyMs, receipt, ...(activity ? { tools: activity } : {}),
    },
  };
}
