import AirlockCore
import Foundation

/// One rule in a pattern pack (`PatternPacks/*.json`, shared with web and Android).
public struct PatternRule: Sendable, Codable, Hashable {
    public struct Context: Sendable, Codable, Hashable {
        /// Lowercase words or short phrases.
        public let words: [String]
        /// How many tokens before / after the match to search.
        public let before: Int
        public let after: Int
        /// If true, the rule only fires when a context word is present.
        public let required: Bool
        /// If set, a present context word upgrades the subtype (e.g. date → dob).
        public let subtype: String?
        public let confidence: Confidence?
    }

    public let id: String
    public let category: PrivacyCategory
    public let subtype: String
    public let confidence: Confidence
    public let regex: String
    public let caseInsensitive: Bool?
    /// Capture group holding the value (default 0 = whole match).
    public let group: Int?
    public let validator: String?
    /// If validation fails, retry after dropping trailing space-separated groups (IBANs).
    public let shrink: Bool?
    public let context: Context?
}

/// A named set of rules that Remote Config can disable (`pattern_packs_disabled`).
public struct PatternPack: Sendable, Codable, Hashable {
    public let id: String
    public let description: String
    public let rules: [PatternRule]
}

/// Errors loading pattern packs. User-facing text lives in the app, not here.
public enum PatternError: Error, Sendable, Equatable {
    case packMissing(String)
    case badRegex(ruleID: String)
    case unknownValidator(ruleID: String, name: String)
}

/// D2 — deterministic pattern detectors (`docs/03-PRIVACY-ENGINE.md` §5.2).
///
/// Guarantees: deterministic; every candidate's `text` equals the input's
/// UTF-16 substring at `span`; results never overlap; when two rule hits
/// overlap, the longer span wins, then the higher-priority category
/// (`secret > id > contact > …`). Pure regex rules behave identically on every
/// platform; `useDataDetectors` adds Apple's `NSDataDetector` phone/address
/// results on top (Apple-only recall boost, excluded from conformance fixtures).
public struct PatternDetector: Sendable {
    private final class CompiledRule: @unchecked Sendable {
        // NSRegularExpression is immutable and documented thread-safe.
        let rule: PatternRule
        let regex: NSRegularExpression
        let validator: (@Sendable (String) -> Bool)?
        init(rule: PatternRule, regex: NSRegularExpression, validator: (@Sendable (String) -> Bool)?) {
            self.rule = rule
            self.regex = regex
            self.validator = validator
        }
    }

    private let rules: [CompiledRule]
    private let useDataDetectors: Bool

    public init(packs: [PatternPack], disabledPacks: Set<String> = [], useDataDetectors: Bool = false) throws(PatternError) {
        var compiled: [CompiledRule] = []
        for pack in packs where !disabledPacks.contains(pack.id) {
            for rule in pack.rules {
                let options: NSRegularExpression.Options = rule.caseInsensitive == true ? [.caseInsensitive] : []
                guard let regex = try? NSRegularExpression(pattern: rule.regex, options: options) else {
                    throw .badRegex(ruleID: rule.id)
                }
                var validator: (@Sendable (String) -> Bool)?
                if let name = rule.validator {
                    guard let v = Validators.named(name) else { throw .unknownValidator(ruleID: rule.id, name: name) }
                    validator = v
                }
                compiled.append(CompiledRule(rule: rule, regex: regex, validator: validator))
            }
        }
        rules = compiled
        self.useDataDetectors = useDataDetectors
    }

    /// Pack ids bundled with the app.
    public static let bundledPackIDs = ["core", "national"]

    /// Loads the packs bundled in this module.
    public static func bundledPacks() throws(PatternError) -> [PatternPack] {
        try bundledPackIDs.map { id throws(PatternError) in
            guard let url = Bundle.module.url(forResource: id, withExtension: "json"),
                let data = try? Data(contentsOf: url),
                let pack = try? JSONDecoder().decode(PatternPack.self, from: data)
            else {
                throw .packMissing(id)
            }
            return pack
        }
    }

    /// Detector with bundled packs. `useDataDetectors` defaults to on for app use.
    public static func bundled(disabledPacks: Set<String> = [], useDataDetectors: Bool = true) throws(PatternError) -> PatternDetector {
        try PatternDetector(packs: bundledPacks(), disabledPacks: disabledPacks, useDataDetectors: useDataDetectors)
    }

