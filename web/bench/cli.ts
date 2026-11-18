// AirlockBench CLI (`npm run bench -- <command>` from web/). Mock by default; live needs the owner's permission.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ALL_CONFIG_IDS, parseConfigs, SMOKE_CONFIG, type ConfigId } from "./configs";
import { loadDataset, writeJsonl, type BenchItem } from "./dataset";
import { connectLive, generateWithSynth, liveModels, type FirebaseImporter } from "./live";
import { assertLiveAllowed, LIVE_ENV, LiveRefused } from "./liveGate";
import { mockModels, type BenchModels } from "./models";
import { MOCK_LABEL, repoRoot, runBench } from "./runner";
import { DATASET_SIZES, DEFAULT_SEED, generateDataset, generateDemoSet, GENERATOR_ID, validateItem, type DatasetName } from "./synth/synth";

export interface IO {
  out(s: string): void;
  err(s: string): void;
}
const stdio: IO = { out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n") };

export const USAGE = `AirlockBench — docs/07-EVALUATION.md

  npm run bench -- generate [--dataset all|synth-v1|synth-hard|demo-set] [--seed N]
  npm run bench -- run [--dataset synth-v1|synth-hard|demo-set|<file.jsonl>] [--split test|dev|all]
                       [--configs A_raw,B_rules,...] [--smoke | --full] [--limit N]
                       [--run-id ID] [--resume ID] [--oracle-recall 0.9]
  npm run bench -- live-check

Every run is MOCK unless --live --i-have-permission is given AND ${LIVE_ENV}=yes is set.
Live runs call Gemini through Firebase AI Logic on the evaluation project and need the repo owner's permission.`;

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  const flags = new Map<string, string | true>();
  let cmd = "";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
      const next = rest[i + 1];
      if (v !== undefined) flags.set(k, v);
      else if (next !== undefined && !next.startsWith("--") && VALUE_FLAGS.has(k)) {
        flags.set(k, next);
        i++;
      } else flags.set(k, true);
    } else if (!cmd) cmd = a;
  }
  return { cmd, flags };
}

const VALUE_FLAGS = new Set(["dataset", "seed", "split", "configs", "limit", "run-id", "resume", "oracle-recall", "out", "n", "source"]);
const flag = (a: Args, k: string): string | undefined => {
  const v = a.flags.get(k);
  return typeof v === "string" ? v : undefined;
};
const liveFlags = (a: Args) => ({ live: a.flags.has("live"), iHavePermission: a.flags.has("i-have-permission") });

export const datasetsDir = (): string => join(repoRoot(), "eval", "datasets");
export const runsDir = (): string => join(repoRoot(), "eval", "runs");
const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Template datasets by name — read from eval/datasets if generated, else rebuilt in memory (deterministic). */
export function datasetItems(name: string, dir = datasetsDir(), seed = DEFAULT_SEED): BenchItem[] {
  const file = isAbsolute(name) || name.endsWith(".jsonl") ? resolve(name) : join(dir, `${name}.jsonl`);
  if (existsSync(file)) return loadDataset(file);
  if (name === "synth-v1" || name === "synth-hard") return generateDataset(name, seed);
  if (name === "demo-set") return generateDemoSet(seed);
  throw new Error(`No dataset ${name} (expected synth-v1, synth-hard, demo-set or a .jsonl path)`);
}

export interface Deps {
  env: Readonly<Record<string, string | undefined>>;
  io?: IO;
  importer?: FirebaseImporter;
  /** Overrides for tests. */
  datasetsDir?: string;
  runsDir?: string;
}

