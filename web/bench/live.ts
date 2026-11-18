// Live AirlockBench models — Firebase AI Logic on the separate evaluation project. NEVER used without the
// owner's permission: `connectLive` calls `assertLiveAllowed` before importing any Firebase module.
// Every cloud call goes through web/src/ai/firebaseEngines.ts (the only Firebase AI Logic call site, ADR-08).
import { readFileSync } from "node:fs";
import { AppConfig } from "../src/core/appConfig";
import { normalise } from "../src/engine/normaliser";
import type { EngineProvider } from "../src/engine/engines";
import { firstJsonObject } from "../src/engine/llmDetector";
import { PromptLibrary } from "../src/engine/prompts";
import { GOLD_TYPES, LANGUAGE_NAMES, LENGTH_WORDS, type BenchItem, type GoldSpan, type Language, type Length } from "./dataset";
import { assertLiveAllowed, type LiveFlags } from "./liveGate";
import { assertSynthetic, unavailablePhone, type AttackerGuess, type BenchModels, type JudgeVerdict, type TextResult } from "./models";
import { hash32, pick, rng } from "./rng";
import { DOC_TYPES } from "./synth/templates";
import { validateItem } from "./synth/synth";

/** A cloud-only text call (ONLY_IN_CLOUD). Prompts here contain synthetic data or sealed text only. */
export interface CloudText {
  generate(promptId: string, text: string, o: { model: string; system?: string; maxOutputTokens?: number; temperature?: number }): Promise<TextResult>;
}

export interface LiveDeps {
  engines: EngineProvider;
  cloud: CloudText;
  appConfig: AppConfig;
  prompts: PromptLibrary;
}

function parseJson(out: string): Record<string, unknown> | null {
  const json = firstJsonObject(out);
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseAttacker(out: string): AttackerGuess {
  const o = parseJson(out) ?? {};
  const age = typeof o.age === "number" ? o.age : Number(str(o.age)) || 0;
  return { name: str(o.name), city: str(o.city), employer: str(o.employer), age: Number.isFinite(age) ? age : 0, occupation: str(o.occupation) };
}

/** Un-swaps a `judge.v1` verdict. Unswapped: A = raw, B = Airlock. Swapped: A = Airlock, B = raw. */
export function parseJudge(out: string, swapped: boolean): JudgeVerdict {
  const o = parseJson(out);
  if (!o) throw new Error("judge.v1 returned no JSON");
  const w = str(o.winner).trim().toUpperCase();
  if (w !== "TIE" && w !== "A" && w !== "B") throw new Error("judge.v1 winner not A|B|tie");
  const airlockLetter = swapped ? "A" : "B";
  const winner: JudgeVerdict["winner"] = w === "TIE" ? "tie" : w === airlockLetter ? "airlock" : "raw";
  const q = typeof o.b_quality === "number" ? o.b_quality : Number(str(o.b_quality));
  return { winner, quality: Number.isFinite(q) && q >= 1 && q <= 5 ? q : null, qualityOf: swapped ? "raw" : "airlock", missing: str(o.missing_in_b), swapped };
}

/** Live BenchModels from injected deps (unit-tested with fakes; nothing here imports Firebase). */
export function liveModels(d: LiveDeps): BenchModels {
  const deep = d.appConfig.modelCloudDeep;
  const strongest = d.appConfig.modelCloudMax;
  return {
    labels: { mode: "live", phone: "firebase-ai-logic:ONLY_ON_DEVICE (Chrome; unavailable under Node → rules + review)", answer: "firebase-ai-logic:hybrid", rawBaseline: `firebase-ai-logic:ONLY_IN_CLOUD:${deep}`, attacker: `attacker.v1@${strongest}`, judge: `judge.v1@${deep}` },
    phone: (_item, config) => (config.llm ? d.engines.phone : unavailablePhone()),
    engines: () => d.engines,
    async rawAnswer(item, task) {
      assertSynthetic(item);
      const turn = d.prompts.render("cloud-user.v1", { legend_lines: "(none)", task_instruction: task.instruction, sealed_text: item.text });
      return d.cloud.generate("baseline.raw", turn, { model: deep, system: d.prompts.template("cloud-system.v1"), maxOutputTokens: task.maxOutputTokens });
    },
    async attack(_item, egress) {
      const out = await d.cloud.generate("attacker.v1", d.prompts.render("attacker.v1", { egress_text: egress }), { model: strongest });
      return parseAttacker(out.text);
    },
    async judge(item, a) {
      assertSynthetic(item);
      const [answerA, answerB] = a.swapped ? [a.answerAirlock, a.answerRaw] : [a.answerRaw, a.answerAirlock];
      const text = d.prompts.render("judge.v1", { task: a.task, raw: a.raw, answer_raw: answerA, answer_airlock: answerB });
      return parseJudge((await d.cloud.generate("judge.v1", text, { model: deep, temperature: 0 })).text, a.swapped);
    },
  };
}

// MARK: synth.v1 — model-generated documents (live only)

const PERSONAS = ["a nurse in her 30s", "a retired bus driver", "a student renting a flat", "a warehouse supervisor", "a parent of two", "a self-employed electrician", "a teacher close to retirement", "a new graduate"];
const SITUATIONS: Record<string, string> = {
  "text-message thread": "a disagreement with their employer about shifts", "email to HR": "unpaid overtime", "landlord dispute": "a deposit that is not being returned",
  "insurance letter": "a rejected claim", "job offer": "an offer with a lower salary than discussed", "medical bill": "charges they do not recognise",
  "school email": "their child being upset at school", "contract clause": "a broad non-compete clause", "scam message": "a text claiming their bank account is frozen",
  "group chat": "organising a school trip",
};

export interface SynthPlanEntry {
  index: number;
  docType: string;
  language: Language;
  length: Length;
  persona: string;
  situation: string;
  quasiCount: number;
}

/** The same doc type × language × length cycle as the template generator. */
export function synthPlan(dataset: "synth-v1" | "synth-hard", n: number, seed: number): SynthPlanEntry[] {
  const langs: Language[] = ["en", "es", "de"];
  const lengths: Length[] = ["short", "medium", "long"];
  return Array.from({ length: n }, (_, i) => {
    const r = rng(hash32(`synth.v1:${dataset}:${seed}:${i}`));
    const docType = DOC_TYPES[i % DOC_TYPES.length]!.key;
    return {
      index: i, docType, language: langs[Math.floor(i / 10) % 3]!, length: lengths[Math.floor(i / 30) % 3]!, persona: pick(r, PERSONAS), situation: SITUATIONS[docType] ?? "a problem",
      quasiCount: dataset === "synth-hard" ? 3 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2),
    };
  });
}

