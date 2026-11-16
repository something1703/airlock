/// The kinds of private detail Airlock recognises.
///
/// Guarantees: the set and the placeholder prefixes are fixed and shared with the
/// web and Android engines (`spec/fixtures/`). `priority` gives the conflict
/// order used when two detections of different categories overlap
/// (`docs/03-PRIVACY-ENGINE.md` §6): lower number wins.
public enum PrivacyCategory: String, Sendable, CaseIterable, Codable, Hashable {
    case person, org, location, contact, id, date, health, secret, quasi

    /// Placeholder prefix, e.g. `PERSON` in `[[PERSON_1]]`. `quasi` has none:
    /// quasi-identifiers are rewritten in place, never placeholdered.
    public var placeholderPrefix: String? {
        switch self {
        case .person: "PERSON"
        case .org: "ORG"
        case .location: "LOC"
        case .contact: "CONTACT"
        case .id: "ID"
        case .date: "DATE"
        case .health: "HEALTH"
        case .secret: "SECRET"
        case .quasi: nil
        }
    }

    /// Conflict priority: `secret > id > contact > person > org > location > date > health > quasi`.
    public var priority: Int {
        switch self {
        case .secret: 0
        case .id: 1
        case .contact: 2
        case .person: 3
        case .org: 4
        case .location: 5
        case .date: 6
        case .health: 7
        case .quasi: 8
        }
    }

    /// Inverse of `placeholderPrefix` (case-insensitive).
    public init?(placeholderPrefix prefix: String) {
        guard let match = PrivacyCategory.allCases.first(where: { $0.placeholderPrefix == prefix.uppercased() }) else {
            return nil
        }
        self = match
    }
}
