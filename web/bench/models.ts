// What the runner needs from "the models": the on-device engine (raw text), sealed engines (cloud), the raw
// baseline (synthetic only), the attacker and the judge. `mockModels` is deterministic and offline;
// live.ts provides the Firebase AI Logic implementation (gated — needs the owner's permission).
import { fold, ranges } from "../src/engine/foldedSearch";
import { CHROME_ON_DEVICE_MODEL, type EngineProvider, type PhoneOnlyEngine, type TaskSpec } from "../src/engine/engines";
import { MockEngines, MockPhoneEngine, MockSealedEngine } from "../src/engine/mocks";
import type { Route, SealedText } from "../src/engine/types";
import type { BenchConfig } from "./configs";
import { SYNTHETIC_PROVENANCE, type BenchItem, type GoldSpan } from "./dataset";
import { unit } from "./rng";
import { REFERENCE_DATE } from "./synth/synth";

export interface AttackerGuess {
  name: string;
  city: string;
  employer: string;
  age: number;
  occupation: string;
}

/** `judge.v1` output, already un-swapped: `winner` is from Airlock's point of view. */
export interface JudgeVerdict {
  winner: "airlock" | "raw" | "tie";
  /** `b_quality` belongs to whichever answer was shown as B. */
  quality: number | null;
  qualityOf: "airlock" | "raw";
  missing: string;
  swapped: boolean;
}

export interface TextResult {
  text: string;
  modelVersion: string;
  latencyMs: number;
}

export interface EngineLabels {
  mode: "mock" | "live";
  phone: string;
  answer: string;
  rawBaseline: string;
  attacker: string;
  judge: string;
}

export interface BenchModels {
  readonly labels: EngineLabels;
  /** The on-device engine for one item + config. The only engine that ever sees raw text in a sealed config. */
  phone(item: BenchItem, config: BenchConfig): PhoneOnlyEngine;
  /** Sealed-text engines (cloud or hybrid) for one item. They accept only SealedText. */
  engines(item: BenchItem): EngineProvider;
  /** A_raw baseline: the synthetic raw text sent unprotected. Refuses non-synthetic items. */
  rawAnswer(item: BenchItem, task: TaskSpec): Promise<TextResult>;
  attack(item: BenchItem, egressText: string): Promise<AttackerGuess>;
  judge(item: BenchItem, args: { task: string; raw: string; answerRaw: string; answerAirlock: string; swapped: boolean }): Promise<JudgeVerdict>;
}

export function assertSynthetic(item: BenchItem): void {
  if (item.synthetic !== true || !SYNTHETIC_PROVENANCE.has(item.provenance)) throw new Error(`Refusing to send item ${item.id} raw: not synthetic`);
}

/** Text between the first `<<<` and the following `>>>` of a rendered prompt (the slot the template wraps). */
export function wrapped(prompt: string): string {
  const a = prompt.indexOf("<<<");
  const b = prompt.indexOf(">>>", a + 3);
  return a < 0 || b < 0 ? "" : prompt.slice(a + 3, b).replace(/^\n/, "").replace(/\n$/, "");
}

const RISK_ATTRIBUTE: Record<string, string> = { occupation: "occupation", location: "location", event: "event", relationship: "relationship", employer: "employer", age: "age" };
const RISK_REWRITE: Record<string, string> = {
  occupation: "I have a specialist job", location: "we live in a quiet part of town", event: "I have a local hobby",
  relationship: "I have relatives in the area", employer: "I work shifts at my workplace", age: "I am an adult",
};
const ENTITY_REWRITE: Record<string, string> = {
  org: "an organisation", location: "a town", date: "a date", health: "a health condition", quasi: "a detail", person: "someone",
};

/**
 * Mock on-device model ("oracle"). detect.v1 returns the gold spans present in the chunk, except a
 * deterministic `1 - recall` share it "misses" (keyed by item + span, so every run misses the same ones);
 * attack.v1 points at quasi-identifiers still in the draft; gen.v1 returns a generic rewrite. It knows the
 * answers, so its numbers say nothing about Apple's or Chrome's model — it exists to exercise the pipeline.
 */
export function oraclePhone(item: BenchItem, recall: number): PhoneOnlyEngine {
  const keep = (key: string): boolean => unit(`${item.id}:${key}`) < recall;
  return new MockPhoneEngine((promptId, prompt) => {
    if (promptId === "detect.v1" || promptId === "detect-repair.v1") {
      const chunk = wrapped(prompt);
      const items = item.gold
        .filter((g) => ranges(g.text, chunk, true).length > 0 && keep(`detect:${g.text}`))
        .map((g) => ({ text: g.text, type: g.type, role: g.role, same_as: null, confidence: "high" }));
      return JSON.stringify({ items });
    }
    if (promptId === "attack.v1") {
      const draft = wrapped(prompt);
      const guesses = item.quasi
        .filter((q) => draft.includes(q.text) && keep(`attack:${q.text}`))
        .map((q) => ({ attribute: RISK_ATTRIBUTE[q.reveals] ?? "identity", guess: `a reader could work out the writer's ${q.reveals}`, evidence: q.text, confidence: "medium" }));
      return JSON.stringify({ guesses });
    }
    if (promptId === "gen.v1") {
      const type = /Detail type: (\S+)/.exec(prompt)?.[1] ?? "";
      // The red-team asks for "general, not unique to one person or place"; the generaliser for a level.
      const forRisk = prompt.includes("not unique to one person or place");
      return JSON.stringify({ rewrite: (forRisk ? RISK_REWRITE[type] : ENTITY_REWRITE[type]) ?? "a detail" });
    }
    return "{}";
  });
}

