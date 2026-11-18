// Evidence (docs/06-UI-UX.md §5.12): what AirlockBench measured, shown in the app. Sources, in order:
//   1. Remote Config `evidence_json` (so the final run can go live without a redeploy),
//   2. the newest NON-mock run committed under eval/reports/<run>/evidence.json,
//   3. the newest mock run — always shown with its "MOCK RUN" label, never as real results.
// Schema: eval/schemas/evidence.schema.json.

export interface Measure {
  value: number;
  low: number;
  high: number;
  n: number;
}

export interface Evidence {
  schemaVersion: number;
  mock: boolean;
  label?: string;
  runId: string;
  createdAt: string;
  dataset: string;
  split: string;
  n: number;
  languages: string[];
  onDeviceModel?: string;
  headlineConfig?: string;
  leakRate: Measure;
  leakRateWithVault?: Measure;
  namesCaught: Measure;
  quality: Measure;
  onDevice?: Measure;
  restoreFidelity?: Measure;
  reidTwoAttrs?: Measure;
  gateBlockRate?: Measure;
  ablation: { config: string; label: string; leak: Measure }[];
  misses: string[];
  method: string;
}

const isMeasure = (m: unknown): m is Measure =>
  !!m && typeof m === "object" && ["value", "low", "high", "n"].every((k) => typeof (m as Record<string, unknown>)[k] === "number");

/** Structural check — anything malformed is ignored rather than shown. */
export function parseEvidence(raw: unknown): Evidence | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== 1 || typeof e.mock !== "boolean" || typeof e.runId !== "string") return null;
  if (!isMeasure(e.leakRate) || !isMeasure(e.namesCaught) || !isMeasure(e.quality)) return null;
  if (!Array.isArray(e.ablation) || !e.ablation.every((a) => a && typeof a === "object" && typeof (a as { label?: unknown }).label === "string" && isMeasure((a as { leak?: unknown }).leak))) return null;
  if (!Array.isArray(e.misses) || !e.misses.every((m) => typeof m === "string")) return null;
  if (e.mock && typeof e.label !== "string") return null; // a mock run must carry its label
  return e as unknown as Evidence;
}

/** Real runs beat mock runs; newer beats older. */
export function pickEvidence(candidates: readonly unknown[]): Evidence | null {
  const valid = candidates.map(parseEvidence).filter((e): e is Evidence => e !== null);
  valid.sort((a, b) => Number(a.mock) - Number(b.mock) || b.createdAt.localeCompare(a.createdAt));
  return valid[0] ?? null;
}

const bundled = import.meta.glob("../../../eval/reports/*/evidence.json", { eager: true, import: "default" });

/** `remoteJson` is AppConfig's `evidence_json` ("{}" when unset). */
export function loadEvidence(remoteJson: string): Evidence | null {
  try {
    const remote = parseEvidence(JSON.parse(remoteJson));
    if (remote) return remote;
  } catch {
    // Fall through to the bundled reports.
  }
  return pickEvidence(Object.values(bundled));
}

export const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`;
