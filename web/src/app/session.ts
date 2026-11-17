// All app state and actions, independent of React (the UI subscribes via useSyncExternalStore).
import { answer, type AnswerOutcome, type AnswerPreference, type TaskKind } from "../engine/answer";
import { ANALYSIS_OPTIONS, EngineError, type PhoneAvailability, type SealedHistory } from "../engine/engines";
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
import { restore, fidelityCheck } from "../engine/restore";
import { writesAsUser } from "../engine/answer";
import type { StoredSealed, StoredTurn, ThreadRecord } from "../store/encryptedStore";
import type { SealDraft } from "../engine/sealer";
import type { SyncBatch } from "../ai/sync";
import { assistantTurnDto, receiptDto, threadDto, userTurnDto, type ReceiptDto } from "./syncDto";
import type { Route } from "../engine/types";

export type Screen = "onboarding" | "ask" | "review" | "thread" | "ledger" | "vault" | "settings";

export interface Prefs {
  dial: DialPreset;
  preference: AnswerPreference;
  onboarded: boolean;
  /** Back up sealed history (only turns that already went to Gemini) to Firestore. */
  backup: boolean;
}

export interface UserTurn {
  kind: "user";
  /** What the user wrote — shown locally only. */
  raw: string;
  /** The sealed text as it left (for display). */
  display: string;
  /** Gate-checked sealed text for follow-up history; null if a reloaded turn no longer passes the gate. */
  sealed: SealedText | null;
  stored: StoredSealed;
}
export interface AssistantTurn {
  kind: "assistant";
  task: TaskKind;
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
  /** performance.now() when sealing started (for the elapsed timer). */
  startedAt: number;
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

const prefsKey = (mode: string): string => (mode === "demo" ? "airlock.prefs.demo.v1" : "airlock.prefs.v1");
const defaultPrefs: Prefs = { dial: "balanced", preference: "auto", onboarded: false, backup: true };

function loadPrefs(mode: string): Prefs {
  try {
    const raw = localStorage.getItem(prefsKey(mode));
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

  constructor(readonly services: Services, prefs: Prefs = loadPrefs(services.mode)) {
    this.state = { screen: prefs.onboarded ? "ask" : "onboarding", prefs, availability: "checking", downloadProgress: null, vault: [], threads: [], currentThreadId: null, review: null, chain: null };
    this.ledger = new ReceiptLedger([], (r) => services.stores.saveReceipt(r));
  }

  // MARK: store plumbing
  getState = (): State => this.state;
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private transition: (render: () => void) => void = (render) => render();
  /** The UI can animate screen changes (View Transitions). State always updates synchronously; only the re-render is wrapped. */
  setTransitionRunner(run: (render: () => void) => void): void {
    this.transition = run;
  }
  private notify = (): void => {
    for (const fn of this.listeners) fn();
  };
  private set(patch: Partial<State>): void {
    const screenChanged = patch.screen !== undefined && patch.screen !== this.state.screen;
    this.state = { ...this.state, ...patch };
    if (screenChanged) this.transition(this.notify);
    else this.notify();
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
    this.set({ vault, threads: await this.loadThreads(vault) });
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
      localStorage.setItem(prefsKey(this.services.mode), JSON.stringify(prefs));
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
    this.set({ screen: "review", review: { raw: text, task, threadId, progress: null, result: null, overrides: new Map(), accepted: [], dismissed: new Set(), blocked: null, error: null, startedAt: performance.now() } });
    await this.services.stores.saveCapture(text, threadId ? "followUp" : "paste", threadId);
    const existing = threadId ? this.state.threads.find((t) => t.id === threadId)?.entities : undefined;
    let staged: Awaited<ReturnType<SealPipeline["runStaged"]>>;
    try {
      staged = await this.pipeline().runStaged(text, existing ?? new EntityMapClass(), new Map(), (p) => this.setReview({ progress: p }));
    } catch {
      this.setReview({ error: "Airlock couldn't read this on your device. Nothing was sent." });
      return;
    }
    const { result, later } = staged;
    this.setReview({ result, accepted: result.acceptedRisks });
    if (!later) return;
    // Balanced: the red-team finishes while the user reads the draft. Their chip edits are re-applied on top.
    const full = await later.catch(() => ({ ...result, redTeamPending: false, redTeamUnavailable: true }));
    const r = this.state.review;
    if (!r?.result || r.result.normalised !== result.normalised) return;
    this.setReview({ result: this.pipeline().reseal(full, r.overrides, r.accepted) });
  }

  private warmed = false;
  /**
   * Loads Chrome's on-device model ahead of the first seal (the first long prompt after page load is ~2×
   * slower). Uses a fixed, fictional sentence — never user text. Once per page; errors are ignored.
   */
  warmUp(): void {
    if (this.warmed || this.state.availability !== "available" || this.services.mode !== "live") return;
    this.warmed = true;
    const text = this.services.prompts.render("detect.v1", { chunk: "The weekly meeting moved to the small room upstairs. Bring the printed agenda and a pen." });
    void this.services.engines.phone.respond({ promptId: "detect.v1", text }, ANALYSIS_OPTIONS).catch(() => {});
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
    if (!r?.result || r.result.redTeamPending) return;
    const gate = new EgressGate(this.services.patterns, this.state.vault);
    const draft = applyRisks(r.accepted, r.result.draft);
    let sealed: SealedText;
    try {
      sealed = gate.seal(draft);
    } catch (e) {
      if (e instanceof GateBlocked) {
        this.setReview({ blocked: [...e.hits] });
        return;
      }
      throw e;
    }
    const entities = r.result.draft.entities;
    let threadId = r.threadId;
    const isNew = !threadId;
    if (!threadId) {
      threadId = crypto.randomUUID();
      const title = titleFrom(sealed.value);
      this.set({ threads: [{ id: threadId, title, task: r.task, entities, turns: [], createdAt: Date.now() }, ...this.state.threads] });
    }
    await this.services.stores.saveEntities(threadId, entities);
    const history = historyOf(this.state.threads.find((t) => t.id === threadId));
    const stored: StoredSealed = { text: draft.text, legend: [...draft.legend], revealedVaultIds: [...draft.revealedVaultIds], keptValues: [...draft.keptValues] };
    this.setThread(threadId, (t) => ({ ...t, entities, turns: [...t.turns, { kind: "user", raw: r.raw, display: sealed.value, sealed, stored }, { kind: "assistant", task: r.task, status: "streaming", text: "", segments: [], outcome: null, error: null }] }));
    this.set({ review: null, currentThreadId: threadId, screen: "thread" });
    await this.stream(threadId, sealed, r.task, entities, history, r.result.sealMs);
    if (isNew) await this.nameThread(threadId, sealed);
    await this.persistThread(threadId);
    void this.backup(threadId);
  }

  /**
   * Sealed-history backup. Only pairs whose answer has a receipt (i.e. the sealed text already went to Gemini)
   * are synced, so "On this device · nothing sent" stays true for on-device answers. Never blocks the UI.
   */
  private async backup(threadId: string): Promise<void> {
    const sync = this.services.sync;
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!sync || !this.state.prefs.backup || !t) return;
    const turns: SyncBatch["turns"] = [];
    let receipt: ReceiptDto | null = null;
    let lastRoute: Route = "cloudFirst";
    t.turns.forEach((turn, i) => {
      const answer = t.turns[i + 1];
      if (turn.kind !== "user" || !turn.sealed || answer?.kind !== "assistant" || !answer.outcome?.receipt) return;
      const o = answer.outcome;
      const r = o.receipt!;
      const at = Date.parse(r.createdAt) || Date.now();
      turns.push({ id: `${String(i).padStart(3, "0")}-user`, dto: userTurnDto(turn.sealed, o.route, o.modelVersion, r.id, at) });
      turns.push({ id: `${String(i + 1).padStart(3, "0")}-assistant`, dto: assistantTurnDto(o.modelText, o.route, o.modelVersion, r.id, at) });
      receipt = receiptDto(r);
      lastRoute = o.route;
    });
    if (!turns.length) return;
    try {
      await sync.push({ threadId, thread: threadDto({ title: t.title, createdAt: t.createdAt, updatedAt: Date.now(), lastRoute, turnCount: turns.length }), turns, receipt, profile: { dial: this.state.prefs.dial, appVersion: "web-0.1.0" } });
    } catch {
      // Backup is best-effort; the conversation is saved locally regardless.
    }
  }

  /** On-device title from the *sealed* first message (`title.v1`), so a title can't contain a real name. */
  private async nameThread(id: string, sealed: SealedText): Promise<void> {
    if (this.state.availability !== "available") return;
    try {
      const prompt = this.services.prompts.render("title.v1", { sealed_first_message: sealed.value.slice(0, 2000) });
      const out = (await this.services.engines.phone.respond({ promptId: "title.v1", text: prompt }, ANALYSIS_OPTIONS)).text;
      const title = cleanTitle(out);
      if (title) this.setThread(id, (t) => ({ ...t, title }));
    } catch {
      // Keep the rule-based title.
    }
  }

  // MARK: Saved conversations (encrypted, local only)

  private async persistThread(id: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === id);
    if (!t) return;
    const turns: StoredTurn[] = [];
    for (const turn of t.turns) {
      if (turn.kind === "user") turns.push({ kind: "user", raw: turn.raw, sealed: turn.stored });
      else if (turn.status !== "streaming")
        turns.push({
          kind: "assistant", task: turn.task, status: turn.status, modelText: turn.outcome?.modelText ?? "", error: turn.error,
          outcome: turn.outcome ? { route: turn.outcome.route, modelVersion: turn.outcome.modelVersion, ranOnDevice: turn.outcome.ranOnDevice, fellBackToPhone: turn.outcome.fellBackToPhone, latencyMs: turn.outcome.latencyMs, receiptId: turn.outcome.receipt?.id ?? null } : null,
        });
    }
    try {
      await this.services.stores.saveThread({ v: 1, id: t.id, title: t.title, task: t.task, createdAt: t.createdAt, updatedAt: Date.now(), turns });
    } catch {
      // Saving is best-effort; the conversation stays usable in memory.
    }
  }