    /// All candidates in `text` (which should already be normalised).
    public func detect(in text: String) -> [Candidate] {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        var hits: [Candidate] = []

        for compiled in rules {
            let rule = compiled.rule
            for match in compiled.regex.matches(in: text, range: full) {
                let groupIndex = rule.group ?? 0
                guard groupIndex < match.numberOfRanges else { continue }
                var range = match.range(at: groupIndex)
                guard range.location != NSNotFound, range.length > 0 else { continue }
                var value = ns.substring(with: range)

                if let validator = compiled.validator, !validator(value) {
                    guard rule.shrink == true, let shrunk = Self.shrinkToValid(value, validator) else { continue }
                    value = shrunk
                    range = NSRange(location: range.location, length: (shrunk as NSString).length)
                }

                var subtype = rule.subtype
                var confidence = rule.confidence
                if let context = rule.context {
                    let present = Self.contextPresent(context, around: TextSpan(range), in: ns)
                    if context.required && !present { continue }
                    if present {
                        if let s = context.subtype { subtype = s }
                        if let c = context.confidence { confidence = c }
                    }
                }
                hits.append(
                    Candidate(
                        span: TextSpan(range), text: value, category: rule.category, subtype: subtype,
                        detector: .pattern, confidence: confidence))
            }
        }

        if useDataDetectors { hits += dataDetectorHits(in: text) }
        return Self.resolveOverlaps(hits)
    }

    // MARK: - Internals

    /// Longest span first, then category priority, then position; keep non-overlapping.
    static func resolveOverlaps(_ hits: [Candidate]) -> [Candidate] {
        let ordered = hits.sorted {
            if $0.span.length != $1.span.length { return $0.span.length > $1.span.length }
            if $0.category.priority != $1.category.priority { return $0.category.priority < $1.category.priority }
            if $0.confidence != $1.confidence { return $0.confidence > $1.confidence }
            return $0.span < $1.span
        }
        var kept: [Candidate] = []
        for hit in ordered where !kept.contains(where: { $0.span.overlaps(hit.span) }) {
            kept.append(hit)
        }
        return kept.sorted { $0.span < $1.span }
    }

    static func shrinkToValid(_ value: String, _ validator: (String) -> Bool) -> String? {
        var parts = value.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        while parts.count > 1 {
            parts.removeLast()
            let candidate = parts.joined(separator: " ")
            if validator(candidate) { return candidate }
        }
        return nil
    }

    /// Tokens: whitespace-separated, lowercased, outer punctuation trimmed.
    static func tokens(_ s: String) -> [String] {
        let trim = CharacterSet.punctuationCharacters.union(.symbols).subtracting(CharacterSet(charactersIn: "#"))
        return s.lowercased().split(whereSeparator: \.isWhitespace).map {
            $0.trimmingCharacters(in: trim)
        }.filter { !$0.isEmpty }
    }

    static func contextPresent(_ context: PatternRule.Context, around span: TextSpan, in ns: NSString) -> Bool {
        let windowChars = 160
        let beforeStart = max(0, span.start - windowChars)
        let beforeText = ns.substring(with: NSRange(location: beforeStart, length: span.start - beforeStart))
        let afterLen = min(windowChars, ns.length - span.end)
        let afterText = ns.substring(with: NSRange(location: span.end, length: afterLen))
        let before = tokens(beforeText).suffix(context.before)
        let after = tokens(afterText).prefix(context.after)
        let window = " " + (Array(before) + Array(after)).joined(separator: " ") + " "
        return context.words.contains { window.contains(" " + $0 + " ") }
    }

    private func dataDetectorHits(in text: String) -> [Candidate] {
        let types: NSTextCheckingResult.CheckingType = [.phoneNumber, .address]
        guard let detector = try? NSDataDetector(types: types.rawValue) else { return [] }
        let ns = text as NSString
        return detector.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            let value = ns.substring(with: m.range)
            switch m.resultType {
            case .phoneNumber where Validators.phone(value):
                return Candidate(
                    span: TextSpan(m.range), text: value, category: .contact, subtype: "phone", detector: .pattern, confidence: .medium)
            case .address:
                return Candidate(
                    span: TextSpan(m.range), text: value, category: .location, subtype: "address", detector: .pattern, confidence: .medium)
            default:
                return nil
            }
        }
    }
}
