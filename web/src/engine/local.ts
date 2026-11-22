import { CHROME_ON_DEVICE_MODEL, EngineError, type PhoneAvailability, type PhoneOnlyEngine } from "./engines";
import type { PromptLibrary } from "./prompts";
import { isQuick, ON_DEVICE_LIMIT, taskSpec, type AnswerPreference, type TaskKind } from "./answer";

/**
 * FX-02: a quick task that never needs the cloud skips the seal and the Review screen. The raw message goes to the phone-only
 * engine and nowhere else (INV-3) — nothing is sent, so there is nothing to check before sending.
 *
 * Applies when the on-device model is available, the message fits its window, and either the task is a quick one
 * (summary, explain, actions, rewrite) or the user chose "This device only". "Best answer" always goes to Gemini.
 * Otherwise (including any failure) the normal seal → Review → gate flow runs.
 */
export function runsOnDevice(task: TaskKind, preference: AnswerPreference, availability: PhoneAvailability | "checking", rawLength: number): boolean {
  if (availability !== "available" || rawLength > ON_DEVICE_LIMIT || preference === "best") return false;
  return preference === "phoneOnly" || isQuick(task);
}

/** Earlier exchanges of a conversation that also stayed on the device (raw message + the on-device answer). */
export interface LocalExchange {
  raw: string;
  answer: string;
}

/** At most this many characters of earlier exchanges go in front of a follow-up (the on-device window is small). */
const EARLIER_BUDGET = 8_000;

export interface LocalAnswer {
  text: string;
  modelVersion: string;
  latencyMs: number;
}

/** One on-device answer from the raw message. Throws `EngineError` (the caller then falls back to Review). */
export async function answerOnDevice(args: { phone: PhoneOnlyEngine; prompts: PromptLibrary; task: TaskKind; raw: string; earlier?: readonly LocalExchange[] }): Promise<LocalAnswer> {
  const turn = args.prompts.render("phone-local.v1", { task_instruction: taskSpec(args.prompts, args.task).instruction, text: args.raw });
  const kept: string[] = [];
  let used = 0;
  for (const x of [...(args.earlier ?? [])].reverse()) {
    const block = `User:\n<<<\n${x.raw}\n>>>\n\nYou replied:\n<<<\n${x.answer}\n>>>`;
    if (used + block.length > EARLIER_BUDGET) break;
    kept.unshift(block);
    used += block.length;
  }
  const text = kept.length ? `Earlier in this conversation:\n\n${kept.join("\n\n")}\n\n${turn}` : turn;
  const r = await args.phone.respond({ promptId: "phone-local.v1", text }, { greedy: false });
  const answer = r.text.trim();
  if (!answer) throw new EngineError("other", "empty-answer");
  return { text: answer, modelVersion: r.modelVersion || CHROME_ON_DEVICE_MODEL, latencyMs: r.latencyMs };
}

/** Thread title for a conversation that has no sealed text yet: the task, never the user's words (titles can sync). */
export function localTitle(task: TaskKind): string {
  switch (task.kind) {
    case "summary": return "Summary of a message";
    case "explain": return "Explanation of a message";
    case "actions": return "Actions from a message";
    case "rewrite": return "Rewritten message";
    case "questions": return "Questions to ask";
    case "reply": return "Reply to a message";
    case "meeting": return "Meeting time";
    case "help": return "Help with a message";
    case "custom": return "Conversation";
  }
}
