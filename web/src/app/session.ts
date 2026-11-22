// All app state and actions, independent of React (the UI subscribes via useSyncExternalStore).
import { answer, type AnswerOutcome, type AnswerPreference, type TaskKind } from "../engine/answer";
import { ANALYSIS_OPTIONS, EngineError, type PhoneAvailability, type SealedHistory } from "../engine/engines";
import { EgressGate, GateBlocked, type GateHit } from "../engine/gate";
import { ReceiptLedger, type LedgerStats } from "../engine/ledger";
import { pendingRisks, SealPipeline, sealSettings, type RulesPreview, type SealProgress, type SealResult } from "../engine/pipeline";
import type { SealTimings } from "../engine/timing";
import type { UserOverride } from "../engine/policy";
import { applyRisks, type Risk } from "../engine/redTeam";
import type { RestoredSegment } from "../engine/restore";
import { type DialPreset, type EntityMap, type PlaceholderId, type SealedText, EntityMap as EntityMapClass, KEEP, PLACEHOLDER } from "../engine/types";
import type { VaultEntry } from "../engine/vault";
import type { ChainVerification } from "../engine/hashchain";
import type { Services } from "./services";
import { inferWhatCloudCanGuess, type InferResult } from "../engine/infer";
import { renderedLegend } from "../engine/types";
import { restore, fidelityCheck } from "../engine/restore";
import { writesAsUser } from "../engine/answer";
import type { StoredSealed, StoredTurn, ThreadRecord } from "../store/encryptedStore";
import type { SealDraft } from "../engine/sealer";
import type { SyncBatch } from "../ai/sync";
import { assistantTurnDto, receiptDto, threadDto, userTurnDto, type ReceiptDto } from "./syncDto";
import type { PrivacyCategory, Route } from "../engine/types";
import type { ToolName } from "../engine/engines";
import { CalendarTool, DateContextTool, EntityRoleTool, parseIcs, type CalendarData, type ConsentBroker, type ConsentDecision, type ConsentRequest, type PrivateTool, type ToolActivity } from "../engine/tools";
import type { ToolSetup } from "../engine/answer";
import { sampleCalendarIcs } from "./sampleCalendar";
import { runProof, shareWarning, type ProofResult, type ProofStage } from "../engine/proof";

export type Screen = "onboarding" | "ask" | "review" | "thread" | "proof" | "ledger" | "vault" | "settings" | "evidence";

export interface Prefs {
  dial: DialPreset;
  preference: AnswerPreference;
  onboarded: boolean;
  /** Back up sealed history (only turns that already went to Gemini) to Firestore. */
  backup: boolean;
  /** Private tools the user chose "Always allow" for (no consent card). */
  toolsAlwaysAllow: ToolName[];
}

/** What the UI shows about the imported calendar (never its contents). */
export interface CalendarInfo {
  events: number;
  skipped: number;
  importedAt: number;
  sample: boolean;
}

/** A tool call waiting for the user's decision (shown as a consent card in its conversation). */
export interface PendingConsent extends ConsentRequest {
  threadId: string;
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
  /** FX-02: where this turn's seal time went (memory only, not saved or synced). */
  timings?: SealTimings;
}
export interface AssistantTurn {
  kind: "assistant";
  task: TaskKind;
  status: "streaming" | "done" | "error";
  text: string;
  segments: RestoredSegment[];
  outcome: AnswerOutcome | null;
  error: string | null;
  /** F-27: the text the user pasted (placeholders) before restore. */
  pasted?: string;
  /** Private tool calls made for this answer. */
  tools: ToolActivity[];
}
export interface Thread {
  id: string;
  title: string;
  /** "scrub": the user copied the sealed text to use elsewhere (F-27); answers are pasted back and restored. */
  mode?: "scrub";
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
  /** FX-02: Vault and rule hits, known before the model starts (local only). */
  found: RulesPreview | null;
  result: SealResult | null;
  overrides: Map<PlaceholderId, UserOverride>;
  accepted: Risk[];
  dismissed: Set<number>;
  blocked: GateHit[] | null;
  error: string | null;
  /** performance.now() when sealing started (for the elapsed timer). */
  startedAt: number;
}

