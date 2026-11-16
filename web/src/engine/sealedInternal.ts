// INV-2: the ONLY place a SealedText is created. Imported by gate.ts and nothing else
// (enforced by tests/sealed.test.ts and scripts/lint.mjs).
import type { GateReport, LegendLine, SealedText } from "./types";

export function __createSealedText(value: string, legend: readonly LegendLine[], gateReport: GateReport): SealedText {
  return Object.freeze({ value, legend: Object.freeze([...legend]), gateReport }) as unknown as SealedText;
}
