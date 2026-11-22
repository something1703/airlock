import AirlockCore
import AirlockDetect
import AirlockLedger
import AirlockRestore
import AirlockRoute
import AirlockSeal
import AirlockStore
import Foundation
import Observation
import os

/// All app state and actions — the native port of `web/src/app/session.ts`. Views are thin: they
/// read this model and call its actions; only this model talks to AirlockKit (AGENTS.md §7).
///
/// Guarantees:
/// - Raw text only goes to `SealPipeline` (phone-only engine) and the encrypted local stores.
/// - The only way out is `EgressGate.seal` → `AnswerService` (INV-1, INV-2). Saved sealed turns are
///   re-gated on load; a turn that no longer passes is shown but never resent.
/// - Restored answers and entity maps stay on device (INV-6, INV-7).
@Observable
@MainActor
final class AirlockSession {
    let services: AppServices

    private(set) var prefs: Prefs
    var section: AppSection = .ask
    var askPath: [AskRoute] = []
    /// nil while checking.
    private(set) var availability: PhoneAvailability?
    private(set) var vault: [VaultEntry] = []
    private(set) var threads: [ChatThread] = []
    private(set) var review: ReviewState?
    private(set) var chain: ChainVerification?
    /// Increments on every Verify (re-runs the row animation).
    private(set) var chainRun = 0
    private(set) var receipts: [Receipt] = []
    private(set) var stats: LedgerStats?
    private(set) var isLoaded = false
    /// Set when the egress gate blocks a send (drives the error haptic).
    private(set) var blockCount = 0
    /// F-25 guesses per conversation id.
    private(set) var guesses: [String: GuessState] = [:]
    /// The receipt the Ledger should open and scroll to (⌘R, "see receipt"), and a counter that
    /// changes on every request so the same receipt can be shown twice.
    private(set) var focusedReceiptID: String?
    private(set) var receiptFocusRun = 0
    /// Bumped by the Seal menu command (⌘↩); Ask and Review run their own seal action on change.
    private(set) var sealRequest = 0
    /// Settings opens on "How Airlock works" (demo screenshots).
    var showAbout = false
    /// Settings opens "How Airlock is tested" once (demo screenshots); Settings clears it.
    var showEvidence = false
    /// Review opens scrolled to its buttons (demo screenshots of Scrub & copy).
    var revealReviewActions = false

    @ObservationIgnored private var ledger = ReceiptLedger()
    @ObservationIgnored private var answers: AnswerService
    @ObservationIgnored private var reviewPipeline: SealPipeline?
    /// The red-team check still running behind a shown draft (FX-02); cancelled when the review goes away.
    @ObservationIgnored private var reviewLater: Task<SealResult, Never>?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let prefsKey: String
    private static let log = Logger(subsystem: "app.airlock", category: "session")

    init(services: AppServices, defaults: UserDefaults = .standard) {
        self.services = services
        self.defaults = defaults
        prefsKey = services.mode.isDemo ? "airlock.prefs.demo.v1" : "airlock.prefs.v1"
        prefs = defaults.data(forKey: prefsKey).flatMap { try? JSONDecoder().decode(Prefs.self, from: $0) } ?? Prefs(dial: services.config.dialDefault)
        answers = AnswerService(engines: services.engines, prompts: services.prompts, ledger: ledger, armorExpected: services.config.bool("armor_expected"))
    }

    // MARK: Loading

    func load() async {
        guard !isLoaded else { return }
        vault = (try? await services.stores.loadVault()) ?? []
        let saved = await services.conversations.receipts()
        ledger = ReceiptLedger(receipts: saved)
        answers = AnswerService(
            engines: services.engines, prompts: services.prompts, ledger: ledger, armorExpected: services.config.bool("armor_expected"))
        receipts = saved
        threads = await loadThreads()
        await services.stores.purgeCaptures(olderThanDays: services.config.int("raw_purge_days"))
        await refreshStats()
        await refreshAvailability()
        isLoaded = true
        await runDemoScript()
        Self.log.notice("Session ready")
    }

    func refreshAvailability() async {
        availability = await services.availability()
    }

    // MARK: Navigation

    var sidebarSelection: SidebarItem? {
        get {
            if section == .ask, case .thread(let id)? = askPath.first { return .thread(id) }
            return .section(section)
        }
        set {
            switch newValue {
            case .section(let s)?:
                if s == .ask && section == .ask && askPath.isEmpty { return }
                section = s
                if s == .ask { askPath = [] }
            case .thread(let id)?: openThread(id)
            case nil: break
            }
        }
    }

