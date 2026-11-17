import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfig, DEFAULTS, remoteString } from "../src/core/appConfig";
import { repoRoot } from "./support";

describe("AppConfig", () => {
  it("defaults match firebase/remoteconfig.template.json key-for-key, value-for-value, type-for-type", () => {
    const t = JSON.parse(readFileSync(join(repoRoot, "firebase/remoteconfig.template.json"), "utf8")) as { parameters: Record<string, { defaultValue: { value: string }; valueType: string }> };
    expect(new Set(Object.keys(t.parameters))).toEqual(new Set(Object.keys(DEFAULTS)));
    for (const [k, v] of Object.entries(DEFAULTS)) {
      expect(t.parameters[k]!.defaultValue.value, k).toBe(remoteString(v));
      expect(t.parameters[k]!.valueType, k).toBe(v.type);
    }
  });
  it("remote overrides apply; bad values fall back; rounds clamp", () => {
    const c = new AppConfig({ redteam_rounds: "1", dial_default: "strict", detect_chunk_tokens_web: "oops", unknown: "x" });
    expect(c.redTeamRounds).toBe(1);
    expect(c.dialDefault).toBe("strict");
    expect(c.detectChunkTokens).toBe(3000);
    expect(new AppConfig({ redteam_rounds: "9" }).redTeamRounds).toBe(2);
    expect(new AppConfig({ pattern_packs_disabled: '["national"]' }).disabledPatternPacks).toEqual(new Set(["national"]));
  });
  it("stable models only", () => {
    for (const [k, v] of Object.entries(DEFAULTS)) if (k.startsWith("model_")) expect(remoteString(v)).not.toMatch(/preview|latest/);
  });
});
