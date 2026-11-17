// Every tunable (port of AirlockCore/AppConfig.swift). The ONLY place a model name may be written
// in web code (lint-enforced). Must match firebase/remoteconfig.template.json (tests/appConfig.test.ts).

export type ConfigValue = { type: "STRING" | "JSON"; value: string } | { type: "NUMBER"; value: number } | { type: "BOOLEAN"; value: boolean };

export const DEFAULTS: Record<string, ConfigValue> = {
  ai_backend: { type: "STRING", value: "googleAI" },
  ai_location: { type: "STRING", value: "global" },
  model_cloud_deep: { type: "STRING", value: "gemini-3.8-flash" },
  model_cloud_quick: { type: "STRING", value: "gemini-3.5-flash-lite" },
  model_cloud_max: { type: "STRING", value: "gemini-4-hydrogen" },
  model_cloud_proof: { type: "STRING", value: "gemini-3.8-flash" },
  model_cloud_fallback: { type: "STRING", value: "gemini-3.5-flash-lite" },
  dial_default: { type: "STRING", value: "balanced" },
  detect_chunk_tokens: { type: "NUMBER", value: 1400 },
  detect_chunk_tokens_web: { type: "NUMBER", value: 3000 },
  detect_chunk_tokens_android: { type: "NUMBER", value: 700 },
  redteam_enabled: { type: "BOOLEAN", value: true },
  redteam_rounds: { type: "NUMBER", value: 2 },
  nltagger_enabled: { type: "BOOLEAN", value: true },
  vision_ocr_enabled: { type: "BOOLEAN", value: true },
  llm_structured_output: { type: "BOOLEAN", value: false },
  pattern_packs_disabled: { type: "JSON", value: "[]" },
  prompt_overrides_json: { type: "JSON", value: "{}" },
  feature_tools_calendar: { type: "BOOLEAN", value: true },
  feature_proof: { type: "BOOLEAN", value: true },
  feature_infer_card: { type: "BOOLEAN", value: true },
  feature_sync: { type: "BOOLEAN", value: true },
  evidence_json: { type: "JSON", value: "{}" },
  min_supported_build: { type: "NUMBER", value: 1 },
  raw_purge_days: { type: "NUMBER", value: 30 },
  armor_expected: { type: "BOOLEAN", value: false },
  armor_force_unary: { type: "BOOLEAN", value: false },
  cloud_first_chunk_ms: { type: "NUMBER", value: 15000 },
  cloud_timeout_ms: { type: "NUMBER", value: 90000 },
};

/** Remote Config's string form of a value. */
export const remoteString = (v: ConfigValue): string => (v.type === "BOOLEAN" ? (v.value ? "true" : "false") : String(v.value));

/** Typed config; unknown or mistyped remote values fall back to defaults. */
export class AppConfig {
  private readonly values: Record<string, ConfigValue>;

  constructor(remote: Record<string, string> = {}) {
    this.values = { ...DEFAULTS };
    for (const [key, raw] of Object.entries(remote)) {
      const def = DEFAULTS[key];
      if (!def) continue;
      if (def.type === "STRING" || def.type === "JSON") this.values[key] = { type: def.type, value: raw };
      else if (def.type === "BOOLEAN" && (raw === "true" || raw === "false")) this.values[key] = { type: "BOOLEAN", value: raw === "true" };
      else if (def.type === "NUMBER" && raw.trim() !== "" && Number.isFinite(Number(raw))) this.values[key] = { type: "NUMBER", value: Number(raw) };
    }
  }

  string(key: string): string {
    const v = this.values[key];
    return v && (v.type === "STRING" || v.type === "JSON") ? v.value : "";
  }
  bool(key: string): boolean {
    const v = this.values[key];
    return v?.type === "BOOLEAN" ? v.value : false;
  }
  int(key: string): number {
    const v = this.values[key];
    return v?.type === "NUMBER" ? Math.trunc(v.value) : 0;
  }

  get modelCloudDeep(): string { return this.string("model_cloud_deep"); }
  get modelCloudQuick(): string { return this.string("model_cloud_quick"); }
  get modelCloudMax(): string { return this.string("model_cloud_max"); }
  get modelCloudProof(): string { return this.string("model_cloud_proof"); }
  get dialDefault(): "open" | "balanced" | "strict" {
    const d = this.string("dial_default");
    return d === "open" || d === "strict" ? d : "balanced";
  }
  /** Chrome's on-device window is 9,216 tokens; the web budget is larger than iOS's 1,400. */
  get detectChunkTokens(): number { return Math.max(200, this.int("detect_chunk_tokens_web")); }
  get redTeamEnabled(): boolean { return this.bool("redteam_enabled"); }
  get redTeamRounds(): number { return Math.min(Math.max(0, this.int("redteam_rounds")), 2); }
  get rawPurgeDays(): number { return Math.max(0, this.int("raw_purge_days")); }
  get armorExpected(): boolean { return this.bool("armor_expected"); }
  /** Used when the planned cloud model stalls or is overloaded (503/429) before answering. */
  get modelCloudFallback(): string { return this.string("model_cloud_fallback"); }
  /** No first streamed chunk within this → abort and retry once as a unary call. */
  get cloudFirstChunkMs(): number { return Math.max(1000, this.int("cloud_first_chunk_ms")); }
  /** Hard limit for one cloud answer. */
  get cloudTimeoutMs(): number { return Math.max(5000, this.int("cloud_timeout_ms")); }
  get disabledPatternPacks(): Set<string> {
    try {
      const arr: unknown = JSON.parse(this.string("pattern_packs_disabled"));
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }
  get promptOverridesJson(): string { return this.string("prompt_overrides_json"); }
}
