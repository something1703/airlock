// AirlockBench synthetic data: deterministic, valid, fictional, scanner-safe (docs/07-EVALUATION.md §3).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGES, type BenchItem } from "../bench/dataset";
import { DOC_TYPES } from "../bench/synth/templates";
import { DEFAULT_SEED, generateDataset, generateDemoSet, iban, validateItem } from "../bench/synth/synth";
import { isNormalised } from "../src/engine/normaliser";
import { repoRoot } from "./support";

const jsonl = (items: BenchItem[]): string => items.map((i) => JSON.stringify(i)).join("\n") + "\n";
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const v1 = generateDataset("synth-v1");
const hard = generateDataset("synth-hard");
const demo = generateDemoSet();

describe("synth-tpl.v1 generator", () => {
  it("is deterministic: same seed, same bytes; another seed, different data", () => {
    expect(jsonl(generateDataset("synth-v1"))).toBe(jsonl(v1));
    expect(jsonl(generateDataset("synth-v1", DEFAULT_SEED + 1))).not.toBe(jsonl(v1));
  });

  it("matches the hashes pinned in eval/datasets/MANIFEST.json (regenerate with `npm run bench -- generate`)", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "eval/datasets/MANIFEST.json"), "utf8")) as { seed: number; files: Record<string, { items: number; sha256: string }> };
    expect(manifest.seed).toBe(DEFAULT_SEED);
    expect(manifest.files["synth-v1.jsonl"]!.sha256).toBe(sha(jsonl(v1)));
    expect(manifest.files["synth-hard.jsonl"]!.sha256).toBe(sha(jsonl(hard)));
    expect(manifest.files["demo-set.jsonl"]!.sha256).toBe(sha(jsonl(demo)));
    expect(readFileSync(join(repoRoot, "eval/datasets/demo-set.jsonl"), "utf8")).toBe(jsonl(demo));
  });

  it("has the documented sizes and a 20% test split", () => {
    expect(v1.length).toBe(600);
    expect(hard.length).toBe(120);
    expect(demo.length).toBe(5);
    expect(v1.filter((i) => i.split === "test").length).toBe(120);
    expect(new Set(v1.map((i) => i.id)).size).toBe(600);
  });

  it("covers 10 doc types × 3 languages × 3 lengths", () => {
    const combos = new Set(v1.map((i) => `${i.doc_type}|${i.language}|${i.length}`));
    expect(combos.size).toBe(DOC_TYPES.length * LANGUAGES.length * 3);
  });

  it("every item validates: gold/quasi are exact substrings, profile values appear, text is in normal form", () => {
    for (const it of [...v1, ...hard, ...demo]) {
      expect(validateItem(it)).toEqual([]);
      expect(isNormalised(it.text)).toBe(true);
      expect(it.synthetic).toBe(true);
    }
  });

  it("labels every private value it inserts (writer, town, employer are always gold)", () => {
    for (const it of v1) {
      const golds = new Set(it.gold.map((g) => g.text));
      expect(golds.has(it.profile.name)).toBe(true);
      expect(golds.has(it.profile.city)).toBe(true);
      expect(golds.has(it.profile.employer)).toBe(true);
    }
    const types = new Set(v1.flatMap((i) => i.gold.map((g) => g.type)));
    expect([...types].sort()).toEqual(["CONTACT", "DATE", "HEALTH", "ID", "LOCATION", "ORG", "PERSON", "SECRET"]);
  });

  it("quasi counts: synth-v1 1–2, synth-hard 3–5 with a rare occupation", () => {
    for (const it of v1) expect(it.quasi.length).toBeGreaterThanOrEqual(1), expect(it.quasi.length).toBeLessThanOrEqual(2);
    for (const it of hard) {
      expect(it.quasi.length).toBeGreaterThanOrEqual(3);
      expect(it.quasi.length).toBeLessThanOrEqual(5);
      expect(it.quasi.some((q) => q.reveals === "occupation")).toBe(true);
    }
  });

  it("never produces secret-shaped literals the repo scanner rejects, and uses reserved email domains", () => {
    const scanner = /AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY/;
    for (const it of [...v1, ...hard, ...demo]) {
      expect(scanner.test(it.text)).toBe(false);
      for (const g of it.gold.filter((x) => x.text.includes("@"))) expect(g.text).toMatch(/@example\.(com|org|net)$/);
    }
  });

  it("builds IBANs with valid ISO 13616 check digits", () => {
    // Published example: GB82 WEST 1234 5698 7654 32.
    expect(iban("GB", "WEST12345698765432")).toBe("GB82 WEST 1234 5698 7654 32");
  });
});
