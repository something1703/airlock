/// Identifier of a placeholder: `PERSON_1`, `ORG_2`, `PERSON_ME`.
///
/// Guarantees: `token` is the canonical wire form `[[PERSON_1]]` (ADR-01) and
/// `init?(string:)` accepts exactly the canonical id grammar
/// `(PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET)_(\d+|ME)` with `ME` only for PERSON.
public struct PlaceholderID: Sendable, Hashable, Codable, Comparable, CustomStringConvertible {
    public enum Index: Sendable, Hashable, Codable {
        case number(Int)
        case me
    }

    public let category: PrivacyCategory
    public let index: Index

    public init(category: PrivacyCategory, number: Int) {
        precondition(category.placeholderPrefix != nil, "quasi has no placeholder")
        precondition(number >= 1, "placeholder numbers start at 1")
        self.category = category
        self.index = .number(number)
    }

    /// The user themself: `PERSON_ME` (legend "the user").
    public static let me = PlaceholderID(meCategory: .person)

    private init(meCategory: PrivacyCategory) {
        self.category = meCategory
        self.index = .me
    }

    /// Parses `PERSON_1` / `PERSON_ME` (case-insensitive prefix, `_` separator).
    public init?(string: String) {
        let parts = string.split(separator: "_", maxSplits: 1).map(String.init)
        guard parts.count == 2, let category = PrivacyCategory(placeholderPrefix: parts[0]) else { return nil }
        if parts[1].uppercased() == "ME" {
            guard category == .person else { return nil }
            self = .me
        } else if let n = Int(parts[1]), n >= 1, parts[1].allSatisfy(\.isASCII), parts[1].first != "0" {
            self.init(category: category, number: n)
        } else {
            return nil
        }
    }

    public var description: String {
        let prefix = category.placeholderPrefix ?? "QUASI"
        switch index {
        case .number(let n): return "\(prefix)_\(n)"
        case .me: return "\(prefix)_ME"
        }
    }

    /// Canonical wire token, e.g. `[[PERSON_1]]`.
    public var token: String { "[[\(description)]]" }

    public var isMe: Bool { index == .me }

    public static func < (lhs: PlaceholderID, rhs: PlaceholderID) -> Bool {
        if lhs.category != rhs.category { return lhs.category.priority < rhs.category.priority }
        switch (lhs.index, rhs.index) {
        case (.me, .me): return false
        case (.me, _): return true
        case (_, .me): return false
        case (.number(let a), .number(let b)): return a < b
        }
    }
}

/// What the seal step does with one entity.
public enum Action: Sendable, Hashable, Codable {
    /// Replace with `[[CATEGORY_n]]`; restored on return.
    case placeholder
    /// Replace with a vaguer phrase (`level` 1–3, `docs/03-PRIVACY-ENGINE.md` §2.2); not restored.
    case generalise(level: Int)
    /// Leave as written.
    case keep
    /// Replace with `[[SECRET_n]]`, warn the user, **never restore**.
    case block

    /// Whether the entity's surface forms must be absent from egress text (gate check G2).
    public var mustNotEgress: Bool {
        switch self {
        case .placeholder, .block, .generalise: true
        case .keep: false
        }
    }
}

/// One private thing, after merging and coreference.
///
/// Guarantees: `surfaceForms` contains every way the thing was written in the
/// text (used by the gate and by fidelity checks); `roleHint` never contains a
/// surface form (enforced by the sealer's mini-gate).
public struct Entity: Sendable, Hashable, Codable, Identifiable {
    public let id: PlaceholderID
    public let category: PrivacyCategory
    public var canonical: String
    public var surfaceForms: Set<String>
    public var roleHint: String?
    public var action: Action
    public var generalisedText: String?
    public var sources: Set<DetectorID>
    public var confidence: Confidence
    public var subtype: String?
    /// The Vault entry this entity came from, if any (Vault entities can only be
    /// revealed with an explicit "Reveal this time").
    public var vaultEntryID: String?

    public init(
        id: PlaceholderID,
        category: PrivacyCategory,
        canonical: String,
        surfaceForms: Set<String>,
        roleHint: String? = nil,
        action: Action = .placeholder,
        generalisedText: String? = nil,
        sources: Set<DetectorID>,
        confidence: Confidence,
        subtype: String? = nil,
        vaultEntryID: String? = nil
    ) {
        self.id = id
        self.category = category
        self.canonical = canonical
        self.surfaceForms = surfaceForms.union([canonical])
        self.roleHint = roleHint
        self.action = action
        self.generalisedText = generalisedText
        self.sources = sources
        self.confidence = confidence
        self.subtype = subtype
        self.vaultEntryID = vaultEntryID
    }
}

/// Placeholder → entity, for one thread. Lives only on device, encrypted at rest (INV-6).
///
/// Guarantees: ids are unique; `nextID(for:)` continues numbering per category
/// in order of first appearance and is stable across follow-ups.
public struct EntityMap: Sendable, Hashable, Codable {
    public private(set) var entities: [PlaceholderID: Entity]

    public init(_ entities: [Entity] = []) {
        self.entities = Dictionary(uniqueKeysWithValues: entities.map { ($0.id, $0) })
    }

    public subscript(id: PlaceholderID) -> Entity? { entities[id] }

    public var sorted: [Entity] { entities.values.sorted { $0.id < $1.id } }

    public mutating func upsert(_ entity: Entity) { entities[entity.id] = entity }

    /// Next unused number for `category` (`PERSON_ME` does not consume a number).
    public func nextID(for category: PrivacyCategory) -> PlaceholderID {
        let used = entities.keys.compactMap { key -> Int? in
            guard key.category == category, case .number(let n) = key.index else { return nil }
            return n
        }
        return PlaceholderID(category: category, number: (used.max() ?? 0) + 1)
    }
}