/**
 * Proof mode ("Is this a scam?"). Kept in memory only: the raw message, red flags and Gemini's grounded
 * findings are never written to storage or synced (grounded results aren't cached — API-NOTES §2).
 */
export interface ProofState {
  raw: string;
  stage: ProofStage;
  startedAt: number;
  result: ProofResult | null;
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
  proof: ProofState | null;
  chain: ChainVerification | null;
  calendar: CalendarInfo | null;
  consents: PendingConsent[];
}

const prefsKey = (mode: string): string => (mode === "demo" ? "airlock.prefs.demo.v1" : "airlock.prefs.v1");
const defaultPrefs: Prefs = { dial: "balanced", preference: "auto", onboarded: false, backup: true, toolsAlwaysAllow: [] };

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

  constructor(readonly services: Services, initialPrefs: Partial<Prefs> = loadPrefs(services.mode)) {
    const prefs: Prefs = { ...defaultPrefs, ...initialPrefs };
    this.state = { screen: prefs.onboarded ? "ask" : "onboarding", prefs, availability: "checking", downloadProgress: null, vault: [], threads: [], currentThreadId: null, review: null, proof: null, chain: null, calendar: null, consents: [] };
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
    const cal = await this.services.stores.loadCalendar().catch(() => null);
    if (cal) this.setCalendar(cal.data, cal.sample);
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

  // MARK: Private tools

  private calendarData: CalendarData | null = null;
  private readonly consentWaiters = new Map<string, (d: ConsentDecision) => void>();

  private setCalendar(data: CalendarData | null, sample: boolean): void {
    this.calendarData = data;
    this.set({ calendar: data ? { events: data.events.length, skipped: data.skipped, importedAt: data.importedAt, sample } : null });
  }

  /**
   * Imports an .ics file's text. Parsed here; only busy times are kept (titles, places and people are never
   * read) and stored encrypted on this device. Nothing is uploaded. Returns false if no events were found.
   */
  async importCalendar(icsText: string, sample = false): Promise<boolean> {
    const data = parseIcs(icsText);
    if (data.events.length === 0) return false;
    await this.services.stores.saveCalendar({ data, sample });
    this.setCalendar(data, sample);
    return true;
  }

  /** Loads the built-in fictional calendar (for trying "Propose a meeting time"). */
  useSampleCalendar(): Promise<boolean> {
    return this.importCalendar(sampleCalendarIcs(), true);
  }

  async removeCalendar(): Promise<void> {
    await this.services.stores.deleteCalendar();
    this.setCalendar(null, false);
  }

  /** The consent card's buttons. "Always" also skips the card for this tool from now on. */
  answerConsent(id: string, decision: ConsentDecision, always = false): void {
    const pending = this.state.consents.find((c) => c.id === id);
    if (always && pending && decision === "allow" && !this.state.prefs.toolsAlwaysAllow.includes(pending.tool)) {
      this.setPrefs({ toolsAlwaysAllow: [...this.state.prefs.toolsAlwaysAllow, pending.tool] });
    }
    this.set({ consents: this.state.consents.filter((c) => c.id !== id) });
    const waiter = this.consentWaiters.get(id);
    this.consentWaiters.delete(id);
    waiter?.(decision);
  }

  resetAlwaysAllow(): void {
    this.setPrefs({ toolsAlwaysAllow: [] });
  }

  private consentBroker(threadId: string): ConsentBroker {
    return {
      request: (req) =>
        new Promise<ConsentDecision>((resolve) => {
          const id = `${threadId}:${req.id}:${crypto.randomUUID().slice(0, 8)}`;
          this.consentWaiters.set(id, resolve);
          this.set({ consents: [...this.state.consents, { ...req, id, threadId }] });
        }),
    };
  }

  /** Pending cards of a thread are declined when its answer ends or the thread goes away. */
  private dropConsents(threadId: string): void {
    for (const c of this.state.consents.filter((x) => x.threadId === threadId)) this.answerConsent(c.id, "deny");
  }

  /** Tools for an answer: dates and roles always; free time only with an imported calendar and the flag on. Never offline. */
  private toolSetup(threadId: string, entities: EntityMap): ToolSetup | undefined {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return undefined;
    const tools: PrivateTool[] = [DateContextTool, EntityRoleTool];
    if (this.calendarData && this.services.config.calendarToolEnabled) tools.push(CalendarTool);
    return {
      tools,
      context: { now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", entities, calendar: this.calendarData },
      gate: new EgressGate(this.services.patterns, this.state.vault),
      broker: this.consentBroker(threadId),
      maxRounds: this.services.config.toolMaxRounds,
      alwaysAllow: new Set(this.state.prefs.toolsAlwaysAllow),
    };
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
    this.set({ screen: "review", review: { raw: text, task, threadId, progress: null, found: null, result: null, overrides: new Map(), accepted: [], dismissed: new Set(), blocked: null, error: null, startedAt: performance.now() } });
    await this.services.stores.saveCapture(text, threadId ? "followUp" : "paste", threadId);
    const existing = threadId ? this.state.threads.find((t) => t.id === threadId)?.entities : undefined;
    let staged: Awaited<ReturnType<SealPipeline["runStaged"]>>;
    try {
      staged = await this.pipeline().runStaged(text, existing ?? new EntityMapClass(), new Map(), (p) => this.setReview(p.kind === "rulesReady" ? { found: p.preview } : { progress: p }));
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
    // Keep what the user changed meanwhile (Protect this re-merges): take only the red-team outcome from `full`.
    const merged = { ...full, merge: r.result.merge, candidates: r.result.candidates };
    this.setReview({ result: this.pipeline().reseal(merged, r.overrides, r.accepted) });
  }

  private warmed = false;
  /**
   * Loads Chrome's on-device model ahead of the first seal (the first long prompt after page load is ~2×
   * slower). A tiny fixed prompt — never user text — so a seal started straight after doesn't queue behind a
   * long warm-up on the GPU (FX-02). Once per page; errors are ignored.
   */
  warmUp(): void {
    if (this.warmed || this.state.availability !== "available" || this.services.mode !== "live") return;
    this.warmed = true;
    void this.services.engines.phone.respond({ promptId: "warmup", text: WARMUP_PROMPT }, ANALYSIS_OPTIONS).catch(() => {});
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

  /** "Protect this": mark a phrase the detectors missed; every occurrence becomes a placeholder. No model call. */
  protect(phrase: string, category: Exclude<PrivacyCategory, "quasi">): boolean {
    const r = this.state.review;
    if (!r?.result) return false;
    const before = r.result;
    const { result, overrides } = this.pipeline().protect(r.result, phrase, category, r.overrides, r.accepted);
    if (result === before) return false;
    this.setReview({ result, overrides, blocked: null });
    return true;
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
    const timings = r.result.timings;
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
    this.setThread(threadId, (t) => ({ ...t, entities, turns: [...t.turns, { kind: "user", raw: r.raw, display: sealed.value, sealed, stored, timings }, { kind: "assistant", task: r.task, status: "streaming", text: "", segments: [], outcome: null, error: null, tools: [] }] }));
    this.set({ review: null, currentThreadId: threadId, screen: "thread" });
    await this.stream(threadId, sealed, r.task, entities, history, r.result.sealMs);
    if (isNew) await this.nameThread(threadId, sealed);
    await this.persistThread(threadId);
    void this.backup(threadId);
  }

  /**
   * The last answer hit the output-token limit (UX-04): ask Gemini to carry on. The request is a fixed sentence with
   * no private details; it still goes through the egress gate like any follow-up, with the thread's sealed history.
   */
  async continueAnswer(threadId: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === threadId);
    const last = t?.turns[t.turns.length - 1];
    if (!t || last?.kind !== "assistant" || last.status !== "done" || !last.outcome?.truncated) return;
    const draft: SealDraft = {
      text: CONTINUE_REQUEST, legend: [], replacements: [], entities: t.entities, secretWarnings: [],
      revealedVaultIds: new Set(), keptValues: new Set(),
    };
    let sealed: SealedText;
    try {
      sealed = new EgressGate(this.services.patterns, this.state.vault).seal(draft);
    } catch {
      return;
    }
    const history = historyOf(t);
    const stored: StoredSealed = { text: draft.text, legend: [], revealedVaultIds: [], keptValues: [] };
    this.setThread(threadId, (x) => ({ ...x, turns: [...x.turns, { kind: "user", raw: CONTINUE_REQUEST, display: sealed.value, sealed, stored }, { kind: "assistant", task: { kind: "custom" }, status: "streaming", text: "", segments: [], outcome: null, error: null, tools: [] }] }));
    await this.stream(threadId, sealed, { kind: "custom" }, t.entities, history, 0);
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

  /**
   * F-27 Scrub & copy: produce the sealed version (through the egress gate, exactly like sending) for the user
   * to paste into any other tool, and open a conversation where they can paste the answer back to restore it.
   * Nothing is sent by Airlock, so no receipt is written (the copy is the user's own action).
   */
  async scrubAndCopy(): Promise<string | null> {
    const r = this.state.review;
    if (!r?.result || r.result.redTeamPending) return null;
    const draft = applyRisks(r.accepted, r.result.draft);
    let sealed: SealedText;
    try {
      sealed = new EgressGate(this.services.patterns, this.state.vault).seal(draft);
    } catch (e) {
      if (e instanceof GateBlocked) {
        this.setReview({ blocked: [...e.hits] });
        return null;
      }
      throw e;
    }
    const entities = r.result.draft.entities;
    const id = crypto.randomUUID();
    const stored: StoredSealed = { text: draft.text, legend: [...draft.legend], revealedVaultIds: [...draft.revealedVaultIds], keptValues: [...draft.keptValues] };
    this.set({
      threads: [{ id, title: titleFrom(sealed.value), mode: "scrub", task: r.task, entities, turns: [{ kind: "user", raw: r.raw, display: sealed.value, sealed, stored }], createdAt: Date.now() }, ...this.state.threads],
      review: null, currentThreadId: id, screen: "thread",
    });
    await this.services.stores.saveEntities(id, entities);
    await this.persistThread(id);
    return sealed.legend.length ? `${sealed.value}\n\n${renderedLegend(sealed)}` : sealed.value;
  }

  /** F-27: restore an answer the user got elsewhere, locally, with this conversation's placeholders. */
  async restorePasted(threadId: string, text: string): Promise<void> {
    const t = this.state.threads.find((x) => x.id === threadId);
    if (!t || !text.trim()) return;
    const me = this.state.vault.find((v) => v.isUser);
    const restored = restore(text, { entities: t.entities, userFirstName: me?.canonical.split(" ")[0] ?? null, writingAsUser: writesAsUser(t.task) });
    this.setThread(threadId, (x) => ({ ...x, turns: [...x.turns, { kind: "assistant", task: t.task, status: "done", text: restored.text, segments: restored.segments, outcome: null, error: null, pasted: text, tools: [] }] }));
    await this.persistThread(threadId);
  }

  /** F-25: ask Gemini what it can still infer from the sealed text it already saw (cloudOnly, new receipt). */
  async inferGuesses(threadId: string): Promise<InferResult> {
    const t = this.state.threads.find((x) => x.id === threadId);
    const last = [...(t?.turns ?? [])].reverse().find((x): x is UserTurn => x.kind === "user" && x.sealed !== null);
    if (!t || !last?.sealed) throw new EngineError("other", "no-sealed-turn");
    return inferWhatCloudCanGuess({ engines: this.services.engines, prompts: this.services.prompts, ledger: this.ledger, sealed: last.sealed, threadId, armorExpected: this.services.config.armorExpected });
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
          kind: "assistant", task: turn.task, status: turn.status, modelText: turn.outcome?.modelText ?? turn.pasted ?? "", error: turn.error,
          outcome: turn.outcome ? { route: turn.outcome.route, modelVersion: turn.outcome.modelVersion, ranOnDevice: turn.outcome.ranOnDevice, fellBackToPhone: turn.outcome.fellBackToPhone, latencyMs: turn.outcome.latencyMs, receiptId: turn.outcome.receipt?.id ?? null, ...(turn.tools.length ? { tools: turn.tools } : {}) } : null,
        });
    }
    try {
      await this.services.stores.saveThread({ v: 1, id: t.id, title: t.title, ...(t.mode ? { mode: t.mode } : {}), task: t.task, createdAt: t.createdAt, updatedAt: Date.now(), turns });
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
            kind: "assistant", task: st.task, status: st.status, text: restored.text, segments: restored.segments, error: st.error, tools: st.outcome?.tools ?? [], ...(st.outcome ? {} : { pasted: st.modelText }),
            outcome: o ? { modelText: st.modelText, restored, fidelity: fidelityCheck(st.modelText, ctx), route: o.route, modelVersion: o.modelVersion, ranOnDevice: o.ranOnDevice, fellBackToPhone: o.fellBackToPhone, latencyMs: o.latencyMs, receipt: this.ledger.receipts.find((x) => x.id === o.receiptId) ?? null } : null,
          });
        }
      }
      out.push({ id: rec.id, title: rec.title, ...(rec.mode ? { mode: rec.mode } : {}), task: rec.task, entities, turns, createdAt: rec.createdAt });
    }
    return out;
  }

  /** Deletes a conversation, its entity map and captures. Its receipts stay: the chain must stay verifiable. */
  async deleteThread(id: string): Promise<void> {
    this.dropConsents(id);
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
        armorExpected: this.services.config.armorExpected, tools: this.toolSetup(threadId, entities),
      })) {
        if (ev.kind === "partial") updateLast({ text: ev.text, segments: ev.segments });
        if (ev.kind === "tools") updateLast({ tools: ev.activity });
        if (ev.kind === "finished") updateLast({ status: "done", outcome: ev.outcome, text: ev.outcome.restored.text, segments: ev.outcome.restored.segments, tools: ev.outcome.tools ?? [] });
      }
    } catch (e) {
      updateLast({ status: "error", error: engineErrorMessage(e) });
    } finally {
      this.dropConsents(threadId);
    }
  }

  // MARK: Proof

  private proofRun = 0;

  /**
   * "Is this a scam?": red flags on the device, then only sealed claims go to Gemini with Google Search.
   * The raw message reaches the phone-only engine and nothing else (INV-1, INV-3).
   */
  async startProof(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    const run = ++this.proofRun;
    const s = this.services;
    this.set({ screen: "proof", proof: { raw: text, stage: "scanning", startedAt: performance.now(), result: null, error: null } });
    const setProof = (patch: Partial<ProofState>): void => {
      if (run === this.proofRun && this.state.proof) this.set({ proof: { ...this.state.proof, ...patch } });
    };
    try {
      const result = await runProof(text, {
        phone: s.engines.phone, claimCheck: s.engines.claimCheck ?? null, patterns: s.patterns, vault: this.state.vault, prompts: s.prompts, config: s.config,
        online: s.online(), ledger: this.ledger, threadId: `proof-${crypto.randomUUID()}`,
      }, (stage) => setProof({ stage }));
      setProof({ result, stage: "done" });
    } catch {
      setProof({ stage: "done", error: "Airlock couldn't check this message. Nothing private was sent." });
    }
  }

  /** Back to the empty Proof screen (the previous check is discarded, not stored). */
  resetProof(): void {
    this.proofRun++;
    this.set({ proof: null });
  }

  /** Opens Proof, optionally starting a check of text pasted on Ask. */
  openProof(text?: string): void {
    if (text?.trim()) void this.startProof(text);
    else this.set({ screen: "proof" });
  }

  /** The friendly family warning for the current verdict (fixed phrases only), or null. */
  proofShareText(): string | null {
    const r = this.state.proof?.result;
    return r ? shareWarning(r) : null;
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
    for (const c of this.state.consents) this.answerConsent(c.id, "deny");
    this.calendarData = null;
    this.set({ vault: [], threads: [], currentThreadId: null, review: null, proof: null, chain: null, calendar: null, consents: [], prefs: defaultPrefs, screen: "onboarding" });
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

/** The follow-up sent when an answer was cut off. Contains nothing private; still gate-checked. */
/** Fixed, content-free prompt that only makes Chrome load its on-device model. */
export const WARMUP_PROMPT = "Reply with the single word OK.";

export const CONTINUE_REQUEST = "Please continue your previous answer exactly where it stopped. Do not repeat what you already wrote.";

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
