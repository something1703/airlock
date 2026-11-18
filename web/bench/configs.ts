// Ablation configurations (docs/07-EVALUATION.md §5), as the TypeScript runner implements them.
import type { DialPreset } from "../src/engine/types";

export type ConfigId = "A_raw" | "B_rules" | "C_rules_nl" | "D_llm" | "E_redteam" | "F_vault" | "G_naive_redact";

export interface BenchConfig {
  id: ConfigId;
  /** Label used in reports and on the Evidence screen. */
  label: string;
  layers: string;
  dial: DialPreset;
  /** Nothing is sealed: the raw text is the egress (baseline only, synthetic data only). */
  raw: boolean;
  /** D4 on-device LLM detector + generaliser. */
  llm: boolean;
  redTeam: boolean;
  /** Vault seeded with the synthetic profile's name, city and employer. */
  vault: boolean;
  /** `[REDACTED]` instead of placeholders, no legend. */
  redact: boolean;
  /** null when the TypeScript engine can run it; otherwise why not. */
  unsupported: string | null;
}

export const CONFIGS: Record<ConfigId, BenchConfig> = {
  A_raw: { id: "A_raw", label: "Unprotected", layers: "nothing sealed (quality baseline)", dial: "balanced", raw: true, llm: false, redTeam: false, vault: false, redact: false, unsupported: null },
  B_rules: { id: "B_rules", label: "Rules", layers: "D1 Vault (empty) + D2 patterns", dial: "balanced", raw: false, llm: false, redTeam: false, vault: false, redact: false, unsupported: null },
  C_rules_nl: {
    id: "C_rules_nl", label: "+NL tagger", layers: "B + D3 NaturalLanguage tagger", dial: "balanced", raw: false, llm: false, redTeam: false, vault: false, redact: false,
    unsupported: "D3 (Apple NaturalLanguage tagger) exists only in the Swift engine; the TypeScript engine has no NL tagger",
  },
  D_llm: { id: "D_llm", label: "+On-device model", layers: "B + D4 on-device LLM detector", dial: "balanced", raw: false, llm: true, redTeam: false, vault: false, redact: false, unsupported: null },
  E_redteam: { id: "E_redteam", label: "+Red-team", layers: "D + red-team auto-apply (Strict)", dial: "strict", raw: false, llm: true, redTeam: true, vault: false, redact: false, unsupported: null },
  F_vault: { id: "F_vault", label: "+Your Vault", layers: "E + Vault seeded with the profile", dial: "strict", raw: false, llm: true, redTeam: true, vault: true, redact: false, unsupported: null },
  G_naive_redact: { id: "G_naive_redact", label: "Redact", layers: "D with [REDACTED] instead of placeholders + legend", dial: "balanced", raw: false, llm: true, redTeam: false, vault: false, redact: true, unsupported: null },
};

export const ALL_CONFIG_IDS: ConfigId[] = ["A_raw", "B_rules", "C_rules_nl", "D_llm", "E_redteam", "F_vault", "G_naive_redact"];
/** `--smoke` runs one config (docs/07 §2) — the Day-3 go/no-go measures D_llm recall. */
export const SMOKE_CONFIG: ConfigId = "D_llm";

export function parseConfigs(list: string | undefined): ConfigId[] {
  if (!list) return ALL_CONFIG_IDS;
  const ids = list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const id of ids) if (!(id in CONFIGS)) throw new Error(`Unknown config ${id} (expected one of ${ALL_CONFIG_IDS.join(", ")})`);
  return ids as ConfigId[];
}
