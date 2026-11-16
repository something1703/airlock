import AirlockCore

/// One "always protect" entry the user saved (onboarding / Vault screen).
///
/// Stored only on device, encrypted (INV-6). Never synced.
public struct VaultEntry: Sendable, Hashable, Codable, Identifiable {
    public let id: String
    public var canonical: String
    public var aliases: [String]
    public var category: PrivacyCategory
    /// "me", "my landlord", "my employer" — used as the legend role hint.
    public var roleHint: String?
    /// The user themself → always `[[PERSON_ME]]`.
    public var isUser: Bool

    public init(
        id: String, canonical: String, aliases: [String] = [], category: PrivacyCategory, roleHint: String? = nil, isUser: Bool = false
    ) {
        self.id = id
        self.canonical = canonical
        self.aliases = aliases
        self.category = category
        self.roleHint = roleHint
        self.isUser = isUser
    }

    /// Canonical plus aliases, longest first (so "Raj Patel" wins over "Raj").
    public var allTerms: [String] {
        Array(Set([canonical] + aliases).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
            .sorted { $0.count != $1.count ? $0.count > $1.count : $0 < $1 }
    }
}

/// D1 — Vault matcher (`docs/03-PRIVACY-ENGINE.md` §5.1). Highest-priority detector.
///
/// Guarantees: case-, diacritic- and width-insensitive; word-bounded (so "Raj"
/// matches "Raj's" and "RAJ" but not "Rajesh"); multi-word terms tolerate any
/// whitespace between words; first-name-only matches happen only when that
/// first name is listed as an alias. Every hit has `confidence: .high`,
/// `detector: .vault` and the entry's id. Hits never overlap: longer terms win.
public struct VaultMatcher: Sendable {
    public let entries: [VaultEntry]

    public init(entries: [VaultEntry]) {
        self.entries = entries
    }

    public func detect(in text: String) -> [Candidate] {
        var hits: [(span: TextSpan, entry: VaultEntry)] = []
        // Longest terms first across all entries.
        let terms = entries.flatMap { entry in entry.allTerms.map { (term: $0, entry: entry) } }
            .sorted { $0.term.count > $1.term.count }
        for (term, entry) in terms {
            for span in FoldedSearch.ranges(of: term, in: text) where !hits.contains(where: { $0.span.overlaps(span) }) {
                hits.append((span, entry))
            }
        }
        return hits.sorted { $0.span < $1.span }.compactMap { hit in
            guard let value = text.substring(utf16: hit.span) else { return nil }
            return Candidate(
                span: hit.span, text: value, category: hit.entry.category,
                subtype: hit.entry.isUser ? "self" : nil, detector: .vault, confidence: .high,
                roleHint: hit.entry.isUser ? "the user" : hit.entry.roleHint, vaultEntryID: hit.entry.id)
        }
    }
}
