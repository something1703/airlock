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

/// FX-02: what the Vault and the rules found, before any model call — shown at once on the sealing screen
/// (local only; it holds raw text and never leaves the device).
public struct RulesPreview: Sendable, Hashable {
    public struct Span: Sendable, Hashable {
        public let span: TextSpan
        public let category: PrivacyCategory
    }

    /// The normalised text the spans point into (UTF-16 offsets).
    public let text: String
    /// Non-overlapping, in order; the longest wins where two overlap.
    public let spans: [Span]
    /// Distinct details (same text, any case, counted once).
    public let count: Int

    public init(text: String, candidates: [Candidate]) {
        let sorted = candidates.sorted {
            $0.span.start != $1.span.start ? $0.span.start < $1.span.start : ($0.span.end - $0.span.start) > ($1.span.end - $1.span.start)
        }
        var spans: [Span] = []
        for c in sorted {
            if let last = spans.last, c.span.start < last.span.end {
                if c.span.end - c.span.start > last.span.end - last.span.start { spans[spans.count - 1] = Span(span: c.span, category: c.category) }
                continue
            }
            spans.append(Span(span: c.span, category: c.category))
        }
        let ns = text as NSString
        self.text = text
        self.spans = spans
        self.count = Set(spans.map { ns.substring(with: NSRange(location: $0.span.start, length: $0.span.end - $0.span.start)).lowercased() }).count
    }
}
