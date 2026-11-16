import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as engine from "../src/engine";
import { repoRoot } from "./support";

/** INV-2: only the egress gate may create SealedText. */
describe("SealedText construction", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist" || f === ".vite") return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

  it("only gate.ts (and sealedInternal.ts itself) reference the factory", () => {
    const offenders = files(join(repoRoot, "web/src")).filter((f) => !/engine\/(gate|sealedInternal)\.ts$/.test(f) && readFileSync(f, "utf8").includes("__createSealedText"));
    expect(offenders.map((f) => relative(repoRoot, f))).toEqual([]);
  });
  it("the factory is not exported from the public engine surface", () => {
    expect(Object.keys(engine)).not.toContain("__createSealedText");
  });
  it("sealed text is frozen", () => {
    const s = new engine.EgressGate(new engine.PatternDetector(), []).sealToolResult('{"a":1}', new engine.EntityMap());
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.legend)).toBe(true);
  });
});