    func go(_ s: AppSection) {
        section = s
        if s == .ask { askPath = [] }
    }

    /// AirlockBench results for "How Airlock is tested": Remote Config `evidence_json` when it
    /// parses, otherwise the best report bundled with the app (real runs before mock runs).
    var evidence: Evidence? {
        Evidence.load(remoteJSON: services.config.string("evidence_json"), bundled: Evidence.bundledReports())
    }

    func openThread(_ id: String) {
        section = .ask
        askPath = [.thread(id)]
    }

    func thread(_ id: String) -> ChatThread? { threads.first { $0.id == id } }

    /// The Ask stack's top screen.
    var isReviewShowing: Bool { section == .ask && askPath.last == .review }

    /// Review is finished sealing and on screen (menu commands).
    var canSealAndSend: Bool { isReviewShowing && review?.result != nil && review?.result?.redTeamPending != true }

    /// The on-device "what could still be guessed" check is still running behind the shown draft (FX-02); sending waits.
    var redTeamPending: Bool { review?.result?.redTeamPending == true }

    /// Scrub & copy is offered for a new request only (a follow-up belongs to its conversation).
    var canCopySealed: Bool { canSealAndSend && review?.threadID == nil }

    /// ⌘↩ from the menu: Ask seals its draft, Review seals and sends.
    func requestSeal() { sealRequest += 1 }

    /// Opens the Ledger on one receipt (the latest when `id` is nil).
    func openReceipt(_ id: String? = nil) {
        guard let target = id ?? receipts.last?.id else { return }
        focusedReceiptID = target
        receiptFocusRun += 1
        go(.ledger)
    }

    // MARK: Preferences and onboarding

    func setPrefs(_ change: (inout Prefs) -> Void) {
        var p = prefs
        change(&p)
        prefs = p
        if let data = try? JSONEncoder().encode(p) { defaults.set(data, forKey: prefsKey) }
    }

    func finishOnboarding() {
        setPrefs { $0.onboarded = true }
        go(.ask)
    }

    // MARK: Vault

    func saveVault(_ entries: [VaultEntry]) async {
        do {
            try await services.stores.saveVault(entries)
        } catch {
            Self.log.error("Vault save failed")
        }
        vault = entries
    }

    func addVaultEntries(_ entries: [VaultEntry]) async { await saveVault(vault + entries) }

    func removeVaultEntry(_ id: String) async { await saveVault(vault.filter { $0.id != id }) }

    /// "Raj Patel" → ["Raj"]: people are usually written by first name.
    static func firstNameAlias(_ name: String) -> [String] {
        let parts = name.split(whereSeparator: \.isWhitespace)
        guard parts.count > 1, let first = parts.first, first.count > 1 else { return [] }
        return [String(first)]
    }

    // MARK: Seal (Ask → Review)

    /// Whether a request would be answered on the device with no seal and no Review (FX-02). For the Ask button's label.
    func staysOnDevice(_ task: TaskOption, _ raw: String) -> Bool {
        LocalAnswer.runsOnDevice(
            task: task.kind, preference: prefs.preference, availability: availability,
            rawLength: raw.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)
    }

    /// Ask and follow-up entry point. A quick task (or "This device only") with the on-device model available is answered right
    /// here from the raw message: nothing leaves, so there is nothing to review. If that fails for any reason, or the request needs
    /// the cloud, the normal seal → Review → gate flow runs.
    func submit(_ raw: String, task: TaskOption, threadID: String? = nil) async {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if staysOnDevice(task, text), await askOnDevice(text, task: task, threadID: threadID) { return }
        await startReview(text, task: task, threadID: threadID)
    }

    /// Thread title for a conversation that has no sealed text yet: the task, never the user's words (titles can sync).
    static func localTitle(_ task: TaskOption) -> String {
        switch task {
        case .help: String(localized: "Help with a message")
        case .reply: String(localized: "Reply to a message")
        case .explain: String(localized: "Explanation of a message")
        case .summary: String(localized: "Summary of a message")
        case .questions: String(localized: "Questions to ask")
        case .actions: String(localized: "Actions from a message")
        }
    }

