/// A tamper-evident record of one thing that left the device (`docs/03-PRIVACY-ENGINE.md` §12).
///
/// Guarantees: contains only counts, hashes and metadata, never raw or restored
/// text (INV-7). `outboundText` (sealed, local only) is excluded from the hash so
/// a Firestore copy without it still verifies. The hash rule is
/// `hash = SHA256(prevHash || canonicalJSON(receipt without hash, without outboundText))`,
/// implemented in `AirlockLedger` and pinned by `spec/fixtures/hashchain.json`.
public struct Receipt: Sendable, Hashable, Codable, Identifiable {
    public enum ArmorStatus: String, Sendable, Codable, Hashable {
        case pass, blocked, notConfigured, unknown
    }

    public struct Gate: Sendable, Hashable, Codable {
        public let passed: Bool
        public let checks: [String]
        public init(passed: Bool, checks: [String]) {
            self.passed = passed
            self.checks = checks
        }
    }

    public let id: String
    public let seq: Int
    /// ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z` (string, so hashing is platform-independent).
    public let createdAt: String
    public let threadId: String
    public let route: Route
    public let modelVersion: String
    public let outboundSha256: String
    public let outboundChars: Int
    public let counts: [String: Int]
    public let gate: Gate
    public let armor: ArmorStatus
    public let latencyMs: [String: Int]
    public let prevHash: String
    public var hash: String
    /// The exact sealed text that left (local only; synced only if the user opts in).
    public var outboundText: String?

    public init(
        id: String, seq: Int, createdAt: String, threadId: String, route: Route, modelVersion: String,
        outboundSha256: String, outboundChars: Int, counts: [String: Int], gate: Gate,
        armor: ArmorStatus, latencyMs: [String: Int], prevHash: String, hash: String = "",
        outboundText: String? = nil
    ) {
        self.id = id
        self.seq = seq
        self.createdAt = createdAt
        self.threadId = threadId
        self.route = route
        self.modelVersion = modelVersion
        self.outboundSha256 = outboundSha256
        self.outboundChars = outboundChars
        self.counts = counts
        self.gate = gate
        self.armor = armor
        self.latencyMs = latencyMs
        self.prevHash = prevHash
        self.hash = hash
        self.outboundText = outboundText
    }
}
