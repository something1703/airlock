// AirlockBench runner: for each item × config, raw text → SealPipeline → EgressGate → answer → restore,
// plus the attacker and the judge. Writes one JSON record per case to eval/runs/{runId}/items.jsonl
// (gitignored; synthetic text only). Metrics are computed by the Python scorer (eval/scorer), not here.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppConfig, DEFAULTS, remoteString } from "../src/core/appConfig";
import { answer, isQuick, taskSpec, type AnswerOutcome, type TaskKind } from "../src/engine/answer";
import { EngineError } from "../src/engine/engines";
import { EgressGate, GateBlocked } from "../src/engine/gate";
import { ReceiptLedger } from "../src/engine/ledger";
import { PatternDetector } from "../src/engine/patterns";
import { sealSettings, SealPipeline, type SealResult } from "../src/engine/pipeline";
import { PromptLibrary } from "../src/engine/prompts";
import { sha256Hex } from "../src/engine/sha256";
import { renderedLegend, type SealedText } from "../src/engine/types";
import type { VaultEntry } from "../src/engine/vault";
import { CONFIGS, type BenchConfig, type ConfigId } from "./configs";
import { wordCount, type BenchItem, type BenchTaskKind } from "./dataset";
import type { AttackerGuess, BenchModels, EngineLabels, JudgeVerdict } from "./models";
import { unit } from "./rng";

/** Same instant as the generator's reference date, so date handling never depends on the clock. */
export const BENCH_TODAY = new Date("2026-11-18T00:00:00Z");
export const MOCK_LABEL = "MOCK RUN — not real model results";
export const RUN_SCHEMA_VERSION = 1;

export interface SealedSpan {
  start: number;
  end: number;
  kind: string;
  category: string | null;
  text: string;
}

/** One item × config. Field names are snake_case for the Python scorer and BigQuery. */
export interface CaseRecord {
  schema_version: number;
  run_id: string;
  mode: "mock" | "live";
  item_id: string;
  dataset: string;
  split: string;
  config: ConfigId;
  doc_type: string;
  language: string;
  length: string;
  words: number;
  task_kind: BenchTaskKind;
  quick_task: boolean;
  text: string;
  gold: BenchItem["gold"];
  quasi: BenchItem["quasi"];
  profile: BenchItem["profile"];
  /** Exactly what would leave the device (value + legend), or null if nothing did (gate blocked). */
  egress: string | null;
  legend_count: number;
  gate: { passed: boolean; failed_checks: string[]; counts: Record<string, number> };
  requires_review: boolean;
  review_reasons: string[];
  llm: { unavailable: string | null; chunks: number; failed: number; refused: number; hallucinated_dropped: number } | null;
  sealed_spans: SealedSpan[];
  redteam: { risks: number; applied: number; unlocated: number } | null;
  seal_ms: number;
  route: string | null;
  model_version: string | null;
  on_device_answer: boolean | null;
  answer_latency_ms: number | null;
  answer_status: "ok" | "blocked" | "error" | "baseline";
  answer_error: string | null;
  answer_model_text: string | null;
  answer_restored: string | null;
  restore: { unknown_ids: string[]; guessed_entities: string[]; ok: boolean } | null;
  baseline_answer: string | null;
  attacker: AttackerGuess | null;
  judge: JudgeVerdict | null;
  /** Attacker/judge calls that failed (the case is kept; those metrics skip it). */
  eval_errors: string[];
  engines: EngineLabels;
}

export interface RunManifest {
  schema_version: number;
  run_id: string;
  mode: "mock" | "live";
  label: string | null;
  created_at: string;
  finished_at: string | null;
  git_sha: string;
  git_dirty: boolean;
  dataset: string;
  split: string;
  n_items: number;
  configs: ConfigId[];
  skipped_configs: { config: ConfigId; reason: string }[];
  engine: string;
  engines: EngineLabels;
  prompt_ids: Record<string, string>;
  remote_config: Record<string, string>;
  models: Record<string, string>;
  platform: Record<string, string>;
  records: number;
}

