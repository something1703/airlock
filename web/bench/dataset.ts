// AirlockBench dataset records (docs/07-EVALUATION.md §3). The schema mirrors `synth.v1`'s JSON output
// (docs/04-PROMPTS.md §9) plus bookkeeping, so template-generated and model-generated items are interchangeable.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type GoldType = "PERSON" | "ORG" | "LOCATION" | "CONTACT" | "ID" | "DATE" | "HEALTH" | "SECRET";
export const GOLD_TYPES: readonly GoldType[] = ["PERSON", "ORG", "LOCATION", "CONTACT", "ID", "DATE", "HEALTH", "SECRET"];

export interface GoldSpan {
  /** Exact substring of `text`. */
  text: string;
  type: GoldType;
  role: string;
}

export interface QuasiSpan {
  text: string;
  /** occupation | location | event | relationship | employer | age */
  reveals: string;
}

export interface Profile {
  name: string;
  city: string;
  employer: string;
  age: number;
  occupation: string;
  /** Metro area of `city` — the attacker's city guess also counts if it is in the same metro. */
  metro?: string;
}

export type Language = "en" | "es" | "de";
export const LANGUAGES: readonly Language[] = ["en", "es", "de"];
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", es: "Spanish", de: "German" };
export type Length = "short" | "medium" | "long";
export const LENGTHS: readonly Length[] = ["short", "medium", "long"];
export const LENGTH_WORDS: Record<Length, number> = { short: 70, medium: 130, long: 220 };

/** The `TaskKind` the runner asks for (it decides the route: quick tasks phone-first, deep ones cloud-first). */
export type BenchTaskKind = "help" | "explain" | "questions" | "summary" | "reply" | "actions";

/** Where an item came from. Only items with a synthetic provenance may ever be sent raw to a cloud model. */
export type Provenance = "airlock-bench-template" | "airlock-bench-synth.v1" | "airlock-bench-demo";
export const SYNTHETIC_PROVENANCE: ReadonlySet<string> = new Set<Provenance>(["airlock-bench-template", "airlock-bench-synth.v1", "airlock-bench-demo"]);

export interface BenchItem {
  id: string;
  dataset: string;
  split: "dev" | "test";
  provenance: Provenance;
  generator: string;
  /** Always true: fictional people, places and numbers only (docs/07 §3 rules). */
  synthetic: true;
  doc_type: string;
  language: Language;
  length: Length;
  quasi_count: number;
  text: string;
  gold: GoldSpan[];
  quasi: QuasiSpan[];
  profile: Profile;
  task: string;
  task_kind: BenchTaskKind;
}

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/**
 * Loads a dataset and refuses anything that is not marked synthetic by the bench generator. This is the guard
 * that keeps real user text out of the raw-to-cloud baseline (docs/07 §3: synthetic data only).
 */
export function loadDataset(path: string): BenchItem[] {
  const items = readJsonl<BenchItem>(path);
  for (const it of items) {
    if (it.synthetic !== true || !SYNTHETIC_PROVENANCE.has(it.provenance)) {
      throw new Error(`Refusing ${path}: item ${String(it.id)} is not a synthetic AirlockBench item`);
    }
  }
  return items;
}

export const wordCount = (s: string): number => s.split(/\s+/u).filter(Boolean).length;
