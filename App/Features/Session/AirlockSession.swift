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

    @ObservationIgnored private var ledger = ReceiptLedger()
    @ObservationIgnored private var answers: AnswerService
    @ObservationIgnored private var reviewPipeline: SealPipeline?
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

    func openThread(_ id: String) {
        section = .ask
        askPath = [.thread(id)]
    }

    func thread(_ id: String) -> ChatThread? { threads.first { $0.id == id } }

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
        let result = await pipeline.run(rawText, existing: existing) { [weak self] p in
            Task { @MainActor in
                if self?.review?.id == reviewID { self?.review?.progress = p }
            }
        }
        guard review?.id == reviewID else { return }
        review?.progress = .done
        review?.result = result
        review?.accepted = result.acceptedRisks
    }

    func cancelReview() {
        let threadID = review?.threadID
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
        guard let r = review, let result = r.result else { return false }
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
                    task: a.task, status: a.status, modelText: s?.modelText ?? "", failure: a.failure,
                    outcome: s.map {
                        StoredOutcome(
                            route: $0.route, modelVersion: $0.modelVersion, ranOnDevice: $0.ranOnDevice, fellBackToPhone: $0.fellBackToPhone,
                            latencyMs: $0.latencyMs, receiptID: $0.receipt?.id)
                    })
            }
        }
        let record = StoredThread(id: t.id, title: t.title, task: t.task, createdAt: t.createdAt, updatedAt: Date(), turns: turns)
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
                case .user(let raw, let s):
                    let draft = SealDraft(
                        storedText: s.text, legend: s.legend, entities: entities, revealedVaultIDs: Set(s.revealedVaultIDs), keptValues: Set(s.keptValues))
                    let sealed = try? gate.seal(draft)
                    turns.append(.user(UserTurn(raw: raw, display: s.text, sealed: sealed, stored: s)))
                case .assistant(let task, let status, let modelText, let failure, let outcome):
                    let ctx = RestoreContext(entities: entities, userFirstName: firstName, writingAsUser: task.kind.writesAsUser)
                    let restored = Restorer.restore(modelText, context: ctx)
                    let summary = outcome.map { o in
                        AnswerSummary(
                            stored: o, modelText: modelText, receipt: receipts.first { $0.id == o.receiptID },
                            fidelity: FidelityCheck.check(modelOutput: modelText, context: ctx))
                    }
                    turns.append(
                        .assistant(AssistantTurn(task: task, status: status, segments: restored.segments, summary: summary, failure: failure, animate: false)))
                }
            }
            out.append(ChatThread(id: rec.id, title: rec.title, task: rec.task, entities: entities, turns: turns, createdAt: rec.createdAt))
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
        case "thread", "ledger":
            await startReview(Self.sample, task: .reply)
            await send()
            if script.screen == "ledger" {
                go(.ledger)
                await verifyChain()
            }
        case "vault": go(.vault)
        case "settings": go(.settings)
        default: break
        }
    }
}