/** The on-device model is off (configs without D4): INV-9 path, rules + forced review. */
export const unavailablePhone = (): PhoneOnlyEngine => MockPhoneEngine.answering('{"items":[]}', "unavailable");

const PLACEHOLDER = /\[\[([A-Z]+)_(?:[0-9]+|ME)\]\]/g;
/** The other people a helpful answer would name (full names where known; not the writer), in order of appearance. */
function keyReferents(text: string, gold: readonly GoldSpan[]): string[] {
  const full = gold.filter((g) => g.type === "PERSON" && g.role !== "the writer" && !gold.some((o) => o !== g && o.type === g.type && o.text.length > g.text.length && o.text.includes(g.text)));
  return full
    .map((g) => ({ g, at: ranges(g.text, text)[0]?.start ?? -1 }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, 3)
    .map((x) => x.g.text);
}

function scriptedAnswer(task: TaskSpec, referents: string[]): string {
  const lines = referents.map((r, i) => (i === 0 ? `- Address ${r} directly and keep it short.` : `- Mention ${r} where it matters.`));
  return [`Here is a draft for this request (${task.id}).`, ...lines, "- Keep copies of everything you send."].join("\n");
}

/**
 * Mock answer engine: names the PERSON placeholders it was given (up to 3) plus any gold person still
 * visible in the egress — like a model that uses what it can see.
 */
function mockSealedAnswer(item: BenchItem, sealed: SealedText, task: TaskSpec): string {
  const tokens = [...sealed.value.matchAll(PLACEHOLDER)].filter((m) => m[1] === "PERSON").map((m) => m[0]);
  const visible = keyReferents(sealed.value, item.gold);
  const seen = new Set<string>();
  const referents = [...tokens, ...visible].filter((x) => (seen.has(x) ? false : (seen.add(x), true))).slice(0, 3);
  return scriptedAnswer(task, referents);
}

const tokensOf = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3);
const visibleIn = (value: string, text: string): boolean => value.trim() !== "" && ranges(value, text).length > 0;

/**
 * Mock attacker: a string-matching reader. It "guesses" a profile value only when that value (or, for the
 * name, one of its tokens) is literally visible in the egress, plus the age from a visible birth year and
 * the occupation from a visible occupation phrase. A lower bound on what a strong model could do.
 */
export function stringMatchAttacker(item: BenchItem, egress: string): AttackerGuess {
  const p = item.profile;
  const nameTokens = p.name.split(/\s+/u).filter((t) => t.length >= 3 && visibleIn(t, egress));
  const year = /\b(19[3-9]\d|200\d)\b/.exec(egress)?.[1];
  const occupationVisible = visibleIn(p.occupation, egress) || item.quasi.some((q) => q.reveals === "occupation" && egress.includes(q.text));
  return {
    name: visibleIn(p.name, egress) ? p.name : nameTokens.join(" "),
    city: visibleIn(p.city, egress) ? p.city : "",
    employer: visibleIn(p.employer, egress) ? p.employer : "",
    age: year ? REFERENCE_DATE.y - Number(year) : 0,
    occupation: occupationVisible ? p.occupation : "",
  };
}

/**
 * Mock judge: Airlock's answer ties when it names every person the unprotected answer named (after
 * restore), otherwise the unprotected answer wins. `b_quality` = 1 + 4 × share named.
 */
export function scriptedJudge(item: BenchItem, args: { answerRaw: string; answerAirlock: string; swapped: boolean }): JudgeVerdict {
  const wanted = keyReferents(args.answerRaw, item.gold);
  const got = wanted.filter((w) => visibleIn(w, args.answerAirlock));
  const share = wanted.length === 0 ? 1 : got.length / wanted.length;
  const airlockQuality = Math.round(1 + 4 * share);
  const missing = wanted.filter((w) => !got.includes(w)).length;
  return {
    winner: share === 1 ? "tie" : "raw",
    quality: args.swapped ? 5 : airlockQuality,
    qualityOf: args.swapped ? "raw" : "airlock",
    missing: missing ? `${missing} of ${wanted.length} people not named` : "",
    swapped: args.swapped,
  };
}

/** Quick tasks answer "on device" in the mock (the hybrid route's best case); deep tasks "in the cloud". */
export function mockModels(oracleRecall = 0.9): BenchModels {
  return {
    labels: {
      mode: "mock", phone: `mock-oracle(recall=${oracleRecall})`, answer: "mock-scripted", rawBaseline: "mock-scripted",
      attacker: "mock-string-match", judge: "mock-scripted",
    },
    phone: (item, config) => (config.llm ? oraclePhone(item, oracleRecall) : unavailablePhone()),
    engines(item) {
      const engine = (route: Route, modelVersion: string) => new MockSealedEngine(route, (sealed, task) => mockSealedAnswer(item, sealed, task), modelVersion);
      return new MockEngines(MockPhoneEngine.answering("{}"), {
        phoneOnly: engine("phoneOnly", CHROME_ON_DEVICE_MODEL), phoneFirst: engine("phoneFirst", CHROME_ON_DEVICE_MODEL),
        cloudFirst: engine("cloudFirst", "mock-cloud"), cloudOnly: engine("cloudOnly", "mock-cloud"),
      });
    },
    async rawAnswer(item, task) {
      assertSynthetic(item);
      return { text: scriptedAnswer(task, keyReferents(item.text, item.gold)), modelVersion: "mock-cloud", latencyMs: 0 };
    },
    attack: async (item, egress) => stringMatchAttacker(item, egress),
    judge: async (item, args) => scriptedJudge(item, args),
  };
}