const PROMPTS_USED = [
  "detect.v1", "detect-repair.v1", "gen.v1", "attack.v1", "cloud-system.v1", "cloud-user.v1", "phone-system.v1",
  "task.help.v1", "task.explain.v1", "task.questions.v1", "task.summary.v1", "task.reply.v1", "task.actions.v1", "judge.v1", "attacker.v1", "synth.v1",
];

export function taskKindOf(k: BenchTaskKind): TaskKind {
  return k === "reply" ? { kind: "reply", tone: "firm but polite" } : { kind: k };
}

export function vaultFor(item: BenchItem): VaultEntry[] {
  const p = item.profile;
  const parts = p.name.split(/\s+/u).filter((t) => t.length >= 2);
  return [
    { id: "bench-vault-me", canonical: p.name, aliases: parts, category: "person", isUser: true },
    { id: "bench-vault-city", canonical: p.city, aliases: [], category: "location", isUser: false },
    { id: "bench-vault-employer", canonical: p.employer, aliases: [], category: "org", isUser: false },
  ];
}

export const outboundText = (s: SealedText): string => (s.legend.length === 0 ? s.value : `${s.value}\n\n${renderedLegend(s)}`);

/** `[[PERSON_1]]` → `[REDACTED]` (config G: no placeholders, no legend). */
export const redact = (text: string): string => text.replace(/\[\[[A-Z]+_(?:[0-9]+|ME)\]\]/g, "[REDACTED]");

