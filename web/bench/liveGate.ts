// The live gate. Any AirlockBench step that would call a cloud model (Gemini via Firebase AI Logic) needs the
// repo owner's explicit permission, and those runs happen last on the separate evaluation Google Cloud project.
// Mock runs never get here. This check runs BEFORE any Firebase module is imported.

export const LIVE_ENV = "AIRLOCK_BENCH_LIVE_OK";

export interface LiveFlags {
  live: boolean;
  iHavePermission: boolean;
}

export class LiveRefused extends Error {
  constructor(readonly missing: string[]) {
    super(
      [
        "Refusing to run live: this would make cloud model calls (Gemini via Firebase AI Logic) on the evaluation project.",
        "Live evaluation needs the repo owner's explicit permission and runs last, on the separate evaluation Google Cloud project.",
        `Missing: ${missing.join("; ")}.`,
        `To run live, the owner must pass --live --i-have-permission AND set ${LIVE_ENV}=yes. Nothing was sent.`,
      ].join("\n"),
    );
    this.name = "LiveRefused";
  }
}

/** Throws `LiveRefused` unless all three conditions hold. Pure — no I/O, no imports. */
export function assertLiveAllowed(flags: LiveFlags, env: Readonly<Record<string, string | undefined>>): void {
  const missing: string[] = [];
  if (!flags.live) missing.push("--live");
  if (!flags.iHavePermission) missing.push("--i-have-permission");
  if (env[LIVE_ENV] !== "yes") missing.push(`${LIVE_ENV}=yes in the environment`);
  if (missing.length) throw new LiveRefused(missing);
}