    /// Answers from the raw message with the phone-only engine (INV-3). The turns are `local`: no sealed version, never in the
    /// history sent to Gemini, no receipt, never backed up (INV-1, INV-7). Returns false, leaving no trace in the thread, when the
    /// on-device answer fails, so the caller can run the normal flow.
    private func askOnDevice(_ raw: String, task: TaskOption, threadID: String?) async -> Bool {
        let existing = threadID.flatMap { thread($0) }
        let id = existing?.id ?? UUID().uuidString
        var earlier: [LocalAnswer.Exchange] = []
        if let existing {
            let turns = existing.turns
            for i in turns.indices.dropLast() {
                if case .user(let u) = turns[i], u.local, case .assistant(let a) = turns[i + 1], a.local, a.status == .done, let s = a.summary {
                    earlier.append(.init(raw: u.raw, answer: s.modelText))
                }
            }
        }
        let stored = StoredSealed(text: "", legend: [], revealedVaultIDs: [], keptValues: [], local: true)
        let newTurns: [Turn] = [
            .user(UserTurn(raw: raw, display: "", sealed: nil, stored: stored, local: true)),
            .assistant(AssistantTurn(task: task, status: .streaming, segments: [], animate: true, local: true)),
        ]
        let priorPath = askPath
        if existing != nil {
            updateThread(id) { $0.turns.append(contentsOf: newTurns) }
        } else {
            threads.insert(ChatThread(id: id, title: Self.localTitle(task), task: task, entities: EntityMap(), turns: newTurns, createdAt: Date()), at: 0)
        }
        section = .ask
        askPath = [.thread(id)]
        let result: LocalAnswer.Result
        do {
            result = try await LocalAnswer.run(phone: services.engines.phone, prompts: services.prompts, task: task.kind, raw: raw, earlier: earlier)
        } catch {
            // Leave no trace: the normal flow starts from the same text.
            if existing != nil {
                updateThread(id) { $0.turns.removeLast(2) }
            } else {
                threads.removeAll { $0.id == id }
            }
            askPath = priorPath
            Self.log.notice("On-device answer failed; falling back to Review")
            return false
        }
        let outcome = StoredOutcome(
            route: .phoneOnly, modelVersion: result.modelVersion, ranOnDevice: true, fellBackToPhone: false,
            latencyMs: Int(result.latency.components.seconds * 1000 + result.latency.components.attoseconds / 1_000_000_000_000_000),
            receiptID: nil, local: true)
        updateThread(id) { t in
            guard case .assistant(var a)? = t.turns.last else { return }
            a.status = .done
            a.segments = [.text(result.text)]
            a.summary = AnswerSummary(stored: outcome, modelText: result.text, receipt: nil, fidelity: .clean)
            t.turns[t.turns.count - 1] = .assistant(a)
        }
        _ = try? await services.stores.saveCapture(RawText(raw, source: existing == nil ? .paste : .followUp), thread: id)
        do { try await services.stores.saveEntities(existing?.entities ?? EntityMap(), thread: id) } catch { Self.log.error("Entity map save failed") }
        await persist(id)
        return true
    }

    /// Runs detection, policy, sealing and the red-team on the device.
    func startReview(_ raw: String, task: TaskOption, threadID: String? = nil) async {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let state = ReviewState(raw: text, task: task, threadID: threadID, startedAt: Date())
        let reviewID = state.id
        review = state
        section = .ask
        askPath = threadID.map { [.thread($0), .review] } ?? [.review]
        let rawText = RawText(text, source: threadID == nil ? .paste : .followUp)
        _ = try? await services.stores.saveCapture(rawText, thread: threadID)
        let existing = threadID.flatMap { id in threads.first { $0.id == id }?.entities } ?? EntityMap()
        let pipeline = SealPipeline(
            phone: services.engines.phone, patterns: services.patterns, vault: vault, prompts: services.prompts,
            settings: SealSettings(config: services.config, dial: prefs.dial))
        reviewPipeline = pipeline
        reviewLater?.cancel()
        reviewLater = nil
        let staged = await pipeline.runStaged(rawText, existing: existing) { [weak self] p in
            Task { @MainActor in
                guard self?.review?.id == reviewID else { return }
                if case .rulesReady(let preview) = p { self?.review?.found = preview } else { self?.review?.progress = p }
            }
        }
        guard review?.id == reviewID else {
            staged.later?.cancel()
            return
        }
        review?.progress = .done
        review?.result = staged.result
        review?.accepted = staged.result.acceptedRisks
        // The red-team finishes while the user reads the draft (cards in Balanced, rewrites in Strict). Their chip edits are
        // re-applied on top, together with the rewrites Strict applied.
        guard let later = staged.later else { return }
        reviewLater = later
        let full = await later.value
        guard let r = review, r.id == reviewID, r.result != nil else { return }
        let accepted = r.accepted + full.acceptedRisks.filter { x in !r.accepted.contains { $0.id == x.id } }
        let merged = await pipeline.reseal(full, overrides: r.overrides, acceptedRisks: accepted)
        guard review?.id == reviewID else { return }
        review?.result = merged
        review?.accepted = accepted
        reviewLater = nil
    }

