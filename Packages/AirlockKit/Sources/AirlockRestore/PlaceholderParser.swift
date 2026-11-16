import AirlockCore
import Foundation

/// One placeholder-like token found in model output.
public struct PlaceholderToken: Sendable, Hashable {
    public let span: TextSpan
    /// Exactly what the model wrote, e.g. `[[ Person_1 ]]`.
    public let original: String
    public let id: PlaceholderID
    /// True only for the exact canonical form `[[PERSON_1]]`.
    public let isCanonical: Bool
}

/// Finds placeholders in model output (`docs/03-PRIVACY-ENGINE.md` §11.1).
///
/// Guarantees:
/// - The canonical form `[[CATEGORY_n]]` is always returned, even for unknown ids
///   (the UI shows those as "unknown" chips).
/// - Tolerated variants — `[PERSON_1]`, bare `PERSON_1`, `[[ PERSON_1 ]]`,
///   `[[Person_1]]`, `[[PERSON 1]]`, `【PERSON_1】` — are returned **only** when
///   the id is in `knownIDs`; otherwise the text is left alone.
/// - No token is longer than `maxTokenLength` UTF-16 units, which the streaming
///   restorer relies on for its hold-back window.
public struct PlaceholderParser: Sendable {
    public static let maxTokenLength = 24

    final class Regexes: @unchecked Sendable {
        // Immutable, thread-safe.
        let bracketed: NSRegularExpression
        let bare: NSRegularExpression
        init() throws {
            let cats = "PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET"
            bracketed = try NSRegularExpression(
                pattern: #"(\[\[|\[|【)[ ]{0,2}("# + cats + #")([_ ])(\d{1,4}|ME)[ ]{0,2}(\]\]|\]|】)"#,
                options: [.caseInsensitive])
            bare = try NSRegularExpression(
                pattern: #"(?<![A-Za-z0-9_\[【])("# + cats + #")_(\d{1,4}|ME)(?![A-Za-z0-9_\]】])"#)
        }
    }

    /// Constant patterns; `PlaceholderParserTests.regexesCompile` asserts this is non-nil.
    static let regexes: Regexes? = try? Regexes()
    public let knownIDs: Set<PlaceholderID>

    public init(knownIDs: Set<PlaceholderID>) {
        self.knownIDs = knownIDs
    }

    public func tokens(in text: String) -> [PlaceholderToken] {
        guard let regexes = Self.regexes else { return [] }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        var found: [PlaceholderToken] = []

        for m in regexes.bracketed.matches(in: text, range: full) {
            let open = ns.substring(with: m.range(at: 1))
            let cat = ns.substring(with: m.range(at: 2))
            let sep = ns.substring(with: m.range(at: 3))
            let idx = ns.substring(with: m.range(at: 4))
            let close = ns.substring(with: m.range(at: 5))
            guard let id = PlaceholderID(string: cat + "_" + idx) else { continue }
            let original = ns.substring(with: m.range)
            let canonical = open == "[[" && close == "]]" && sep == "_" && original == id.token
            guard canonical || knownIDs.contains(id) else { continue }
            found.append(PlaceholderToken(span: TextSpan(m.range), original: original, id: id, isCanonical: canonical))
        }
        for m in regexes.bare.matches(in: text, range: full) {
            let span = TextSpan(m.range)
            guard !found.contains(where: { $0.span.overlaps(span) }) else { continue }
            let original = ns.substring(with: m.range)
            guard let id = PlaceholderID(string: original), knownIDs.contains(id) else { continue }
            found.append(PlaceholderToken(span: span, original: original, id: id, isCanonical: false))
        }
        return found.sorted { $0.span < $1.span }
    }
}