/** Parses one `synth.v1` answer into a BenchItem (null if unusable). Text is put into the engine's normal form. */
export function parseSynth(out: string, e: SynthPlanEntry, dataset: string): BenchItem | null {
  const o = parseJson(out);
  if (!o || typeof o.text !== "string") return null;
  const text = normalise(o.text).text;
  const types = new Set<string>(GOLD_TYPES);
  const gold: GoldSpan[] = (Array.isArray(o.gold) ? o.gold : [])
    .map((g: unknown) => g as Record<string, unknown>)
    .filter((g) => g && typeof g.text === "string" && types.has(str(g.type).toUpperCase()))
    .map((g) => ({ text: normalise(str(g.text)).text, type: str(g.type).toUpperCase() as GoldSpan["type"], role: str(g.role) }));
  const quasi = (Array.isArray(o.quasi) ? o.quasi : []).map((q: unknown) => q as Record<string, unknown>).filter((q) => q && typeof q.text === "string").map((q) => ({ text: normalise(str(q.text)).text, reveals: str(q.reveals) || "event" }));
  const p = (o.profile ?? {}) as Record<string, unknown>;
  const dt = DOC_TYPES.find((d) => d.key === e.docType);
  return {
    id: `${dataset}-llm-${String(e.index + 1).padStart(4, "0")}`, dataset, split: e.index % 5 === 4 ? "test" : "dev", provenance: "airlock-bench-synth.v1", generator: "synth.v1", synthetic: true,
    doc_type: e.docType, language: e.language, length: e.length, quasi_count: quasi.length, text, gold, quasi,
    profile: { name: str(p.name), city: str(p.city), employer: str(p.employer), age: typeof p.age === "number" ? p.age : 0, occupation: str(p.occupation) },
    task: str(o.task) || (dt?.task ?? "Help me with this."), task_kind: dt?.taskKind ?? "help",
  };
}