  /**
   * Rebuilds saved conversations. Sealed turns are never trusted from storage: each goes back through
   * `EgressGate.seal` (INV-2). A turn that no longer passes (e.g. the Vault changed) is still shown, but it
   * and its answer are left out of the history sent with follow-ups.
   */
  private async loadThreads(vault: VaultEntry[]): Promise<Thread[]> {
    const gate = new EgressGate(this.services.patterns, vault);
    const me = vault.find((v) => v.isUser);
    const out: Thread[] = [];
    for (const rec of await this.services.stores.threads()) {
      const entities = await this.services.stores.loadEntities(rec.id);
      const turns: (UserTurn | AssistantTurn)[] = [];
      for (const st of rec.turns) {
        if (st.kind === "user") {
          const draft: SealDraft = { text: st.sealed.text, legend: st.sealed.legend, replacements: [], entities, secretWarnings: [], revealedVaultIds: new Set(st.sealed.revealedVaultIds), keptValues: new Set(st.sealed.keptValues) };
          let sealed: SealedText | null = null;
          try {
            sealed = gate.seal(draft);
          } catch {
            sealed = null;
          }
          turns.push({ kind: "user", raw: st.raw, display: st.sealed.text, sealed, stored: st.sealed });
        } else {
          const ctx = { entities, userFirstName: me?.canonical.split(" ")[0] ?? null, writingAsUser: writesAsUser(st.task) };
          const restored = restore(st.modelText, ctx);
          const o = st.outcome;
          turns.push({
            kind: "assistant", task: st.task, status: st.status, text: restored.text, segments: restored.segments, error: st.error,
            outcome: o ? { modelText: st.modelText, restored, fidelity: fidelityCheck(st.modelText, ctx), route: o.route, modelVersion: o.modelVersion, ranOnDevice: o.ranOnDevice, fellBackToPhone: o.fellBackToPhone, latencyMs: o.latencyMs, receipt: this.ledger.receipts.find((x) => x.id === o.receiptId) ?? null } : null,
          });
        }
      }
      out.push({ id: rec.id, title: rec.title, task: rec.task, entities, turns, createdAt: rec.createdAt });
    }
    return out;
  }