async function cmdGenerate(a: Args, d: Deps, io: IO): Promise<number> {
  const seed = Number(flag(a, "seed") ?? DEFAULT_SEED);
  const which = flag(a, "dataset") ?? "all";
  const outDir = d.datasetsDir ?? datasetsDir();
  const names: DatasetName[] = which === "all" ? ["synth-v1", "synth-hard", "demo-set"] : [which as DatasetName];
  if (flag(a, "source") === "synth.v1") {
    // Model-generated documents: cloud calls, so the live gate applies.
    const deps = await connectLive(liveFlags(a), d.env, d.importer);
    for (const name of names.filter((n): n is "synth-v1" | "synth-hard" => n !== "demo-set")) {
      const n = Number(flag(a, "n") ?? DATASET_SIZES[name]);
      const { items, dropped } = await generateWithSynth(deps, name, n, seed);
      writeJsonl(join(outDir, `${name}.llm.jsonl`), items);
      io.out(`${name}.llm: ${items.length} valid, ${dropped} dropped (${((100 * dropped) / Math.max(1, n)).toFixed(1)}% drop rate)`);
    }
    return 0;
  }
  const manifest: Record<string, unknown> = { generator: GENERATOR_ID, seed, files: {} as Record<string, unknown> };
  for (const name of names) {
    if (!["synth-v1", "synth-hard", "demo-set"].includes(name)) throw new Error(`Unknown dataset ${name}`);
    const items = name === "demo-set" ? generateDemoSet(seed) : generateDataset(name, seed);
    const valid = items.filter((it) => validateItem(it).length === 0);
    const path = join(outDir, `${name}.jsonl`);
    writeJsonl(path, valid);
    (manifest.files as Record<string, unknown>)[`${name}.jsonl`] = {
      items: valid.length, dropped: items.length - valid.length, test: valid.filter((i) => i.split === "test").length, dev: valid.filter((i) => i.split === "dev").length, sha256: sha256File(path),
    };
    io.out(`${name}: ${valid.length} items (${items.length - valid.length} dropped) → ${path}`);
  }
  if (which === "all") writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return 0;
}

const today = (): string => new Date().toISOString().slice(0, 10);

async function cmdRun(a: Args, d: Deps, io: IO): Promise<number> {
  const live = a.flags.has("live") || a.flags.has("i-have-permission");
  let models: BenchModels;
  if (live) models = liveModels(await connectLive(liveFlags(a), d.env, d.importer));
  else models = mockModels(Number(flag(a, "oracle-recall") ?? 0.9));

  const smoke = a.flags.has("smoke");
  const full = a.flags.has("full");
  const datasetName = flag(a, "dataset") ?? "synth-v1";
  const split = flag(a, "split") ?? (full ? "all" : "test");
  let items = datasetItems(datasetName, d.datasetsDir);
  if (split !== "all") items = items.filter((i) => i.split === split);
  const limit = flag(a, "limit") ? Number(flag(a, "limit")) : smoke ? 30 : undefined;
  if (limit !== undefined) items = items.slice(0, limit);
  const configs: ConfigId[] = flag(a, "configs") ? parseConfigs(flag(a, "configs")) : smoke ? [SMOKE_CONFIG] : ALL_CONFIG_IDS;

  const resume = flag(a, "resume");
  const runId = resume ?? flag(a, "run-id") ?? `${today()}-${models.labels.mode}-${Date.now().toString(36)}`;
  if (models.labels.mode === "mock") io.out(`⚠ ${MOCK_LABEL} (mock on-device model, scripted answers/judge/attacker; no network)`);
  io.out(`Run ${runId}: ${items.length} items × ${configs.length} configs (${datasetName}, split ${split})`);
  const summary = await runBench({ runId, outDir: d.runsDir ?? runsDir(), dataset: datasetName, split, items, configs, models, resume: !!resume });
  for (const s of summary.manifest.skipped_configs) io.out(`• skipped ${s.config}: ${s.reason}`);
  io.out(`✔ ${summary.records} new records (${summary.skippedExisting} already done) → ${join(summary.runDir, "items.jsonl")}`);
  io.out(`Next: python3 -I eval/scorer/score.py report --run-dir ${summary.runDir}`);
  return 0;
}

function cmdLiveCheck(a: Args, d: Deps, io: IO): number {
  try {
    assertLiveAllowed(liveFlags(a), d.env);
    io.out("Live runs are allowed in this shell (flags + environment present). Nothing was called.");
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return 3;
  }
}

/** Returns a process exit code. 3 = refused by the live gate. */
export async function main(argv: string[], d: Deps = { env: process.env }): Promise<number> {
  const io = d.io ?? stdio;
  const a = parseArgs(argv);
  try {
    switch (a.cmd) {
      case "generate": return await cmdGenerate(a, d, io);
      case "run": return await cmdRun(a, d, io);
      case "live-check": return cmdLiveCheck(a, d, io);
      default:
        io.out(USAGE);
        return a.cmd === "" || a.cmd === "help" ? 0 : 2;
    }
  } catch (e) {
    if (e instanceof LiveRefused) {
      io.err(e.message);
      return 3;
    }
    io.err(`✘ ${(e as Error).message}`);
    return 1;
  }
}
