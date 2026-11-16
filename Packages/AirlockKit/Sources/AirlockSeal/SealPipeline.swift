import AirlockCore
import AirlockDetect
import AirlockPrompts
import Foundation

/// Settings for one seal run (from `AppConfig` + Settings).
public struct SealSettings: Sendable, Hashable {
    public var dial: DialPreset
    public var policy: PolicySettings
    public var nlTaggerEnabled: Bool
    public var chunkTokens: Int
    /// Max on-device `gen.v1` rewrites per run (latency budget).
    public var maxRewrites: Int
    /// What the user wants help with, for `gen.v1` ("keep what matters for this task").
    public var taskSummary: String
    public var today: Date
    /// Remote Config `redteam_enabled` / `redteam_rounds`.
    public var redTeamEnabled: Bool
    public var redTeamRounds: Int

    public init(
        dial: DialPreset = .balanced, policy: PolicySettings = PolicySettings(), nlTaggerEnabled: Bool = true,
        chunkTokens: Int = 1_400, maxRewrites: Int = 6, taskSummary: String = "getting help with this message", today: Date = Date(),
        redTeamEnabled: Bool = true, redTeamRounds: Int = 2
    ) {
        self.redTeamEnabled = redTeamEnabled
        self.redTeamRounds = redTeamRounds
        self.dial = dial
        self.policy = policy
        self.nlTaggerEnabled = nlTaggerEnabled
        self.chunkTokens = chunkTokens
        self.maxRewrites = maxRewrites
        self.taskSummary = taskSummary
        self.today = today
    }

    public init(
        config: AppConfig, dial: DialPreset? = nil, policy: PolicySettings = PolicySettings(),
        taskSummary: String = "getting help with this message"
    ) {
        self.init(
            dial: dial ?? config.dialDefault, policy: policy, nlTaggerEnabled: config.nlTaggerEnabled,
            chunkTokens: config.detectChunkTokens,
            taskSummary: taskSummary, redTeamEnabled: config.redTeamEnabled, redTeamRounds: config.redTeamRounds)
    }
}

/// Why the user must (or should) look at the Review screen.
public enum ReviewReason: Sendable, Hashable {
    /// Apple's model is unavailable — rules only (INV-9). Always forces review.
    case phoneUnavailable(PhoneAvailability)
    /// Sections the model couldn't read (UI highlights them).
    case llmFailed(chunks: [Int])
    /// Sections Apple's guardrails declined (UI: "please review that section yourself").
    case refused(chunks: [Int])
    case lowConfidence
    case ambiguous
    case secretsFound
    /// Red-team found things a reader could still guess, not yet resolved (Risk cards).
    case risks(count: Int)
    /// The on-device red-team check couldn't run — review everything ("red-team unavailable").
    case redTeamUnavailable
}

/// Progress for the inline "Reading on your iPhone · section 2 of 3" line.
public enum SealProgress: Sendable, Hashable {
    case detecting(section: Int, of: Int)
    case generalising
    /// "Checking what someone could still guess…"
    case checkingRisks
    case done
}

/// Everything Review needs.
public struct SealResult: Sendable {
    public let normalised: NormalisedText
    public let merge: MergeResult
    public let draft: SealDraft
    public let reasons: [ReviewReason]
    /// True when the Review screen must be shown before anything can be sent.
    public let requiresReview: Bool
    public let detection: LLMDetectionReport
    public let rewrites: [PlaceholderID: String]
    public let sealDuration: Duration
    /// Every risk the red-team raised (Risk cards).
    public let risks: [Risk]
    /// Risks whose suggestion is in the draft (auto-applied in Strict, or accepted in Review).
    public let acceptedRisks: [Risk]
    public let redTeamUnavailable: Bool

    /// Risks still shown as pending cards.
    public var pendingRisks: [Risk] {
        let accepted = Set(acceptedRisks.map(\.id))
        return risks.filter { !accepted.contains($0.id) }
    }
}

