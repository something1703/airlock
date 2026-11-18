// AirlockBench runner end-to-end with mock models, the live gate, and the live adapters with fakes.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, parseArgs } from "../bench/cli";
import { ALL_CONFIG_IDS, CONFIGS } from "../bench/configs";
import type { BenchItem } from "../bench/dataset";
import { liveModels, parseAttacker, parseJudge, parseSynth, type CloudText, type FirebaseImporter } from "../bench/live";
import { assertLiveAllowed, LIVE_ENV, LiveRefused } from "../bench/liveGate";
import { mockModels, oraclePhone, scriptedJudge, stringMatchAttacker } from "../bench/models";
import { MOCK_LABEL, redact, runBench, type CaseRecord, type RunManifest } from "../bench/runner";
import { generateDataset, generateDemoSet } from "../bench/synth/synth";
import { AppConfig } from "../src/core/appConfig";
import { contains } from "../src/engine/foldedSearch";
import { MockEngines } from "../src/engine/mocks";
import { PromptLibrary } from "../src/engine/prompts";

const tmp = mkdtempSync(join(tmpdir(), "airlock-bench-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const read = (dir: string): CaseRecord[] => readFileSync(join(dir, "items.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CaseRecord);
const items = [...generateDemoSet(), ...generateDataset("synth-v1").filter((i) => i.split === "test").slice(0, 12)];

describe("runner end to end (mock models)", async () => {
  const summary = await runBench({ runId: "e2e", outDir: tmp, dataset: "test", split: "test", items, configs: ALL_CONFIG_IDS, models: mockModels(1), resume: false });
  const recs = read(summary.runDir);
  const manifest = JSON.parse(readFileSync(join(summary.runDir, "manifest.json"), "utf8")) as RunManifest;

  it("writes one record per item × supported config and labels the run as mock", () => {
    const supported = ALL_CONFIG_IDS.filter((c) => CONFIGS[c].unsupported === null);
    expect(recs.length).toBe(items.length * supported.length);
    expect(manifest.mode).toBe("mock");
    expect(manifest.label).toBe(MOCK_LABEL);
    expect(manifest.skipped_configs.map((s) => s.config)).toEqual(["C_rules_nl"]);
    expect(manifest.records).toBe(recs.length);
    expect(Object.keys(manifest.prompt_ids)).toContain("detect.v1");
  });

  it("A_raw sends the raw text and carries the baseline answer; nothing else does", () => {
    for (const r of recs.filter((x) => x.config === "A_raw")) {
      expect(r.egress).toBe(r.text);
      expect(r.baseline_answer).toBeTruthy();
    }
    for (const r of recs.filter((x) => x.config !== "A_raw")) expect(r.baseline_answer).toBeNull();
  });

  it("sealed configs: a perfect on-device detector leaves no gold person, contact or ID in what was sent", () => {
    for (const r of recs.filter((x) => x.config === "D_llm" || x.config === "E_redteam")) {
      if (r.egress === null) continue;
      for (const g of r.gold.filter((x) => ["PERSON", "CONTACT", "ID", "SECRET"].includes(x.type))) expect(contains(g.text, r.egress), `${r.item_id} ${g.type}`).toBe(false);
    }
  });

  it("every sent sealed case passed all gate checks; blocked cases sent nothing and have no answer", () => {
    for (const r of recs.filter((x) => x.config !== "A_raw")) {
      if (r.egress === null) {
        expect(r.answer_status).toBe("blocked");
        expect(r.gate.failed_checks.length).toBeGreaterThan(0);
        expect(r.answer_restored).toBeNull();
      } else {
        expect(r.gate.passed).toBe(true);
        expect(r.answer_status).toBe("ok");
        expect(r.restore?.ok).toBe(true);
      }
    }
  });

  it("rules-only runs fall back to the INV-9 path (on-device model unavailable → review forced)", () => {
    for (const r of recs.filter((x) => x.config === "B_rules")) {
      expect(r.llm?.unavailable).toBe("unavailable");
      expect(r.requires_review).toBe(true);
    }
  });

  it("G_naive_redact sends [REDACTED] and no placeholders or legend", () => {
    for (const r of recs.filter((x) => x.config === "G_naive_redact" && x.egress !== null)) {
      expect(r.egress).not.toMatch(/\[\[[A-Z]+_/);
      expect(r.legend_count).toBe(0);
    }
    expect(recs.some((r) => r.config === "G_naive_redact" && r.egress?.includes("[REDACTED]"))).toBe(true);
    expect(redact("Hi [[PERSON_1]] and [[PERSON_ME]]")).toBe("Hi [REDACTED] and [REDACTED]");
  });

  it("restores real names in the answer and routes quick tasks phone-first", () => {
    const d = recs.filter((r) => r.config === "D_llm" && r.answer_status === "ok");
    expect(d.some((r) => r.answer_model_text?.includes("[[PERSON_") && !r.answer_restored?.includes("[[PERSON_"))).toBe(true);
    for (const r of d) expect(r.route).toBe(r.quick_task ? "phoneFirst" : "cloudFirst");
  });

  it("--resume continues an interrupted run without duplicating records", async () => {
    const again = await runBench({ runId: "e2e", outDir: tmp, dataset: "test", split: "test", items, configs: ALL_CONFIG_IDS, models: mockModels(1), resume: true });
    expect(again.records).toBe(0);
    expect(again.skippedExisting).toBe(recs.length);
    expect(read(summary.runDir).length).toBe(recs.length);
    await expect(runBench({ runId: "e2e", outDir: tmp, dataset: "test", split: "test", items, configs: ["D_llm"], models: mockModels(1) })).rejects.toThrow(/already exists/);
  });

  it("is deterministic apart from timings", async () => {
    const other = await runBench({ runId: "e2e-2", outDir: tmp, dataset: "test", split: "test", items, configs: ALL_CONFIG_IDS, models: mockModels(1) });
    const strip = (r: CaseRecord) => ({ ...r, run_id: "", seal_ms: 0, answer_latency_ms: 0 });
    expect(read(other.runDir).map(strip)).toEqual(recs.map(strip));
  });
});

describe("mock models", () => {
  const item = generateDemoSet()[0]!;
  it("oracle detector misses a deterministic share", async () => {
    const all = JSON.parse((await oraclePhone(item, 1).respond({ promptId: "detect.v1", text: `Text:\n<<<\n${item.text}\n>>>` }, { greedy: true })).text) as { items: unknown[] };
    const none = JSON.parse((await oraclePhone(item, 0).respond({ promptId: "detect.v1", text: `Text:\n<<<\n${item.text}\n>>>` }, { greedy: true })).text) as { items: unknown[] };
    expect(all.items.length).toBe(item.gold.length);
    expect(none.items.length).toBe(0);
  });
  it("string-match attacker only guesses what is visible", () => {
    expect(stringMatchAttacker(item, item.text).name).toBe(item.profile.name);
    expect(stringMatchAttacker(item, "nothing here")).toEqual({ name: "", city: "", employer: "", age: 0, occupation: "" });
  });
  it("scripted judge ties only when every person is named, and un-swaps quality ownership", () => {
    const raw = "- Address Leila Brennan directly.";
    const it2: BenchItem = { ...item, gold: [{ text: "Leila Brennan", type: "PERSON", role: "the writer's recruiter" }] };
    expect(scriptedJudge(it2, { answerRaw: raw, answerAirlock: "Leila Brennan", swapped: false }).winner).toBe("tie");
    expect(scriptedJudge(it2, { answerRaw: raw, answerAirlock: "[REDACTED]", swapped: false })).toMatchObject({ winner: "raw", quality: 1, qualityOf: "airlock" });
    expect(scriptedJudge(it2, { answerRaw: raw, answerAirlock: "x", swapped: true }).qualityOf).toBe("raw");
  });
});

describe("live gate (no cloud calls without the owner's permission)", () => {
  const exploding: FirebaseImporter = {
    app: () => { throw new Error("firebase/app imported"); },
    appCheck: () => { throw new Error("firebase/app-check imported"); },
    engines: () => { throw new Error("firebase engines imported"); },
  };
  const io = () => {
    const lines: string[] = [];
    return { lines, io: { out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s) } };
  };

  it("assertLiveAllowed needs both flags and the environment variable", () => {
    expect(() => assertLiveAllowed({ live: true, iHavePermission: true }, { [LIVE_ENV]: "yes" })).not.toThrow();
    expect(() => assertLiveAllowed({ live: true, iHavePermission: true }, {})).toThrow(LiveRefused);
    expect(() => assertLiveAllowed({ live: true, iHavePermission: false }, { [LIVE_ENV]: "yes" })).toThrow(/--i-have-permission/);
    expect(() => assertLiveAllowed({ live: false, iHavePermission: true }, { [LIVE_ENV]: "yes" })).toThrow(/--live/);
    expect(() => assertLiveAllowed({ live: true, iHavePermission: true }, { [LIVE_ENV]: "true" })).toThrow(LiveRefused);
  });

  it.each([
    [["run", "--live"], { [LIVE_ENV]: "yes" }],
    [["run", "--live", "--i-have-permission"], {}],
    [["run", "--i-have-permission"], { [LIVE_ENV]: "yes" }],
    [["generate", "--source", "synth.v1"], { [LIVE_ENV]: "yes" }],
    [["generate", "--source", "synth.v1", "--live", "--i-have-permission"], { [LIVE_ENV]: "no" }],
  ])("refuses %j with exit 3, before importing anything", async (argv, env) => {
    const { lines, io: o } = io();
    expect(await main(argv, { env, io: o, importer: exploding, runsDir: tmp, datasetsDir: tmp })).toBe(3);
    expect(lines.join("\n")).toMatch(/owner's explicit permission/);
    expect(lines.join("\n")).toMatch(/Nothing was sent/);
  });

  it("with permission it still needs the eval project config before importing Firebase", async () => {
    const { lines, io: o } = io();
    expect(await main(["run", "--live", "--i-have-permission"], { env: { [LIVE_ENV]: "yes" }, io: o, importer: exploding, runsDir: tmp })).toBe(1);
    expect(lines.join("\n")).toMatch(/AIRLOCK_BENCH_FIREBASE_CONFIG/);
  });

  it("live-check reports without calling anything", async () => {
    expect(await main(["live-check"], { env: {}, io: io().io })).toBe(3);
    expect(await main(["live-check", "--live", "--i-have-permission"], { env: { [LIVE_ENV]: "yes" }, io: io().io })).toBe(0);
  });

  it("parses flags", () => {
    const a = parseArgs(["--", "run", "--smoke", "--configs", "D_llm,E_redteam", "--live"]);
    expect(a.cmd).toBe("run");
    expect(a.flags.get("configs")).toBe("D_llm,E_redteam");
    expect(a.flags.get("live")).toBe(true);
  });
});

describe("live adapters with fakes (never the network)", () => {
  const item = generateDemoSet()[0]!;
  const calls: { promptId: string; model: string; text: string; temperature?: number }[] = [];
  const cloud: CloudText = {
    async generate(promptId, text, o) {
      calls.push({ promptId, model: o.model, text, temperature: o.temperature });
      const out = promptId === "judge.v1" ? '{"winner":"A","b_quality":4,"missing_in_b":""}' : promptId === "attacker.v1" ? '{"name":"X","city":"Y","employer":"Z","age":"41","occupation":"nurse"}' : "ok";
      return { text: out, modelVersion: o.model, latencyMs: 1 };
    },
  };
  const appConfig = new AppConfig();
  const models = liveModels({ engines: new MockEngines(), cloud, appConfig, prompts: new PromptLibrary() });

  it("judge.v1 runs at temperature 0 and is un-swapped", async () => {
    const v = await models.judge(item, { task: "t", raw: item.text, answerRaw: "raw answer", answerAirlock: "airlock answer", swapped: true });
    expect(v).toMatchObject({ winner: "airlock", quality: 4, qualityOf: "raw", swapped: true });
    const call = calls.find((c) => c.promptId === "judge.v1")!;
    expect(call.temperature).toBe(0);
    expect(call.model).toBe(appConfig.modelCloudDeep);
    expect(call.text.indexOf("airlock answer")).toBeLessThan(call.text.indexOf("raw answer"));
  });

  it("attacker.v1 uses the strongest model and parses loosely", async () => {
    expect(await models.attack(item, "sealed")).toEqual({ name: "X", city: "Y", employer: "Z", age: 41, occupation: "nurse" });
    expect(calls.find((c) => c.promptId === "attacker.v1")!.model).toBe(appConfig.modelCloudMax);
    expect(parseAttacker("garbage")).toEqual({ name: "", city: "", employer: "", age: 0, occupation: "" });
  });

  it("the raw baseline refuses anything not generated by the bench", async () => {
    const real = { ...item, provenance: "user-upload" } as unknown as BenchItem;
    await expect(models.rawAnswer(real, { id: "task.help.v1", instruction: "Help" })).rejects.toThrow(/not synthetic/);
    await expect(models.rawAnswer(item, { id: "task.help.v1", instruction: "Help" })).resolves.toMatchObject({ text: "ok" });
  });

  it("parseJudge maps letters to Airlock's point of view and rejects junk", () => {
    expect(parseJudge('{"winner":"B","b_quality":5}', false)).toMatchObject({ winner: "airlock", quality: 5, qualityOf: "airlock" });
    expect(parseJudge('{"winner":"B","b_quality":5}', true)).toMatchObject({ winner: "raw", qualityOf: "raw" });
    expect(parseJudge('{"winner":"tie","b_quality":9}', false)).toMatchObject({ winner: "tie", quality: null });
    expect(() => parseJudge('{"winner":"C"}', false)).toThrow();
  });

  it("parseSynth normalises and keeps the synth.v1 schema; invalid items fail validation", () => {
    const e = { index: 0, docType: "email to HR", language: "en" as const, length: "short" as const, persona: "p", situation: "s", quasiCount: 1 };
    const ok = parseSynth(JSON.stringify({ text: "Hi Ana Ruiz from Acme in Oakby.", gold: [{ text: "Ana Ruiz", type: "person", role: "the writer" }], quasi: [], profile: { name: "Ana Ruiz", city: "Oakby", employer: "Acme", age: 30, occupation: "x" }, task: "t" }), e, "synth-v1");
    expect(ok?.gold[0]?.type).toBe("PERSON");
    expect(ok?.provenance).toBe("airlock-bench-synth.v1");
    expect(parseSynth("no json", e, "synth-v1")).toBeNull();
  });
});
