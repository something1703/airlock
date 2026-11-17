// All app state and actions, independent of React (the UI subscribes via useSyncExternalStore).
import { answer, type AnswerOutcome, type AnswerPreference, type TaskKind } from "../engine/answer";
import { EngineError, type PhoneAvailability, type SealedHistory } from "../engine/engines";
import { EgressGate, GateBlocked, type GateHit } from "../engine/gate";
import { ReceiptLedger, type LedgerStats } from "../engine/ledger";
import { pendingRisks, SealPipeline, sealSettings, type SealProgress, type SealResult } from "../engine/pipeline";
import type { UserOverride } from "../engine/policy";
import { applyRisks, type Risk } from "../engine/redTeam";
import type { RestoredSegment } from "../engine/restore";
import { type DialPreset, type EntityMap, type PlaceholderId, type SealedText, EntityMap as EntityMapClass, KEEP, PLACEHOLDER } from "../engine/types";
import type { VaultEntry } from "../engine/vault";
import type { ChainVerification } from "../engine/hashchain";
import type { Services } from "./services";

export type Screen = "onboarding" | "ask" | "review" | "thread" | "ledger" | "vault" | "settings";

export interface Prefs {
  dial: DialPreset;
  preference: AnswerPreference;
  onboarded: boolean;
}

export interface UserTurn {
  kind: "user";
  /** What the user wrote — shown locally only. */
  raw: string;
  sealed: SealedText;
}
export interface AssistantTurn {
  kind: "assistant";
  status: "streaming" | "done" | "error";
  text: string;
  segments: RestoredSegment[];
  outcome: AnswerOutcome | null;
  error: string | null;
}
export interface Thread {
  id: string;
  title: string;
  task: TaskKind;
  entities: EntityMap;
  turns: (UserTurn | AssistantTurn)[];
  createdAt: number;
}

export interface Review {
  raw: string;
  task: TaskKind;
  threadId: string | null;
  progress: SealProgress | null;
  result: SealResult | null;
  overrides: Map<PlaceholderId, UserOverride>;
  accepted: Risk[];
  dismissed: Set<number>;
  blocked: GateHit[] | null;
  error: string | null;
}

export interface State {
  screen: Screen;
  prefs: Prefs;
  availability: PhoneAvailability | "checking";
  downloadProgress: number | null;
  vault: VaultEntry[];
  threads: Thread[];
  currentThreadId: string | null;
  review: Review | null;
  chain: ChainVerification | null;
}

const PREFS_KEY = "airlock.prefs.v1";
const defaultPrefs: Prefs = { dial: "balanced", preference: "auto", onboarded: false };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...defaultPrefs, ...(JSON.parse(raw) as Partial<Prefs>) } : defaultPrefs;
  } catch {
    return defaultPrefs;
  }
}

/** Plain-language names for gate checks — never the matched value (INV-8). */
export const GATE_CHECK_NAMES: Record<string, string> = {
  G1: "a name from your Vault",
  G2: "a detail Airlock sealed elsewhere in the text",
  G3: "an email, phone number, ID or code",
  G4: "a malformed placeholder",
  G5: "an explanation that reveals too much",
  G6: "hidden or look-alike characters",
  G7: "a message that's too long",
};

export function engineErrorMessage(e: unknown): string {
  const code = e instanceof EngineError ? e.code : "other";
  switch (code) {
    case "offline": return "You're offline. Quick tasks still work on this device; Gemini needs a connection.";
    case "quota": case "serviceUnavailable": return "Gemini is busy right now. Try again in a moment, or answer on this device instead.";
    case "armorBlocked": return "Google's safety check stopped this request — something identifying may have slipped past Airlock. Nothing was answered.";
    case "cloudBlocked": return "Gemini declined to answer this request.";
    case "appCheck": return "This app couldn't prove it's genuine to Firebase (App Check). Please reload.";
    case "needsUserGesture": return "Click “Enable on-device AI” first so Chrome can prepare its model.";
    case "unavailable": return "The on-device model isn't available in this browser.";
    default: return "Something went wrong. Nothing private was sent.";
  }
}

export class AirlockSession {
  private state: State;
  private readonly listeners = new Set<() => void>();
  readonly ledger: ReceiptLedger;

  constructor(readonly services: Services, prefs: Prefs = loadPrefs()) {
    this.state = { screen: prefs.onboarded ? "ask" : "onboarding", prefs, availability: "checking", downloadProgress: null, vault: [], threads: [], currentThreadId: null, review: null, chain: null };
    this.ledger = new ReceiptLedger([], (r) => services.stores.saveReceipt(r));
  }