    func cancelReview() {
        let threadID = review?.threadID
        reviewLater?.cancel()
        reviewLater = nil
        review = nil
        askPath = threadID.map { [.thread($0)] } ?? []
    }

    /// Chip / switch: send as written ↔ protect. Vault entries get an explicit "reveal this time".
    func toggleEntity(_ id: PlaceholderID) async {
        guard let r = review, let e = r.result?.draft.entities[id], e.category != .secret else { return }
        var overrides = r.overrides
        overrides[id] = e.action == .keep ? UserOverride(action: .placeholder) : UserOverride(action: .keep, revealThisTime: e.vaultEntryID != nil)
        await reseal(overrides: overrides, accepted: r.accepted)
    }

    func acceptRisk(_ risk: Risk) async {
        guard let r = review else { return }
        await reseal(overrides: r.overrides, accepted: r.accepted.filter { $0.id != risk.id } + [risk])
    }

    func dismissRisk(_ risk: Risk) {
        review?.dismissed.insert(risk.id)
    }

    var pendingRisks: [Risk] {
        guard let r = review, let result = r.result else { return [] }
        let accepted = Set(r.accepted.map(\.id))
        return result.risks.filter { !accepted.contains($0.id) && !r.dismissed.contains($0.id) }
    }

    func setReviewTask(_ task: TaskOption) {
        review?.task = task
    }

    private func reseal(overrides: [PlaceholderID: UserOverride], accepted: [Risk]) async {
        guard let r = review, let result = r.result, let pipeline = reviewPipeline else { return }
        let next = await pipeline.reseal(result, overrides: overrides, acceptedRisks: accepted)
        guard review?.id == r.id else { return }
        review?.result = next
        review?.overrides = overrides
        review?.accepted = accepted
        review?.blocked = nil
    }

    /// Whether "Seal & send" would pass the gate right now (for the disabled-with-reason state).
    func gateCheck() -> [GateHit] {
        guard let draft = review?.result?.draft else { return [] }
        do {
            _ = try EgressGate(patterns: services.patterns, vault: vault).seal(draft)
            return []
        } catch {
            return error.hits
        }
    }

    // MARK: Send (the egress gate is the only way out)

    /// Seal & send. Returns false if the gate blocked it.
    @discardableResult
    func send() async -> Bool {
        guard let r = review, let result = r.result, !result.redTeamPending else { return false }
        let draft = result.draft
        let sealed: SealedText
        do {
            sealed = try EgressGate(patterns: services.patterns, vault: vault).seal(draft)
        } catch {
            review?.blocked = error.hits
            blockCount += 1
            return false
        }
        let entities = draft.entities
        let isNew = r.threadID == nil
        let threadID = r.threadID ?? UUID().uuidString
        if isNew {
            threads.insert(
                ChatThread(id: threadID, title: Self.title(from: sealed.value), task: r.task, entities: entities, turns: [], createdAt: Date()), at: 0)
        }
        do { try await services.stores.saveEntities(entities, thread: threadID) } catch { Self.log.error("Entity map save failed") }
        let history = Self.history(of: thread(threadID))
        let stored = StoredSealed(
            text: draft.text, legend: draft.legend, revealedVaultIDs: Array(draft.revealedVaultIDs).sorted(), keptValues: Array(draft.keptValues).sorted())
        updateThread(threadID) { t in
            t.entities = entities
            t.turns.append(.user(UserTurn(raw: r.raw, display: sealed.value, sealed: sealed, stored: stored)))
            t.turns.append(.assistant(AssistantTurn(task: r.task, status: .streaming, segments: [], animate: true)))
        }
        review = nil
        reviewPipeline = nil
        askPath = [.thread(threadID)]
        await stream(threadID: threadID, sealed: sealed, task: r.task, entities: entities, history: history, sealLatency: result.sealDuration)
        if isNew { await nameThread(threadID, sealed: sealed) }
        await persist(threadID)
        return true
    }

    // MARK: Scrub & copy (F-27): Airlock sends nothing

