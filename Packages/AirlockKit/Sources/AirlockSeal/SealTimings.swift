import AirlockCore
import Foundation

/// Where a seal's time went (FX-02). Numbers only — never content or prompts (INV-8). Shown in Review's
/// "Timing" disclosure; not part of the hashed receipt.
public struct SealTimings: Sendable, Hashable {
    /// Vault + pattern (+ NL tagger) detection.
    public var rules: Duration = .zero
    public var detect: Duration = .zero
    /// `detect.*` calls (one per chunk, more when a chunk is halved).
    public var detectCalls = 0
    /// `detect-repair.*` calls (broken JSON).
    public var repairCalls = 0
    public var generalise: Duration = .zero
    public var generaliseCalls = 0
    public var redTeam: Duration = .zero
    public var redTeamCalls = 0
    /// From the start of the seal to the first on-device reply; nil when no model call ran.
    public var firstModelOutput: Duration?
    /// The whole seal, up to the draft Review shows.
    public var total: Duration = .zero

    public init() {}
}

/// Wraps the phone-only engine for one seal and counts calls by prompt-id family (`detect`, `detect-repair`, …).
/// It only forwards, so it is still a `PhoneOnlyEngine` (INV-3).
actor CallMeter: PhoneOnlyEngine {
    private let inner: any PhoneOnlyEngine
    private let clock = ContinuousClock()
    private let start: ContinuousClock.Instant
    private var counts: [String: Int] = [:]
    private var total = 0
    private(set) var firstModelOutput: Duration?

    init(_ inner: any PhoneOnlyEngine, start: ContinuousClock.Instant) {
        self.inner = inner
        self.start = start
    }

    func availability() async -> PhoneAvailability {
        await inner.availability()
    }

    func respond(_ prompt: PhonePrompt, options: PhoneOptions) async throws(EngineError) -> EngineResult {
        let family = prompt.promptID.replacing(/\.v\d+$/, with: "")
        counts[family, default: 0] += 1
        total += 1
        defer { if firstModelOutput == nil { firstModelOutput = clock.now - start } }
        return try await inner.respond(prompt, options: options)
    }

    func calls(_ family: String? = nil) -> Int {
        guard let family else { return total }
        return counts[family] ?? 0
    }
}