function sealedSpans(item: BenchItem, r: SealResult): { spans: SealedSpan[]; unlocated: number } {
  const n = r.normalised.text;
  const spans: SealedSpan[] = [];
  for (const rep of r.draft.replacements) {
    if (rep.kind === "redteam") continue;
    const e = rep.entityId ? r.draft.entities.get(rep.entityId) : undefined;
    spans.push({ start: rep.normalisedSpan.start, end: rep.normalisedSpan.end, kind: rep.kind, category: e?.category ?? null, text: n.slice(rep.normalisedSpan.start, rep.normalisedSpan.end) });
  }
  let unlocated = 0;
  for (const risk of r.acceptedRisks) {
    const at = item.text.indexOf(risk.evidence);
    if (at < 0) unlocated++;
    else spans.push({ start: at, end: at + risk.evidence.length, kind: "redteam", category: "quasi", text: risk.evidence });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  return { spans, unlocated };
}

async function finish(gen: AsyncGenerator<import("../src/engine/answer").AnswerEvent>): Promise<AnswerOutcome> {
  let outcome: AnswerOutcome | null = null;
  for await (const ev of gen) if (ev.kind === "finished") outcome = ev.outcome;
  if (!outcome) throw new EngineError("other", "no answer");
  return outcome;
}

export interface CaseContext {
  runId: string;
  models: BenchModels;
  patterns: PatternDetector;
  prompts: PromptLibrary;
  appConfig: AppConfig;
  baseline: string;
}

function base(item: BenchItem, config: BenchConfig, ctx: CaseContext): CaseRecord {
  return {
    schema_version: RUN_SCHEMA_VERSION, run_id: ctx.runId, mode: ctx.models.labels.mode, item_id: item.id, dataset: item.dataset, split: item.split, config: config.id,
    doc_type: item.doc_type, language: item.language, length: item.length, words: wordCount(item.text), task_kind: item.task_kind, quick_task: isQuick(taskKindOf(item.task_kind)),
    text: item.text, gold: item.gold, quasi: item.quasi, profile: item.profile,
    egress: null, legend_count: 0, gate: { passed: false, failed_checks: [], counts: {} }, requires_review: false, review_reasons: [], llm: null, sealed_spans: [], redteam: null,
    seal_ms: 0, route: null, model_version: null, on_device_answer: null, answer_latency_ms: null, answer_status: "ok", answer_error: null,
    answer_model_text: null, answer_restored: null, restore: null, baseline_answer: null, attacker: null, judge: null, eval_errors: [], engines: ctx.models.labels,
  };
}

/** A_raw: the baseline answer on the raw synthetic text (leak is 100% by definition). */
export async function baselineAnswer(item: BenchItem, ctx: CaseContext): Promise<string> {
  const spec = taskSpec(ctx.prompts, taskKindOf(item.task_kind));
  return (await ctx.models.rawAnswer(item, spec)).text;
}

export async function runCase(item: BenchItem, config: BenchConfig, ctx: CaseContext): Promise<CaseRecord> {
  const rec = base(item, config, ctx);
  if (config.raw) {
    rec.egress = item.text;
    rec.gate = { passed: true, failed_checks: [], counts: {} };
    rec.answer_status = "baseline";
    rec.baseline_answer = ctx.baseline;
    rec.answer_restored = ctx.baseline;
    try {
      rec.attacker = await ctx.models.attack(item, item.text);
    } catch {
      rec.eval_errors.push("attacker");
    }
    return rec;
  }

  const vault = config.vault ? vaultFor(item) : [];
  const settings = sealSettings(ctx.appConfig, { dial: config.dial, redTeamEnabled: config.redTeam, today: BENCH_TODAY, taskSummary: item.task });
  const pipeline = new SealPipeline(ctx.models.phone(item, config), ctx.patterns, vault, ctx.prompts, settings);
  const result = await pipeline.run(item.text);
  const { spans, unlocated } = sealedSpans(item, result);
  rec.seal_ms = Math.round(result.sealMs * 1000) / 1000;
  rec.sealed_spans = spans;
  rec.requires_review = result.requiresReview;
  rec.review_reasons = result.reasons.map((x) => x.kind);
  const d = result.detection;
  rec.llm = { unavailable: d.unavailable, chunks: d.chunkCount, failed: d.failedChunks.length, refused: d.refusedChunks.length, hallucinated_dropped: d.hallucinatedDropped };
  rec.redteam = config.redTeam ? { risks: result.risks.length, applied: result.acceptedRisks.length, unlocated } : null;

  const gate = new EgressGate(ctx.patterns, vault);
  let sealed: SealedText;
  try {
    sealed = gate.seal(result.draft);
    if (config.redact) sealed = gate.sealToolResult(redact(sealed.value), result.draft.entities);
  } catch (e) {
    if (!(e instanceof GateBlocked)) throw e;
    rec.gate = { passed: false, failed_checks: [...e.checks].sort(), counts: {} };
    rec.answer_status = "blocked";
    return rec;
  }
  rec.gate = { passed: true, failed_checks: [], counts: { ...sealed.gateReport.counts } };
  rec.egress = outboundText(sealed);
  rec.legend_count = sealed.legend.length;

  try {
    const restoreCtx = { entities: result.draft.entities, userFirstName: item.profile.name.split(" ")[0] ?? null };
    const outcome = await finish(answer({
      engines: ctx.models.engines(item), prompts: ctx.prompts, ledger: new ReceiptLedger(), sealed, task: taskKindOf(item.task_kind),
      restore: restoreCtx, threadId: `bench-${item.id}`, sealMs: result.sealMs,
    }));
    rec.route = outcome.route;
    rec.model_version = outcome.modelVersion;
    rec.on_device_answer = outcome.ranOnDevice;
    rec.answer_latency_ms = Math.round(outcome.latencyMs * 1000) / 1000;
    rec.answer_model_text = outcome.modelText;
    rec.answer_restored = outcome.restored.text;
    rec.restore = { unknown_ids: outcome.fidelity.unknownIds, guessed_entities: outcome.fidelity.guessedEntities, ok: outcome.fidelity.unknownIds.length === 0 };
  } catch (e) {
    rec.answer_status = "error";
    rec.answer_error = e instanceof EngineError ? e.code : "other";
  }

  try {
    rec.attacker = await ctx.models.attack(item, rec.egress);
  } catch {
    rec.eval_errors.push("attacker");
  }
  if (rec.answer_status === "ok" && rec.answer_restored !== null) {
    const swapped = unit(`judge:${item.id}:${config.id}`) < 0.5;
    try {
      rec.judge = await ctx.models.judge(item, { task: item.task, raw: item.text, answerRaw: ctx.baseline, answerAirlock: rec.answer_restored, swapped });
    } catch {
      rec.eval_errors.push("judge");
    }
  }
  return rec;
}

export const repoRoot = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function makeManifest(runId: string, dataset: string, split: string, items: BenchItem[], configs: ConfigId[], models: BenchModels, prompts: PromptLibrary, appConfig: AppConfig): RunManifest {
  const promptIds: Record<string, string> = {};
  for (const id of PROMPTS_USED) promptIds[id] = sha256Hex(prompts.template(id)).slice(0, 12);
  const remote: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEFAULTS)) remote[k] = remoteString(v);
  return {
    schema_version: RUN_SCHEMA_VERSION, run_id: runId, mode: models.labels.mode, label: models.labels.mode === "mock" ? MOCK_LABEL : null,
    created_at: new Date().toISOString(), finished_at: null, git_sha: git(["rev-parse", "HEAD"]) || "unknown", git_dirty: git(["status", "--porcelain"]) !== "",
    dataset, split, n_items: items.length,
    configs: configs.filter((c) => CONFIGS[c].unsupported === null),
    skipped_configs: configs.filter((c) => CONFIGS[c].unsupported !== null).map((c) => ({ config: c, reason: CONFIGS[c].unsupported ?? "" })),
    engine: "TypeScript privacy engine (web/src/engine), byte-compatible with Swift/Kotlin via spec/fixtures",
    engines: models.labels, prompt_ids: promptIds, remote_config: remote,
    models: { deep: appConfig.modelCloudDeep, quick: appConfig.modelCloudQuick, max: appConfig.modelCloudMax, fallback: appConfig.modelCloudFallback },
    platform: { node: process.version, os: `${platform()} ${release()}`, arch: arch(), cpu: cpus()[0]?.model ?? "unknown" },
    records: 0,
  };
}