    /// The sealed version for the user to paste into any other tool — through the egress gate exactly
    /// like sending (blocked → the same banner). Opens a `scrub` conversation where an answer can be
    /// pasted back. No receipt: nothing left through Airlock; the copy is the user's own action.
    /// Returns the copied text, or nil if the gate blocked it.
    @discardableResult
    func copySealedVersion() async -> String? {
        guard let r = review, r.threadID == nil, let result = r.result, !result.redTeamPending else { return nil }
        let draft = result.draft
        let sealed: SealedText
        do {
            sealed = try EgressGate(patterns: services.patterns, vault: vault).seal(draft)
        } catch {
            review?.blocked = error.hits
            blockCount += 1
            return nil
        }
        let text = ScrubCopy.clipboardText(sealed)
        Clipboard.copy(text)
        let entities = draft.entities
        let threadID = UUID().uuidString
        let stored = StoredSealed(
            text: draft.text, legend: draft.legend, revealedVaultIDs: Array(draft.revealedVaultIDs).sorted(), keptValues: Array(draft.keptValues).sorted())
        threads.insert(
            ChatThread(
                id: threadID, title: Self.title(from: sealed.value), mode: .scrub, task: r.task, entities: entities,
                turns: [.user(UserTurn(raw: r.raw, display: sealed.value, sealed: sealed, stored: stored))], createdAt: Date()),
            at: 0)
        do { try await services.stores.saveEntities(entities, thread: threadID) } catch { Self.log.error("Entity map save failed") }
        review = nil
        reviewPipeline = nil
        askPath = [.thread(threadID)]
        await nameThread(threadID, sealed: sealed)
        await persist(threadID)
        Self.log.notice("Sealed version copied (\(text.count, privacy: .public) characters); nothing sent")
        return text
    }

    /// Restores an answer the user got elsewhere, on this device, with this conversation's placeholders.
    func restorePasted(_ threadID: String, text: String) async {
        guard let t = thread(threadID) else { return }
        let ctx = RestoreContext(entities: t.entities, userFirstName: userFirstName, writingAsUser: t.task.kind.writesAsUser)
        guard let restored = ScrubCopy.restorePasted(text, context: ctx) else { return }
        updateThread(threadID) {
            $0.turns.append(.assistant(AssistantTurn(task: t.task, status: .done, segments: restored.segments, animate: true, pasted: text)))
        }
        await persist(threadID)
    }

    // MARK: What could Gemini still guess? (F-25)

    /// The newest sealed turn that already went to Gemini (its answer has a receipt), so asking
    /// sends nothing Gemini hasn't seen. nil for scrub conversations and on-device-only answers.
    func guessableSealed(in thread: ChatThread) -> SealedText? {
        guard thread.mode == nil, !thread.isStreaming, prefs.preference != .phoneOnly else { return nil }
        var answered = false
        for turn in thread.turns.reversed() {
            switch turn {
            case .assistant(let a): answered = a.summary?.receipt != nil
            case .user(let u):
                if answered, let s = u.sealed { return s }
                answered = false
            }
        }
        return nil
    }

    /// The guess card's state for a conversation (nil = not asked since its last turn).
    func guess(for thread: ChatThread) -> GuessState? {
        guard let g = guesses[thread.id], g.turnCount == thread.turns.count else { return nil }
        return g
    }

    /// Asks Gemini (cloudOnly) what it can infer from the exact sealed text it already saw. Writes a receipt.
    func inferGuesses(_ threadID: String) async {
        guard let t = thread(threadID), let sealed = guessableSealed(in: t) else { return }
        if case .asking? = guess(for: t)?.phase { return }
        let count = t.turns.count
        guesses[threadID] = GuessState(turnCount: count, phase: .asking)
        let phase: GuessState.Phase
        do {
            let r = try await CloudInference.run(
                engines: services.engines, prompts: services.prompts, ledger: ledger, sealed: sealed, threadId: threadID,
                armorExpected: services.config.bool("armor_expected"))
            phase = .done(inferences: r.inferences, unreadable: r.unreadable, receiptID: r.receipt.id)
            Self.log.notice("Inference answered: \(r.inferences.count, privacy: .public) items")
        } catch {
            let failure = AnswerFailure(error)
            Self.log.notice("Inference failed: \(failure.rawValue, privacy: .public)")
            phase = .failed(failure)
        }
        guesses[threadID] = GuessState(turnCount: count, phase: phase)
        receipts = await ledger.receipts
        do { try await services.conversations.saveReceipts(receipts) } catch { Self.log.error("Receipt save failed") }
        await refreshStats()
    }

    private var userFirstName: String? {
        vault.first(where: \.isUser).flatMap { $0.canonical.split(whereSeparator: \.isWhitespace).first.map(String.init) }
    }

