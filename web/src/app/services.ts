import { AppConfig } from "../core/appConfig";
import { CHROME_ON_DEVICE_MODEL, EngineError, type EngineProvider, type PhoneAvailability, type PhoneOnlyEngine, type SealedEngine, type ToolCall, type ToolEngine } from "../engine/engines";
import { MockEngines, MockPhoneEngine, MockSealedEngine, MockToolEngine } from "../engine/mocks";
import { MEETING_TONE } from "../engine/answer";
import { nextWorkWeek } from "../engine/tools";
import { PatternDetector } from "../engine/patterns";
import { PromptLibrary } from "../engine/prompts";
import type { Route } from "../engine/types";
import { bootFirebase, signInQuietly, type FirebaseStatus } from "../ai/firebase";
import { FirebaseEngines } from "../ai/firebaseEngines";
import { chromeAvailability } from "../ai/chromeModel";
import { loadRemoteConfig } from "../ai/remoteConfig";
import { FirestoreSync, type SealedSync } from "../ai/sync";
import { AirlockStores, EncryptedStore } from "../store/encryptedStore";

export interface Services {
  config: AppConfig;
  prompts: PromptLibrary;
  patterns: PatternDetector;
  engines: EngineProvider;
  /** Must be called from a click/keypress (Chrome download rule). Absent in demo/no-Firebase mode. */
  initializeOnDevice?: (onProgress: (fraction: number) => void) => Promise<void>;
  availability: () => Promise<PhoneAvailability>;
  stores: AirlockStores;
  firebase: FirebaseStatus;
  mode: "live" | "demo" | "noCloud";
  /** Sealed-history backup (live mode only). */
  sync?: SealedSync;
}

/** No Firebase config: the on-device model can't be reached (all AI goes through Firebase AI Logic), and nothing can go to the cloud. */
class NoCloudEngines implements EngineProvider {
  readonly phone: PhoneOnlyEngine = MockPhoneEngine.answering("", "unavailable");
  sealed(route: Route): SealedEngine {
    return {
      route,
      respond: () => Promise.reject(new EngineError("other", "no-firebase")),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new EngineError("other", "no-firebase");
      },
    };
  }
  tools(): ToolEngine {
    const fail = (): Promise<never> => Promise.reject(new EngineError("other", "no-firebase"));
    return { route: "cloudOnly", chat: () => ({ send: fail, respond: fail }) };
  }
}

/** `?demo=1`: scripted engines for screenshots and judges without Firebase (clearly labelled in the UI). */
function demoEngines(): EngineProvider {
  const phone = new MockPhoneEngine((id, text) => {
    if (id === "detect.v1") {
      const items: { text: string; type: string; role?: string }[] = [];
      for (const [re, type, role] of [[/\bMercy General Hospital\b/, "ORG", "the writer's employer"], [/\bRaj Patel\b|\bRaj\b/, "PERSON", "the writer's landlord"]] as const) {
        const m = text.match(re);
        if (m) items.push({ text: m[0], type, role });
      }
      return JSON.stringify({ items });
    }
    if (id === "gen.v1") return JSON.stringify({ rewrite: "a large hospital" });
    if (id === "attack.v1") return JSON.stringify({ guesses: [] });
    return "{}";
  });
  const reply = (route: Route) =>
    new MockSealedEngine(route, (_s, task) => (task.id === "task.summary.v1" ? "- [[PERSON_1]] hasn't fixed the heater.\n- You've asked several times." : "Here's a firm, polite reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], the heater at [[LOC_1]] is still broken. Please arrange a repair this week.\n\nThanks,\n[[PERSON_ME]]"), route === "phoneFirst" ? CHROME_ON_DEVICE_MODEL : "gemini-demo");
  return new MockEngines(phone, { phoneFirst: reply("phoneFirst"), cloudFirst: reply("cloudFirst"), cloudOnly: reply("cloudOnly"), phoneOnly: reply("phoneOnly") }, demoToolEngine());
}

const DEMO_REPLY = "Here's a firm, polite reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], the heater at [[LOC_1]] is still broken. Please arrange a repair this week.\n\nThanks,\n[[PERSON_ME]]";

/**
 * Demo function calling: "Propose a meeting time" asks for today's date and next week's free time in one
 * (parallel) turn — so the consent cards show — then drafts with whatever the user allowed.
 */
function demoToolEngine(): MockToolEngine {
  return new MockToolEngine(async (round, { task, results, declarations }) => {
    const meeting = task.instruction.includes(MEETING_TONE);
    if (!meeting) return { text: DEMO_REPLY };
    if (round === 0) {
      const week = nextWorkWeek(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      const calls: ToolCall[] = [{ id: "demo-1", name: "today_context", args: {} }];
      if (declarations.some((d) => d.name === "find_free_slots")) calls.push({ id: "demo-2", name: "find_free_slots", args: { start_date: week.start, end_date: week.end, min_minutes: 60, max_results: 3 } });
      return { calls };
    }
    await new Promise((r) => setTimeout(r, 400));
    let slots: string[] = [];
    for (const r of results) {
      try {
        const v = JSON.parse(r.sealed.value) as { slots?: unknown };
        if (Array.isArray(v.slots)) slots = v.slots.filter((s): s is string => typeof s === "string");
      } catch {
        // Not JSON: ignore.
      }
    }
    const body = slots.length >= 2
      ? `Could we meet next week to sort out the heater at [[LOC_1]]? I'm free ${slots[0]} or ${slots[1]} — whichever suits you.`
      : "Could we find a time next week to sort out the heater at [[LOC_1]]? I'm flexible — let me know a day and time that suits you, and I'll make it work.";
    return { text: `Here's a reply proposing a meeting:\n\nHi [[PERSON_1]],\n\n${body}\n\nThanks,\n[[PERSON_ME]]` };
  }, "gemini-demo");
}

export async function createServices(search = typeof location !== "undefined" ? location.search : ""): Promise<Services> {
  const config = new AppConfig();
  const prompts = new PromptLibrary(config.promptOverridesJson);
  const patterns = new PatternDetector(undefined, config.disabledPatternPacks);
  const demo = new URLSearchParams(search).has("demo");
  // Demo mode gets its own encrypted database so scripted receipts never mix with real ones.
  const stores = new AirlockStores(await EncryptedStore.open(demo ? "airlock-demo" : "airlock"));
  if (demo) {
    return { config, prompts, patterns, engines: demoEngines(), availability: async () => "available", stores, firebase: { kind: "missingConfig" }, mode: "demo" };
  }
  const firebase = bootFirebase();
  if (firebase.kind === "missingConfig") {
    return { config, prompts, patterns, engines: new NoCloudEngines(), availability: async () => "unavailable", stores, firebase, mode: "noCloud" };
  }
  void signInQuietly(firebase.app);
  // Live mode: Remote Config (model names, thresholds, prompt overrides) replaces the bundled defaults.
  const liveConfig = new AppConfig(await loadRemoteConfig(firebase.app));
  const livePrompts = new PromptLibrary(liveConfig.promptOverridesJson);
  const livePatterns = new PatternDetector(undefined, liveConfig.disabledPatternPacks);
  const engines = new FirebaseEngines(firebase.app, liveConfig, livePrompts);
  return {
    config: liveConfig, prompts: livePrompts, patterns: livePatterns, engines, stores, firebase, mode: "live", sync: new FirestoreSync(firebase.app),
    availability: chromeAvailability,
    initializeOnDevice: (onProgress) => engines.initializeOnDevice(onProgress),
  };
}