  // MARK: store plumbing
  getState = (): State => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  private setReview(patch: Partial<Review>): void {
    if (this.state.review) this.set({ review: { ...this.state.review, ...patch } });
  }
  private setThread(id: string, f: (t: Thread) => Thread): void {
    this.set({ threads: this.state.threads.map((t) => (t.id === id ? f(t) : t)) });
  }

  async load(): Promise<void> {
    const [vault, receipts] = await Promise.all([this.services.stores.loadVault(), this.services.stores.receipts()]);
    this.ledger.receipts.push(...receipts);
    this.set({ vault });
    await this.services.stores.purgeCaptures(this.services.config.rawPurgeDays);
    await this.refreshAvailability();
  }

  async refreshAvailability(): Promise<void> {
    this.set({ availability: await this.services.availability() });
  }

  /** Call from a click: may download Chrome's on-device model. */
  async enableOnDevice(): Promise<void> {
    if (!this.services.initializeOnDevice) return;
    this.set({ downloadProgress: 0 });
    try {
      await this.services.initializeOnDevice((f) => this.set({ downloadProgress: f }));
    } catch {
      // Reflected by the availability check below.
    }
    this.set({ downloadProgress: null });
    await this.refreshAvailability();
  }

  go(screen: Screen): void {
    this.set({ screen });
  }
  openThread(id: string): void {
    this.set({ currentThreadId: id, screen: "thread" });
  }