    /// Re-asks the last sealed question (after an error), optionally on this device only.
    func retry(_ threadID: String, onDeviceOnly: Bool = false) async {
        guard let t = thread(threadID), case .assistant(let last)? = t.turns.last, last.status == .error else { return }
        let before = Array(t.turns.dropLast())
        guard case .user(let user)? = before.last, let sealed = user.sealed else { return }
        let history = Self.history(of: ChatThread(id: t.id, title: t.title, task: t.task, entities: t.entities, turns: Array(before.dropLast()), createdAt: t.createdAt))
        updateThread(threadID) { th in
            th.turns[th.turns.count - 1] = .assistant(AssistantTurn(task: last.task, status: .streaming, segments: [], animate: true))
        }
        await stream(
            threadID: threadID, sealed: sealed, task: last.task, entities: t.entities, history: history, sealLatency: .zero,
            preference: onDeviceOnly ? .phoneOnly : nil)
        await persist(threadID)
    }

    private func stream(
        threadID: String, sealed: SealedText, task: TaskOption, entities: EntityMap, history: SealedHistory, sealLatency: Duration,
        preference: AnswerPreference? = nil
    ) async {
        let firstName = vault.first(where: \.isUser).flatMap { $0.canonical.split(whereSeparator: \.isWhitespace).first.map(String.init) }
        let events = answers.answer(
            sealed, task: task.kind, history: history.turns.isEmpty ? nil : history, restore: RestoreContext(entities: entities, userFirstName: firstName),
            preference: preference ?? prefs.preference, threadId: threadID, sealLatency: sealLatency)
        do {
            for try await event in events {
                switch event {
                case .started: break
                case .partial(_, let segments): updateLastAnswer(threadID) { $0.segments = segments }
                case .finished(let outcome):
                    updateLastAnswer(threadID) {
                        $0.status = .done
                        $0.segments = outcome.restored.segments
                        $0.summary = AnswerSummary(outcome)
                    }
                }
            }
        } catch {
            let failure = AnswerFailure(error)
            Self.log.notice("Answer failed: \(failure.rawValue, privacy: .public)")
            updateLastAnswer(threadID) {
                $0.status = .error
                $0.failure = failure
            }
        }
        receipts = await ledger.receipts
        do { try await services.conversations.saveReceipts(receipts) } catch { Self.log.error("Receipt save failed") }
        await refreshStats()
    }

    /// On-device title from the *sealed* first message (`title.v1`), so a title can't contain a real name.
    private func nameThread(_ id: String, sealed: SealedText) async {
        guard availability == .available,
            let title = await ThreadTitler(phone: services.engines.phone, prompts: services.prompts).title(for: sealed)
        else { return }
        updateThread(id) { $0.title = title }
    }

    private func updateThread(_ id: String, _ change: (inout ChatThread) -> Void) {
        guard let i = threads.firstIndex(where: { $0.id == id }) else { return }
        change(&threads[i])
    }

    private func updateLastAnswer(_ id: String, _ change: (inout AssistantTurn) -> Void) {
        updateThread(id) { t in
            guard case .assistant(var a)? = t.turns.last else { return }
            change(&a)
            t.turns[t.turns.count - 1] = .assistant(a)
        }
    }

    // MARK: Saved conversations (encrypted, local only)

    private func persist(_ id: String) async {
        guard let t = thread(id) else { return }
        let turns: [StoredTurn] = t.turns.compactMap { turn in
            switch turn {
            case .user(let u): return .user(raw: u.raw, sealed: u.stored)
            case .assistant(let a):
                guard a.status != .streaming else { return nil }
                let s = a.summary
                return .assistant(
                    task: a.task, status: a.status, modelText: s?.modelText ?? a.pasted ?? "", failure: a.failure,
                    outcome: s.map {
                        StoredOutcome(
                            route: $0.route, modelVersion: $0.modelVersion, ranOnDevice: $0.ranOnDevice, fellBackToPhone: $0.fellBackToPhone,
                            latencyMs: $0.latencyMs, receiptID: $0.receipt?.id, local: a.local ? true : nil)
                    })
            }
        }
        let record = StoredThread(id: t.id, title: t.title, mode: t.mode, task: t.task, createdAt: t.createdAt, updatedAt: Date(), turns: turns)
        do { try await services.conversations.save(record) } catch { Self.log.error("Conversation save failed") }
    }