  /** Deletes a conversation, its entity map and captures. Its receipts stay: the chain must stay verifiable. */
  async deleteThread(id: string): Promise<void> {
    await this.services.stores.deleteThread(id);
    void this.services.sync?.deleteThread(id).catch(() => {});
    this.set({ threads: this.state.threads.filter((t) => t.id !== id), ...(this.state.currentThreadId === id ? { currentThreadId: null, screen: "ask" as Screen } : {}) });
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
    await this.services.sync?.deleteAll().catch(() => {});
    await this.services.stores.deleteEverything();
    this.ledger.receipts.length = 0;
    try {
      localStorage.removeItem(prefsKey(this.services.mode));
    } catch {
      // ignore
    }
    this.set({ vault: [], threads: [], currentThreadId: null, review: null, chain: null, prefs: defaultPrefs, screen: "onboarding" });
  }
}

/** Accepts a model title only if it is short, plain words, and free of placeholders. */
export function cleanTitle(out: string): string | null {
  const line = out.trim().split("\n")[0]?.replace(/^(title:\s*)/i, "").replace(/^["'*#\s]+|["'*.\s]+$/g, "").trim() ?? "";
  if (!line || line.length > 60 || /\[\[|_\d|\bME\b|[{}<>]/.test(line) || !/\p{L}/u.test(line)) return null;
  if (line.split(/\s+/).length > 7) return null;
  return line[0]!.toUpperCase() + line.slice(1);
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
  let skipAnswer = false;
  for (const t of thread?.turns ?? []) {
    if (t.kind === "user") {
      skipAnswer = t.sealed === null;
      if (t.sealed) turns.push({ role: "user", sealed: t.sealed });
    } else if (t.outcome && !skipAnswer) turns.push({ role: "assistant", modelText: t.outcome.modelText });
  }
  return { turns };
}