export interface RunOptions {
  runId: string;
  outDir: string;
  dataset: string;
  split: string;
  items: BenchItem[];
  configs: ConfigId[];
  models: BenchModels;
  resume?: boolean;
  appConfig?: AppConfig;
  onProgress?: (done: number, total: number) => void;
}

export interface RunSummary {
  runDir: string;
  records: number;
  skippedExisting: number;
  manifest: RunManifest;
}

/** Runs every (item, config), appending records as they finish so `--resume` can continue an interrupted run. */
export async function runBench(o: RunOptions): Promise<RunSummary> {
  const runDir = join(o.outDir, o.runId);
  const itemsPath = join(runDir, "items.jsonl");
  const manifestPath = join(runDir, "manifest.json");
  if (!o.resume && existsSync(itemsPath)) throw new Error(`Run ${o.runId} already exists — pass --resume to continue it or pick another --run-id`);
  mkdirSync(runDir, { recursive: true });

  const appConfig = o.appConfig ?? new AppConfig();
  const prompts = new PromptLibrary(appConfig.promptOverridesJson);
  const patterns = new PatternDetector(undefined, appConfig.disabledPatternPacks);
  const manifest = o.resume && existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest) : makeManifest(o.runId, o.dataset, o.split, o.items, o.configs, o.models, prompts, appConfig);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const done = new Set<string>();
  const baselines = new Map<string, string>();
  if (o.resume && existsSync(itemsPath)) {
    for (const line of readFileSync(itemsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as CaseRecord;
      done.add(`${r.item_id}|${r.config}`);
      if (r.baseline_answer !== null) baselines.set(r.item_id, r.baseline_answer);
    }
  }

  const runnable = o.configs.filter((c) => CONFIGS[c].unsupported === null);
  const total = o.items.length * runnable.length;
  let written = 0;
  let skipped = 0;
  for (const item of o.items) {
    const pending = runnable.filter((c) => !done.has(`${item.id}|${c}`));
    skipped += runnable.length - pending.length;
    if (pending.length === 0) continue;
    const ctx: CaseContext = { runId: o.runId, models: o.models, patterns, prompts, appConfig, baseline: "" };
    ctx.baseline = baselines.get(item.id) ?? (await baselineAnswer(item, ctx));
    for (const c of pending) {
      const rec = await runCase(item, CONFIGS[c], ctx);
      appendFileSync(itemsPath, JSON.stringify(rec) + "\n");
      written++;
      o.onProgress?.(written + skipped, total);
    }
  }
  manifest.finished_at = new Date().toISOString();
  manifest.records = written + skipped;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { runDir, records: written, skippedExisting: skipped, manifest };
}