    /// Rebuilds saved conversations. Sealed turns are never trusted from storage: each goes back
    /// through `EgressGate.seal` (INV-2). A turn that no longer passes (e.g. the Vault changed) is
    /// still shown, but it and its answer are left out of follow-up history.
    private func loadThreads() async -> [ChatThread] {
        let gate = EgressGate(patterns: services.patterns, vault: vault)
        let firstName = vault.first(where: \.isUser).flatMap { $0.canonical.split(whereSeparator: \.isWhitespace).first.map(String.init) }
        var out: [ChatThread] = []
        for rec in await services.conversations.threads() {
            let entities = (try? await services.stores.loadEntities(thread: rec.id)) ?? EntityMap()
            var turns: [Turn] = []
            for st in rec.turns {
                switch st {
                case .user(let raw, let s) where s.local == true:
                    // Answered on the device: there is no sealed version to re-check, and none is ever made from this turn.
                    turns.append(.user(UserTurn(raw: raw, display: "", sealed: nil, stored: s, local: true)))
                case .user(let raw, let s):
                    let draft = SealDraft(
                        storedText: s.text, legend: s.legend, entities: entities, revealedVaultIDs: Set(s.revealedVaultIDs), keptValues: Set(s.keptValues))
                    let sealed = try? gate.seal(draft)
                    turns.append(.user(UserTurn(raw: raw, display: s.text, sealed: sealed, stored: s)))
                case .assistant(let task, let status, let modelText, let failure, let outcome) where outcome?.local == true:
                    // Written on the device from the raw message: shown as it is, never "restored" with another conversation's details.
                    let summary = outcome.map { AnswerSummary(stored: $0, modelText: modelText, receipt: nil, fidelity: .clean) }
                    turns.append(
                        .assistant(
                            AssistantTurn(
                                task: task, status: status, segments: [.text(modelText)], summary: summary, failure: failure, animate: false,
                                local: true)))
                case .assistant(let task, let status, let modelText, let failure, let outcome):
                    let ctx = RestoreContext(entities: entities, userFirstName: firstName, writingAsUser: task.kind.writesAsUser)
                    let restored = Restorer.restore(modelText, context: ctx)
                    let summary = outcome.map { o in
                        AnswerSummary(
                            stored: o, modelText: modelText, receipt: receipts.first { $0.id == o.receiptID },
                            fidelity: FidelityCheck.check(modelOutput: modelText, context: ctx))
                    }
                    // No outcome but text: an answer the user pasted back (F-27).
                    let pasted = outcome == nil && status == .done && !modelText.isEmpty ? modelText : nil
                    turns.append(
                        .assistant(
                            AssistantTurn(
                                task: task, status: status, segments: restored.segments, summary: summary, failure: failure, animate: false, pasted: pasted)))
                }
            }
            out.append(ChatThread(id: rec.id, title: rec.title, mode: rec.mode, task: rec.task, entities: entities, turns: turns, createdAt: rec.createdAt))
        }
        return out
    }

    /// Deletes a conversation, its entity map and captures. Its receipts stay: the chain must stay verifiable.
    func deleteThread(_ id: String) async {
        do {
            try await services.stores.deleteThread(id)
            try await services.conversations.deleteThread(id)
        } catch {
            Self.log.error("Conversation delete failed")
        }
        threads.removeAll { $0.id == id }
        guesses[id] = nil
        if askPath.contains(.thread(id)) { askPath = [] }
    }

    // MARK: Ledger

    func verifyChain() async {
        chain = await ledger.verify()
        chainRun += 1
    }

    func refreshStats() async {
        stats = await ledger.stats(since: Date().addingTimeInterval(-7 * 86_400))
    }

    // MARK: Delete everything

    /// Removes the Vault, conversations, receipts and captures, then destroys the encryption key.
    func deleteEverything() async {
        // Conversations first: they share the key that `AirlockStores.deleteEverything()` destroys.
        do { try await services.conversations.deleteAll() } catch { Self.log.error("Conversation wipe failed") }
        do { try await services.stores.deleteEverything() } catch { Self.log.error("Store wipe failed") }
        defaults.removeObject(forKey: prefsKey)
        ledger = ReceiptLedger()
        answers = AnswerService(
            engines: services.engines, prompts: services.prompts, ledger: ledger, armorExpected: services.config.bool("armor_expected"))
        vault = []
        threads = []
        receipts = []
        review = nil
        chain = nil
        guesses = [:]
        focusedReceiptID = nil
        prefs = Prefs(dial: services.config.dialDefault)
        askPath = []
        section = .ask
        await refreshStats()
    }

    // MARK: Helpers

