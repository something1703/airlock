import { renderedLegend, type SealedText } from "./types";
import type { SealedHistory, TaskSpec } from "./engines";

// Bundled prompts — synced from the Swift package (source of truth: docs/04-PROMPTS.md).
const FILES = import.meta.glob("./prompts/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const BUNDLED_PROMPT_IDS: string[] = Object.keys(FILES).map((p) => p.replace(/^\.\/prompts\//, "").replace(/\.txt$/, "")).sort();

export class PromptError extends Error {
  constructor(
    readonly id: string,
    readonly variable?: string,
  ) {
    super(variable ? `Prompt ${id}: unfilled {{${variable}}}` : `Prompt ${id} missing`);
    this.name = "PromptError";
  }
}

/**
 * Every prompt by versioned id (port of PromptLibrary.swift). Remote Config `prompt_overrides_json`
 * replaces prompts by id. `render` substitutes `{{name}}` in a single pass — values (user content) are
 * never re-scanned — and any unfilled placeholder is an error.
 */
export class PromptLibrary {
  private readonly prompts = new Map<string, string>();

  constructor(overridesJson = "{}") {
    for (const [path, text] of Object.entries(FILES)) {
      const id = path.replace(/^\.\/prompts\//, "").replace(/\.txt$/, "");
      this.prompts.set(id, text.endsWith("\n") ? text.slice(0, -1) : text);
    }
    try {
      const o: unknown = JSON.parse(overridesJson);
      if (o && typeof o === "object") for (const [id, text] of Object.entries(o)) if (typeof text === "string") this.prompts.set(id, text);
    } catch {
      // Ignore malformed overrides: bundled prompts stay in force.
    }
  }

  template(id: string): string {
    const t = this.prompts.get(id);
    if (t === undefined) throw new PromptError(id);
    return t;
  }

  render(id: string, vars: Record<string, string> = {}): string {
    const t = this.template(id);
    let out = "";
    let i = 0;
    while (i < t.length) {
      const open = t.indexOf("{{", i);
      if (open < 0) break;
      const close = t.indexOf("}}", open + 2);
      if (close < 0) break;
      out += t.slice(i, open);
      const name = t.slice(open + 2, close).trim();
      const value = vars[name];
      if (value === undefined) throw new PromptError(id, name);
      out += value;
      i = close + 2;
    }
    return out + t.slice(i);
  }

  /** The cloud user turn (`cloud-user.v1`) with replayed history — only sealed text and the model's own replies. */
  cloudUserTurn(sealed: SealedText, task: TaskSpec, history?: SealedHistory): string {
    const legend = sealed.legend.length === 0 ? "(none)" : renderedLegend(sealed);
    const turn = this.render("cloud-user.v1", { legend_lines: legend, task_instruction: task.instruction, sealed_text: sealed.value });
    if (!history || history.turns.length === 0) return turn;
    const earlier = history.turns
      .map((t) => (t.role === "user" ? `User:\n<<<\n${t.sealed.value}\n>>>` : `You replied:\n<<<\n${t.modelText}\n>>>`))
      .join("\n\n");
    return `Earlier in this conversation (placeholders mean the same things):\n\n${earlier}\n\n${turn}`;
  }
}