/// Stages 1–6: raw text → sealed draft, entirely on device (`docs/03-PRIVACY-ENGINE.md` §1).
///
/// Guarantees:
/// - Holds **only a `PhoneOnlyEngine`** — there is no cloud engine to call, by construction (INV-1, INV-3).
/// - INV-9: if Apple's model is unavailable or fails, detection falls back to Vault + patterns
///   (+ NL tagger) and `requiresReview` is true. It never falls back to the cloud.
/// - The draft still has to pass `EgressGate.seal` before anything can leave.
public actor SealPipeline {
    private let phone: any PhoneOnlyEngine
    private let patterns: PatternDetector
    private let vault: [VaultEntry]
    private let prompts: PromptLibrary
    private let settings: SealSettings

    public init(phone: any PhoneOnlyEngine, patterns: PatternDetector, vault: [VaultEntry], prompts: PromptLibrary, settings: SealSettings)
    {
        self.phone = phone
        self.patterns = patterns
        self.vault = vault
        self.prompts = prompts
        self.settings = settings
    }

    public func run(
        _ raw: RawText, existing: EntityMap = EntityMap(), overrides: [PlaceholderID: UserOverride] = [:],
        progress: @escaping @Sendable (SealProgress) -> Void = { _ in }
    ) async -> SealResult {
        let clock = ContinuousClock()
        let start = clock.now
        let normalised = Normaliser.normalise(String(raw.value.prefix(Normaliser.maxInputUTF16)))
        let text = normalised.text

        // D1–D3 (deterministic), then D4 on device.
        var candidates = VaultMatcher(entries: vault).detect(in: text) + patterns.detect(in: text)
        if settings.nlTaggerEnabled { candidates += NLDetector.detect(in: text) }
        let detector = LLMDetector(engine: phone, prompts: prompts, budgetTokens: settings.chunkTokens)
        let report = await detector.detect(in: text) { section, total in progress(.detecting(section: section, of: total)) }
        candidates += report.candidates

        let merge = Merger.merge(candidates, in: text, existing: existing, vault: vault)
        let policy = PolicyEngine(dial: settings.dial, settings: settings.policy)

        // On-device rewrites for generalised entities (validated by the Sealer; ladder default otherwise).
        var rewrites: [PlaceholderID: String] = [:]
        if report.unavailable == nil {
            let targets = Set(merge.mentions.map(\.entityID)).compactMap { merge.entities[$0] }
                .filter { if case .generalise = policy.action(for: $0, override: overrides[$0.id]) { true } else { false } }
                .sorted { $0.id < $1.id }
                .prefix(settings.maxRewrites)
            if !targets.isEmpty { progress(.generalising) }
            for e in targets {
                guard case .generalise(let level) = policy.action(for: e, override: overrides[e.id]),
                    let mention = merge.mentions.first(where: { $0.entityID == e.id })
                else { continue }
                if let r = await rewrite(e, mention: mention, level: level, in: text) { rewrites[e.id] = r }
            }
        }

        var draft = Sealer(policy: policy, patterns: patterns, today: settings.today).draft(
            normalised, merge: merge, overrides: overrides, rewrites: rewrites)

        // Stage 7 — red-team (phone-only). Strict auto-applies; Balanced returns Risk cards.
        var risks: [Risk] = []
        var accepted: [Risk] = []
        var redTeamUnavailable = false
        if settings.redTeamEnabled, policy.redTeamMode != .off {
            if report.unavailable == nil {
                progress(.checkingRisks)
                let rt = await RedTeam(phone: phone, prompts: prompts, patterns: patterns)
                    .run(draft, mode: policy.redTeamMode, maxRounds: settings.redTeamRounds, taskSummary: settings.taskSummary)
                risks = rt.risks
                accepted = rt.applied
                draft = rt.draft
                redTeamUnavailable = rt.unavailable
            } else {
                redTeamUnavailable = true
            }
        }

        var result = SealResult(
            normalised: normalised, merge: merge, draft: draft, reasons: [], requiresReview: false, detection: report, rewrites: rewrites,
            sealDuration: clock.now - start, risks: risks, acceptedRisks: accepted, redTeamUnavailable: redTeamUnavailable)
        result = Self.finalised(result, mode: policy.reviewMode)
        progress(.done)
        return result
    }

    static func finalised(_ r: SealResult, mode: ReviewMode) -> SealResult {
        var reasons = reasons(report: r.detection, merge: r.merge, draft: r.draft)
        if !r.pendingRisks.isEmpty { reasons.append(.risks(count: r.pendingRisks.count)) }
        if r.redTeamUnavailable && r.detection.unavailable == nil { reasons.append(.redTeamUnavailable) }
        return SealResult(
            normalised: r.normalised, merge: r.merge, draft: r.draft, reasons: reasons, requiresReview: requiresReview(reasons, mode: mode),
            detection: r.detection, rewrites: r.rewrites, sealDuration: r.sealDuration, risks: r.risks, acceptedRisks: r.acceptedRisks,
            redTeamUnavailable: r.redTeamUnavailable)
    }

    /// Re-applies Review edits without calling the model again (chip toggles and "Use suggestion"
    /// are instant). Accepted red-team suggestions are re-applied on top of the new draft.
    public func reseal(_ result: SealResult, overrides: [PlaceholderID: UserOverride], acceptedRisks: [Risk]? = nil) -> SealResult {
        let policy = PolicyEngine(dial: settings.dial, settings: settings.policy)
        let accepted = acceptedRisks ?? result.acceptedRisks
        let base = Sealer(policy: policy, patterns: patterns, today: settings.today)
            .draft(result.normalised, merge: result.merge, overrides: overrides, rewrites: result.rewrites)
        let draft = RedTeam.apply(accepted, to: base)
        return Self.finalised(
            SealResult(
                normalised: result.normalised, merge: result.merge, draft: draft, reasons: [], requiresReview: false,
                detection: result.detection, rewrites: result.rewrites, sealDuration: result.sealDuration, risks: result.risks,
                acceptedRisks: accepted, redTeamUnavailable: result.redTeamUnavailable),
            mode: policy.reviewMode)
    }

    // MARK: - Internals

    private func rewrite(_ e: Entity, mention: Mention, level: Int, in text: String) async -> String? {
        let ns = text as NSString
        let from = max(0, mention.span.start - 120)
        let to = min(ns.length, mention.span.end + 120)
        let sentence = ns.substring(with: NSRange(location: from, length: to - from))
        let hint =
            switch level {
            case 1: "slightly less specific"
            case 2: "a general kind, no name (e.g. \"a large hospital\")"
            default: "very general (e.g. \"a healthcare employer\")"
            }
        guard
            let promptText = try? prompts.render(
                "gen.v1",
                [
                    "task_summary": settings.taskSummary, "sentence": sentence, "phrase": mention.text, "type": e.category.rawValue,
                    "level_hint": hint,
                ])
        else { return nil }
        guard let output = try? await phone.respond(PhonePrompt(promptID: "gen.v1", text: promptText), options: .analysis).text,
            let json = LLMDetector.firstJSONObject(in: output), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let r = obj["rewrite"] as? String
        else { return nil }
        return r.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func reasons(report: LLMDetectionReport, merge: MergeResult, draft: SealDraft) -> [ReviewReason] {
        var reasons: [ReviewReason] = []
        if let a = report.unavailable { reasons.append(.phoneUnavailable(a)) }
        if !report.failedChunks.isEmpty { reasons.append(.llmFailed(chunks: report.failedChunks)) }
        if !report.refusedChunks.isEmpty { reasons.append(.refused(chunks: report.refusedChunks)) }
        let present = Set(merge.mentions.map(\.entityID))
        let lowConfidenceSealed = present.contains { id in
            guard let e = draft.entities[id] else { return false }
            return e.action != .keep && e.confidence < .high
        }
        if lowConfidenceSealed { reasons.append(.lowConfidence) }
        if !merge.ambiguous.isEmpty { reasons.append(.ambiguous) }
        if !draft.secretWarnings.isEmpty { reasons.append(.secretsFound) }
        return reasons
    }

    static func requiresReview(_ reasons: [ReviewReason], mode: ReviewMode) -> Bool {
        let forced = reasons.contains {
            switch $0 {
            case .phoneUnavailable, .llmFailed, .refused, .secretsFound, .ambiguous, .risks, .redTeamUnavailable: true
            case .lowConfidence: false
            }
        }
        switch mode {
        case .always: return true
        case .ifLowConfidenceOrRisk: return forced || reasons.contains(.lowConfidence)
        case .onlyIfRisk: return forced
        }
    }
}
