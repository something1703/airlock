import { CHROME_ON_DEVICE_MODEL, EngineError, type AnswerQuality, type EngineProvider, type SealedHistory, type TaskSpec } from "./engines";
import type { Receipt } from "./hashchain";
import type { ReceiptLedger } from "./ledger";
import type { PromptLibrary } from "./prompts";
import { fidelityCheck, resultFrom, StreamingRestorer, type FidelityReport, type RestoreContext, type RestoreResult, type RestoredSegment } from "./restore";
import { renderedLegend, type Route, type SealedText } from "./types";

export type TaskKind =
  | { kind: "help" } | { kind: "explain" } | { kind: "questions" } | { kind: "summary" } | { kind: "actions" }
  | { kind: "reply"; tone: string } | { kind: "rewrite"; tone: string } | { kind: "custom" };

export const promptIdOf = (t: TaskKind): string => `task.${t.kind}.v1`;
/** Quick tasks run phone-first; deep ones cloud-first (docs/02-ARCHITECTURE.md §5). */
export const isQuick = (t: TaskKind): boolean => t.kind === "summary" || t.kind === "actions" || t.kind === "rewrite" || t.kind === "explain";
export const writesAsUser = (t: TaskKind): boolean => t.kind === "reply" || t.kind === "rewrite";

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
    : t.kind === "custom" ? prompts.render(id, { user_question: question?.value ?? "Help me with this." })
    : prompts.render(id);
  return { id, instruction, maxOutputTokens: isQuick(t) ? 600 : 1500 };
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
}

export type AnswerEvent = { kind: "started"; route: Route } | { kind: "partial"; text: string; segments: RestoredSegment[] } | { kind: "finished"; outcome: AnswerOutcome };

/**
 * Answers a sealed request: route → engine → streaming restore → receipt (port of AnswerService.swift).
 * Only SealedText reaches an engine; restore happens here. A receipt is written whenever the request may
 * have left the device (including a Model Armor block), but not for a phone-first answer that ran on device.
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
}): AsyncGenerator<AnswerEvent, void, void> {
  const { route: r, quality } = route(args.task, args.sealed, args.preference ?? "auto");
  const spec = taskSpec(args.prompts, args.task, args.question);
  yield { kind: "started", route: r };

  const ctx: RestoreContext = { ...args.restore, writingAsUser: writesAsUser(args.task) };
  const restorer = new StreamingRestorer(ctx);
  let modelText = "";
  let modelVersion = "";
  let ranOnDevice = false;
  const t0 = performance.now();
  try {
    for await (const chunk of args.engines.sealed(r, quality).stream(args.sealed, spec, args.history)) {
      modelText = chunk.cumulativeText;
      if (chunk.modelVersion) modelVersion = chunk.modelVersion;
      if (chunk.ranOnDevice !== null) ranOnDevice = chunk.ranOnDevice;
      restorer.update(modelText);
      yield { kind: "partial", text: restorer.text, segments: [...restorer.segments] };
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
      fellBackToPhone: ranOnDevice && (r === "cloudFirst" || r === "cloudOnly"), latencyMs, receipt,
    },
  };
}
