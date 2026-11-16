/// Which layer produced a detection.
///
/// Guarantees: `priority` encodes the merge rule `vault > pattern > llm > nl`
/// (`docs/03-PRIVACY-ENGINE.md` §6.1); `redteam` and `user` are added later in
/// the pipeline and outrank automatic detectors.
public enum DetectorID: String, Sendable, Codable, Hashable, CaseIterable {
    case user, vault, pattern, llm, nl, redteam

    public var priority: Int {
        switch self {
        case .user: 0
        case .vault: 1
        case .pattern: 2
        case .llm: 3
        case .nl: 4
        case .redteam: 5
        }
    }
}

/// How sure a detector is.
public enum Confidence: String, Sendable, Codable, Hashable, Comparable {
    case low, medium, high

    private var rank: Int {
        switch self {
        case .low: 0
        case .medium: 1
        case .high: 2
        }
    }

    public static func < (lhs: Confidence, rhs: Confidence) -> Bool { lhs.rank < rhs.rank }
}

/// One raw detection before merging.
///
/// Guarantees: `span` indexes the **normalised** text the detector ran on, and
/// `text` is exactly the UTF-16 substring at `span` (detectors are required to
/// enforce this; LLM spans that fail it are dropped).
public struct Candidate: Sendable, Hashable, Codable {
    public let span: TextSpan
    public let text: String
    public let category: PrivacyCategory
    /// Finer label, e.g. `email`, `card`, `iban`, `dob`, `otp`, `address`.
    public let subtype: String?
    public let detector: DetectorID
    public let confidence: Confidence
    /// Who/what this is to the writer, without naming anyone ("the writer's landlord").
    public let roleHint: String?
    /// LLM coreference hint: an earlier mention this one refers to.
    public let sameAs: String?
    /// Vault entry id when `detector == .vault`.
    public let vaultEntryID: String?

    public init(
        span: TextSpan,
        text: String,
        category: PrivacyCategory,
        subtype: String? = nil,
        detector: DetectorID,
        confidence: Confidence,
        roleHint: String? = nil,
        sameAs: String? = nil,
        vaultEntryID: String? = nil
    ) {
        self.span = span
        self.text = text
        self.category = category
        self.subtype = subtype
        self.detector = detector
        self.confidence = confidence
        self.roleHint = roleHint
        self.sameAs = sameAs
        self.vaultEntryID = vaultEntryID
    }
}