    /// First few words of the sealed text, placeholders turned into plain nouns (fallback title).
    static func title(from sealed: String) -> String {
        let nouns = [
            "PERSON": "someone", "ORG": "an organisation", "LOC": "a place", "CONTACT": "a contact", "ID": "an ID", "DATE": "a date",
            "HEALTH": "a health detail", "SECRET": "a code",
        ]
        var s = sealed.replacingOccurrences(of: "[[PERSON_ME]]", with: "me")
        if let re = try? NSRegularExpression(pattern: #"\[\[([A-Z]+)_\d+\]\]"#) {
            let ns = s as NSString
            var out = ""
            var cursor = 0
            for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                out += ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))
                out += nouns[ns.substring(with: m.range(at: 1))] ?? "something"
                cursor = m.range.location + m.range.length
            }
            s = out + ns.substring(from: cursor)
        }
        let words = s.components(separatedBy: CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "'")).inverted).filter { !$0.isEmpty }
        var head = Array(words.prefix(7))
        let weak: Set<String> = ["a", "an", "the", "at", "to", "of", "and", "or", "in", "on", "for", "with", "my", "your"]
        while head.count > 1, let last = head.last, weak.contains(last.lowercased()) { head.removeLast() }
        let t = head.joined(separator: " ")
        return t.isEmpty ? String(localized: "Sealed request") : t.prefix(1).uppercased() + t.dropFirst()
    }

    /// Sealed history for a follow-up: re-gated user turns and the model's own placeholder text.
    static func history(of thread: ChatThread?) -> SealedHistory {
        var turns: [SealedHistory.Turn] = []
        var skipAnswer = false
        for t in thread?.turns ?? [] {
            switch t {
            case .user(let u):
                skipAnswer = u.sealed == nil
                if let s = u.sealed { turns.append(.user(s)) }
            case .assistant(let a):
                if let s = a.summary, !skipAnswer { turns.append(.assistant(modelText: s.modelText)) }
            }
        }
        return SealedHistory(turns: turns)
    }

    // MARK: Demo script (screenshots; demo mode only)

    static let sample =
        "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I've texted you four times. I work nights at Mercy General Hospital and need to sleep during the day — please send someone this week. You can reach me on 312-555-0147. Thanks, Maya Chen"

    /// A fictional answer "from another tool", for the Scrub & copy demo.
    static let samplePasted =
        "Hi [[PERSON_1]], the heater at [[LOC_1]] is still broken. Please send someone to repair it this week.\n\nThanks,\n[[PERSON_ME]]"

    private func runDemoScript() async {
        guard let script = services.demoScript else { return }
        if script.seed {
            if vault.isEmpty {
                await saveVault([
                    VaultEntry(id: UUID().uuidString, canonical: "Maya Chen", aliases: ["Maya"], category: .person, roleHint: "me", isUser: true),
                    VaultEntry(id: UUID().uuidString, canonical: "Raj Patel", aliases: ["Raj"], category: .person, roleHint: "my landlord"),
                ])
            }
            setPrefs { $0.onboarded = true }
        }
        switch script.screen {
        case "onboarding": setPrefs { $0.onboarded = false }
        case "review": await startReview(Self.sample, task: .reply)
        case "thread":
            await startReview(Self.sample, task: .reply)
            await send()
        case "ledger":
            // Two sealed requests to Gemini (two chained receipts) and one quick task answered on device.
            await startReview(Self.sample, task: .reply)
            await send()
            await startReview("Raj says he can only come next Tuesday. Is that reasonable?", task: .help, threadID: threads.first?.id)
            await send()
            await startReview(Self.sample, task: .summary)
            await send()
            go(.ledger)
            await verifyChain()
        case "guess":
            // F-25: a sent request, then "What could Gemini still guess?" asked once.
            await startReview(Self.sample, task: .reply)
            await send()
            if let id = threads.first?.id { await inferGuesses(id) }
        case "copy":
            // F-27: Review with "Copy sealed version" (the screenshot shows the button).
            revealReviewActions = true
            await startReview(Self.sample, task: .reply)
        case "copied":
            // F-27: just copied: the conversation waits for a pasted answer.
            await startReview(Self.sample, task: .reply)
            await copySealedVersion()
        case "scrub":
            // F-27: copied, then an answer from elsewhere pasted back and restored.
            await startReview(Self.sample, task: .reply)
            await copySealedVersion()
            if let id = threads.first?.id { await restorePasted(id, text: Self.samplePasted) }
        case "about":
            go(.settings)
            showAbout = true
        case "vault": go(.vault)
        case "settings": go(.settings)
        case "evidence":
            go(.settings)
            showEvidence = true
        default: break
        }
    }
}
