import type { EngineResult, PhoneAvailability, PhoneOnlyEngine, PhoneOptions, PhonePrompt } from "./engines";

/**
 * Where a seal's time went (FX-02). Numbers only — never content, never a prompt (INV-8). Shown in Review's
 * "Timing" disclosure and kept with the thread in memory; not part of the hashed receipt.
 */
export interface SealTimings {
  /** Vault + pattern detection. */
  rulesMs: number;
  detectMs: number;
  /** `detect.*` calls (one per chunk, more when a chunk is halved). */
  detectCalls: number;
  /** `detect-repair.*` calls (broken JSON). */
  repairCalls: number;
  generaliseMs: number;
  generaliseCalls: number;
  redTeamMs: number;
  redTeamCalls: number;
  /** From the start of the seal to the first on-device reply; null when no model call ran. */
  firstModelOutputMs: number | null;
  /** The whole seal, up to the draft Review shows (red-team included only when Review waited for it). */
  totalMs: number;
}

export const emptyTimings = (): SealTimings => ({
  rulesMs: 0, detectMs: 0, detectCalls: 0, repairCalls: 0, generaliseMs: 0, generaliseCalls: 0, redTeamMs: 0, redTeamCalls: 0, firstModelOutputMs: null, totalMs: 0,
});

/**
 * Wraps the phone-only engine for one seal and counts calls by prompt-id family (`detect`, `detect-repair`, …).
 * Still a PhoneOnlyEngine: it only forwards (INV-3).
 */
export class CallMeter implements PhoneOnlyEngine {
  private readonly counts = new Map<string, number>();
  private firstReplyAt: number | null = null;
  private total = 0;

  constructor(
    private readonly inner: PhoneOnlyEngine,
    private readonly startedAt: number,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  availability(): Promise<PhoneAvailability> {
    return this.inner.availability();
  }

  async respond(prompt: PhonePrompt, options: PhoneOptions): Promise<EngineResult> {
    const family = prompt.promptId.replace(/\.v\d+$/u, "");
    this.counts.set(family, (this.counts.get(family) ?? 0) + 1);
    this.total++;
    try {
      return await this.inner.respond(prompt, options);
    } finally {
      this.firstReplyAt ??= this.clock() - this.startedAt;
    }
  }

  calls(family?: string): number {
    return family === undefined ? this.total : (this.counts.get(family) ?? 0);
  }

  get firstModelOutputMs(): number | null {
    return this.firstReplyAt;
  }
}