  setPrefs(patch: Partial<Prefs>): void {
    const prefs = { ...this.state.prefs, ...patch };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Preferences are a convenience; the app works without storage.
    }
    this.set({ prefs });
  }

  finishOnboarding(): void {
    this.setPrefs({ onboarded: true });
    this.go("ask");
  }

  // MARK: Vault
  async saveVault(vault: VaultEntry[]): Promise<void> {
    await this.services.stores.saveVault(vault);
    this.set({ vault });
  }

  // MARK: Seal
  private pipeline(): SealPipeline {
    const s = this.services;
    return new SealPipeline(s.engines.phone, s.patterns, this.state.vault, s.prompts, sealSettings(s.config, { dial: this.state.prefs.dial }));
  }

  /** Ask → Review: runs detection, policy, sealing and red-team on the device. */
  async startReview(raw: string, task: TaskKind, threadId: string | null = null): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    this.set({ screen: "review", review: { raw: text, task, threadId, progress: null, result: null, overrides: new Map(), accepted: [], dismissed: new Set(), blocked: null, error: null } });
    await this.services.stores.saveCapture(text, threadId ? "followUp" : "paste", threadId);
    const existing = threadId ? this.state.threads.find((t) => t.id === threadId)?.entities : undefined;
    try {
      const result = await this.pipeline().run(text, existing ?? new EntityMapClass(), new Map(), (p) => this.setReview({ progress: p }));
      this.setReview({ result, accepted: result.acceptedRisks });
    } catch {
      this.setReview({ error: "Airlock couldn't read this on your device. Nothing was sent." });
    }
  }

  private reseal(overrides: Map<PlaceholderId, UserOverride>, accepted: Risk[]): void {
    const r = this.state.review;
    if (!r?.result) return;
    const result = this.pipeline().reseal(r.result, overrides, accepted);
    this.setReview({ result, overrides, accepted, blocked: null });
  }

  /** Chip/list toggle: send as written ↔ protect. Vault entries need an explicit "reveal this time". */
  toggleEntity(id: PlaceholderId): void {
    const r = this.state.review;
    const e = r?.result?.draft.entities.get(id);
    if (!r || !e) return;
    const overrides = new Map(r.overrides);
    const isKept = e.action.kind === "keep";
    overrides.set(id, isKept ? { action: PLACEHOLDER, revealThisTime: false } : { action: KEEP, revealThisTime: e.vaultEntryId != null });
    this.reseal(overrides, r.accepted);
  }

  acceptRisk(risk: Risk): void {
    const r = this.state.review;
    if (r) this.reseal(r.overrides, [...r.accepted.filter((x) => x.id !== risk.id), risk]);
  }
  dismissRisk(risk: Risk): void {
    const r = this.state.review;
    if (r) this.setReview({ dismissed: new Set([...r.dismissed, risk.id]) });
  }
  pendingRisks(): Risk[] {
    const r = this.state.review;
    return r?.result ? pendingRisks({ risks: r.result.risks, acceptedRisks: r.accepted }).filter((x) => !r.dismissed.has(x.id)) : [];
  }

  setReviewTask(task: TaskKind): void {
    this.setReview({ task });
  }

  /** Seal & send: the egress gate is the only way out. */
  async send(): Promise<void> {
    const r = this.state.review;
    if (!r?.result) return;
    const gate = new EgressGate(this.services.patterns, this.state.vault);
    let sealed: SealedText;
    try {
      sealed = gate.seal(applyRisks(r.accepted, r.result.draft));
    } catch (e) {
      if (e instanceof GateBlocked) {
        this.setReview({ blocked: [...e.hits] });
        return;
      }
      throw e;
    }
    const entities = r.result.draft.entities;
    let threadId = r.threadId;
    if (!threadId) {
      threadId = crypto.randomUUID();
      const title = titleFrom(sealed.value);
      this.set({ threads: [{ id: threadId, title, task: r.task, entities, turns: [], createdAt: Date.now() }, ...this.state.threads] });
    }
    await this.services.stores.saveEntities(threadId, entities);
    const history = historyOf(this.state.threads.find((t) => t.id === threadId));
    this.setThread(threadId, (t) => ({ ...t, entities, turns: [...t.turns, { kind: "user", raw: r.raw, sealed }, { kind: "assistant", status: "streaming", text: "", segments: [], outcome: null, error: null }] }));
    this.set({ review: null, currentThreadId: threadId, screen: "thread" });
    await this.stream(threadId, sealed, r.task, entities, history, r.result.sealMs);
  }

  private async stream(threadId: string, sealed: SealedText, task: TaskKind, entities: EntityMap, history: SealedHistory, sealMs: number): Promise<void> {
    const me = this.state.vault.find((v) => v.isUser);
    const updateLast = (patch: Partial<AssistantTurn>): void =>
      this.setThread(threadId, (t) => {
        const turns = [...t.turns];
        const last = turns[turns.length - 1];
        if (last?.kind === "assistant") turns[turns.length - 1] = { ...last, ...patch };
        return { ...t, turns };
      });
    try {
      for await (const ev of answer({
        engines: this.services.engines, prompts: this.services.prompts, ledger: this.ledger, sealed, task, history: history.turns.length ? history : undefined,
        restore: { entities, userFirstName: me?.canonical.split(" ")[0] ?? null }, preference: this.state.prefs.preference, threadId, sealMs,
        armorExpected: this.services.config.armorExpected,
      })) {
        if (ev.kind === "partial") updateLast({ text: ev.text, segments: ev.segments });
        if (ev.kind === "finished") updateLast({ status: "done", outcome: ev.outcome, text: ev.outcome.restored.text, segments: ev.outcome.restored.segments });
      }
    } catch (e) {
      updateLast({ status: "error", error: engineErrorMessage(e) });
    }
  }

  // MARK: Ledger and data
  verifyChain(): ChainVerification {
    const chain = this.ledger.verify();
    this.set({ chain });
    return chain;
  }
  stats(days = 7): LedgerStats {
    return this.ledger.stats(new Date(Date.now() - days * 86_400_000));
  }

  async deleteEverything(): Promise<void> {
    await this.services.stores.deleteEverything();
    this.ledger.receipts.length = 0;
    try {
      localStorage.removeItem(PREFS_KEY);
    } catch {
      // ignore
    }
    this.set({ vault: [], threads: [], currentThreadId: null, review: null, chain: null, prefs: defaultPrefs, screen: "onboarding" });
  }
}

/** First few words of the sealed text, placeholders removed (title.v1 on device is a later refinement). */
export function titleFrom(sealed: string): string {
  const nouns: Record<string, string> = { PERSON: "someone", ORG: "an organisation", LOC: "a place", CONTACT: "a contact", ID: "an ID", DATE: "a date", HEALTH: "a health detail", SECRET: "a code" };
  const words = sealed.replace(/\[\[PERSON_ME\]\]/g, "me").replace(/\[\[([A-Z]+)_\d+\]\]/g, (_, p: string) => nouns[p] ?? "something").replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);
  const head = words.slice(0, 7);
  while (head.length > 1 && /^(a|an|the|at|to|of|and|or|in|on|for|with|my|your)$/i.test(head.at(-1)!)) head.pop();
  const t = head.join(" ");
  return t ? t[0]!.toUpperCase() + t.slice(1) : "Sealed request";
}

function historyOf(thread: Thread | undefined): SealedHistory {
  const turns: SealedHistory["turns"] = [];
  for (const t of thread?.turns ?? []) {
    if (t.kind === "user") turns.push({ role: "user", sealed: t.sealed });
    else if (t.outcome) turns.push({ role: "assistant", modelText: t.outcome.modelText });
  }
  return { turns };
}
