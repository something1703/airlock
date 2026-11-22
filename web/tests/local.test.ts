import { describe, expect, it } from "vitest";
import { EngineError, MockPhoneEngine, PromptLibrary, answerOnDevice, localTitle, runsOnDevice, type TaskKind } from "../src/engine";

const prompts = new PromptLibrary();
const summary: TaskKind = { kind: "summary" };

describe("runsOnDevice (FX-02): when a request is answered with no seal and no Review", () => {
  it("quick tasks with the model available, unless the user wants the best answer", () => {
    for (const kind of ["summary", "explain", "actions"] as const) expect(runsOnDevice({ kind }, "auto", "available", 500), kind).toBe(true);
    expect(runsOnDevice({ kind: "rewrite", tone: "firm" }, "auto", "available", 500)).toBe(true);
    expect(runsOnDevice(summary, "best", "available", 500)).toBe(false);
  });
  it("deep tasks only when the user chose 'This device only'", () => {
    for (const task of [{ kind: "help" }, { kind: "reply", tone: "firm" }, { kind: "questions" }, { kind: "meeting" }] as TaskKind[]) {
      expect(runsOnDevice(task, "auto", "available", 500), task.kind).toBe(false);
      expect(runsOnDevice(task, "phoneOnly", "available", 500), task.kind).toBe(true);
      expect(runsOnDevice(task, "best", "available", 500), task.kind).toBe(false);
    }
  });
  it("never without the model, and never for a message too big for its window", () => {
    for (const a of ["unavailable", "downloadable", "downloading", "unknown", "checking"] as const) expect(runsOnDevice(summary, "phoneOnly", a, 500), a).toBe(false);
    expect(runsOnDevice(summary, "auto", "available", 16_000)).toBe(true);
    expect(runsOnDevice(summary, "auto", "available", 16_001)).toBe(false);
  });
});

describe("answerOnDevice", () => {
  it("sends the raw message and the task to the phone-only engine only, as phone-local.v1", async () => {
    const phone = new MockPhoneEngine(() => "  - Raj is late.\n- Ask for a date.  ");
    const r = await answerOnDevice({ phone, prompts, task: summary, raw: "Raj Patel said the heater is fixed on Friday." });
    expect(phone.calledPromptIds).toEqual(["phone-local.v1"]);
    expect(phone.calls[0]!.text).toContain("Raj Patel said the heater is fixed on Friday.");
    expect(phone.calls[0]!.text).toContain("Summarise this in 5 bullet points.");
    expect(r.text).toBe("- Raj is late.\n- Ask for a date.");
  });
  it("puts earlier exchanges in front, newest kept first when they don't all fit", async () => {
    const phone = new MockPhoneEngine(() => "ok");
    const big = "x".repeat(8_000);
    await answerOnDevice({ phone, prompts, task: summary, raw: "now", earlier: [{ raw: "oldest", answer: big }, { raw: "recent", answer: "short" }] });
    const sent = phone.calls[0]!.text;
    expect(sent).toContain("Earlier in this conversation:");
    expect(sent).toContain("recent");
    expect(sent).not.toContain("oldest");
    expect(sent.indexOf("recent")).toBeLessThan(sent.indexOf("now"));
  });
  it("an empty answer is an error, so the caller falls back to the normal flow", async () => {
    await expect(answerOnDevice({ phone: MockPhoneEngine.answering("  \n "), prompts, task: summary, raw: "hi" })).rejects.toBeInstanceOf(EngineError);
    await expect(answerOnDevice({ phone: MockPhoneEngine.answering("x", "unavailable"), prompts, task: summary, raw: "hi" })).rejects.toBeInstanceOf(EngineError);
  });
  it("titles come from the task, never from the user's words", () => {
    expect(localTitle(summary)).toBe("Summary of a message");
    for (const kind of ["summary", "explain", "actions", "questions", "help", "custom", "meeting"] as const) expect(localTitle({ kind } as TaskKind)).not.toMatch(/\bRaj\b/);
  });
});