/** Generates documents with `synth.v1` and keeps only valid ones (docs/07 §3); returns the drop count. */
export async function generateWithSynth(d: Pick<LiveDeps, "cloud" | "prompts" | "appConfig">, dataset: "synth-v1" | "synth-hard", n: number, seed: number): Promise<{ items: BenchItem[]; dropped: number }> {
  const items: BenchItem[] = [];
  let dropped = 0;
  for (const e of synthPlan(dataset, n, seed)) {
    const prompt = d.prompts.render("synth.v1", {
      doc_type: e.docType, persona: e.persona, language: LANGUAGE_NAMES[e.language], situation: e.situation, length: String(LENGTH_WORDS[e.length]), quasi_count: String(e.quasiCount),
    });
    let item: BenchItem | null = null;
    try {
      item = parseSynth((await d.cloud.generate("synth.v1", prompt, { model: d.appConfig.modelCloudDeep })).text, e, dataset);
    } catch {
      item = null;
    }
    if (item && validateItem(item).length === 0) items.push(item);
    else dropped++;
  }
  return { items, dropped };
}

// MARK: Connecting (gated)

export interface FirebaseImporter {
  app(): Promise<typeof import("firebase/app")>;
  appCheck(): Promise<typeof import("firebase/app-check")>;
  engines(): Promise<typeof import("../src/ai/firebaseEngines")>;
}

const defaultImporter: FirebaseImporter = {
  app: () => import("firebase/app"),
  appCheck: () => import("firebase/app-check"),
  engines: () => import("../src/ai/firebaseEngines"),
};

/**
 * Connects to the evaluation Firebase project. Order matters: the permission gate first, then the config
 * checks, and only then any Firebase import. Needs (all gitignored / never committed):
 * - `AIRLOCK_BENCH_FIREBASE_CONFIG`: path to the eval project's web-app config JSON;
 * - `AIRLOCK_BENCH_APPCHECK_DEBUG_TOKEN`: an App Check debug token registered on the eval project;
 * - optional `AIRLOCK_BENCH_REMOTE_CONFIG`: path to a JSON {key: value} snapshot of Remote Config.
 */
export async function connectLive(flags: LiveFlags, env: Readonly<Record<string, string | undefined>>, importer: FirebaseImporter = defaultImporter): Promise<LiveDeps> {
  assertLiveAllowed(flags, env);
  const cfgPath = env.AIRLOCK_BENCH_FIREBASE_CONFIG;
  const token = env.AIRLOCK_BENCH_APPCHECK_DEBUG_TOKEN;
  if (!cfgPath) throw new Error("Set AIRLOCK_BENCH_FIREBASE_CONFIG to the evaluation project's web app config JSON (gitignored).");
  if (!token) throw new Error("Set AIRLOCK_BENCH_APPCHECK_DEBUG_TOKEN to an App Check debug token registered on the evaluation project (never commit it).");
  const firebaseConfig = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, string>;
  const remote = env.AIRLOCK_BENCH_REMOTE_CONFIG ? (JSON.parse(readFileSync(env.AIRLOCK_BENCH_REMOTE_CONFIG, "utf8")) as Record<string, string>) : {};

  const [{ initializeApp }, { initializeAppCheck, CustomProvider }, { FirebaseEngines, MODE_FOR_ROUTE }] = await Promise.all([importer.app(), importer.appCheck(), importer.engines()]);
  // App Check debug mode under Node: the SDK reads FIREBASE_APPCHECK_DEBUG_TOKEN from the global object
  // (@firebase/app-check 0.13.1 initializeDebugMode; getGlobal() falls back to `global`). The custom
  // provider is never asked for a token in debug mode; it only satisfies initializeAppCheck without a DOM.
  (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  const app = initializeApp(firebaseConfig, "airlock-bench");
  initializeAppCheck(app, { provider: new CustomProvider({ getToken: () => Promise.reject(new Error("debug provider only")) }), isTokenAutoRefreshEnabled: false });

  const appConfig = new AppConfig(remote);
  const prompts = new PromptLibrary(appConfig.promptOverridesJson);
  const engines = new FirebaseEngines(app, appConfig, prompts);
  const cloud: CloudText = {
    async generate(_promptId, text, o) {
      const t0 = performance.now();
      const { response } = await engines.model(MODE_FOR_ROUTE.cloudOnly, o.model, o.system, o.maxOutputTokens, undefined, o.temperature).generateContent(text, { timeout: appConfig.cloudTimeoutMs });
      return { text: response.text(), modelVersion: o.model, latencyMs: performance.now() - t0 };
    },
  };
  return { engines, cloud, appConfig, prompts };
}
