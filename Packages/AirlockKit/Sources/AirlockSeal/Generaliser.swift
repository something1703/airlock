import AirlockCore
import AirlockDetect
import Foundation

/// The on-device rewrite model (`gen.v1`), plugged in by `AirlockEngines`. Phone-only (INV-3).
public protocol GeneraliserModel: Sendable {
    func rewrite(phrase: String, sentence: String, category: PrivacyCategory, level: Int, taskSummary: String) async -> String?
}

/// Generalisation: deterministic ladder defaults plus validation of model rewrites
/// (`docs/03-PRIVACY-ENGINE.md` §2.2, `docs/04-PROMPTS.md` §3).
///
/// Guarantees: `validate` accepts a rewrite only if it is non-empty, ≤ 8 words,
/// different from the phrase, contains no surface form of **any** entity, and has
/// no pattern hit outside dates. Ladder defaults never contain input text except
/// derived ages/relative dates, which contain no identifying detail.
public enum Generaliser {
    public static let maxWords = 8

    // MARK: Ladder defaults

    public static func ladderDefault(for e: Entity, level: Int, today: Date = Date()) -> String {
        switch e.category {
        case .org: return "an organisation"
        case .location: return level >= 3 ? "a place" : "a city"
        case .health: return level >= 3 ? "a health matter" : "a medical condition"
        case .quasi: return "a specific detail"
        case .date:
            guard let date = DateText.parse(e.canonical, today: today) else {
                return e.subtype == "dob" ? "an adult" : "a recent date"
            }
            if e.subtype == "dob" { return ageDescription(dob: date, today: today, coarse: level >= 3) }
            return relativeDescription(of: date, today: today)
        case .person: return "a person"
        case .contact: return "contact details"
        case .id: return "a reference number"
        case .secret: return "a secret"
        }
    }

    /// "late 30s" (balanced) or "30s" (strict). Children/teens are never given exact ages.
    public static func ageDescription(dob: Date, today: Date, coarse: Bool) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        guard let years = cal.dateComponents([.year], from: dob, to: today).year, years >= 0 else { return "an adult" }
        if years < 13 { return "a child" }
        if years < 20 { return "a teenager" }
        let decade = years / 10 * 10
        if coarse { return "\(decade)s" }
        let pos = years % 10
        return "\(pos <= 3 ? "early" : pos <= 6 ? "mid" : "late") \(decade)s"
    }

    /// "3 weeks ago", "in 2 days", "about 2 years ago".
    public static func relativeDescription(of date: Date, today: Date) -> String {
        let days = Int((date.timeIntervalSince(today) / 86_400).rounded())
        let n = abs(days)
        let future = days > 0
        func phrase(_ k: Int, _ unit: String) -> String {
            let u = k == 1 ? unit : unit + "s"
            return future ? "in \(k) \(u)" : "\(k) \(u) ago"
        }
        switch n {
        case 0: return "today"
        case 1: return future ? "tomorrow" : "yesterday"
        case 2..<7: return phrase(n, "day")
        case 7..<60: return phrase(Int((Double(n) / 7).rounded()), "week")
        case 60..<365: return phrase(Int((Double(n) / 30.4).rounded()), "month")
        default:
            let years = Int((Double(n) / 365.25).rounded())
            return future ? "in about \(years) year\(years == 1 ? "" : "s")" : "about \(years) year\(years == 1 ? "" : "s") ago"
        }
    }

    // MARK: Validation

    public static func validate(_ rewrite: String, replacing phrase: String, entities: EntityMap, patterns: PatternDetector) -> Bool {
        let r = rewrite.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !r.isEmpty, r.split(whereSeparator: \.isWhitespace).count <= maxWords else { return false }
        guard FoldedSearch.fold(r) != FoldedSearch.fold(phrase) else { return false }
        guard !r.contains("[[") else { return false }
        for e in entities.sorted where e.category != .date || e.action.mustNotEgress {
            for term in EgressGate.entityTerms(e)
            where !FoldedSearch.ranges(of: term.text, in: r, caseSensitive: term.caseSensitive).isEmpty {
                return false
            }
        }
        return !patterns.detect(in: r).contains { $0.category != .date }
    }
}

/// Parses the date formats the pattern detector produces (en_US_POSIX, UTC).
enum DateText {
    static func parse(_ raw: String, today: Date) -> Date? {
        var s = raw.replacingOccurrences(of: ",", with: " ").replacingOccurrences(of: ".", with: " ")
        s = s.replacingOccurrences(of: #"(\d)(st|nd|rd|th)\b"#, with: "$1", options: .regularExpression)
        s = s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let numeric = s.split(whereSeparator: { $0 == "/" || $0 == "-" })
        var formats = ["yyyy-MM-dd", "d MMM yyyy", "d MMMM yyyy", "MMM d yyyy", "MMMM d yyyy", "MMM d", "MMMM d", "d MMM", "d MMMM"]
        if numeric.count == 3, let first = Int(numeric[0]) {
            // Day-first when unambiguous, else US month-first.
            let sep = s.contains("/") ? "/" : "-"
            let year = numeric[2].count == 2 ? "yy" : "yyyy"
            formats.insert(first > 12 ? "d\(sep)M\(sep)\(year)" : "M\(sep)d\(sep)\(year)", at: 0)
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.isLenient = false
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        for format in formats {
            f.dateFormat = format
            guard let d = f.date(from: s) else { continue }
            if !format.contains("y") {
                // No year: the most recent such date not more than ~6 months ahead.
                let year = cal.component(.year, from: today)
                var comps = cal.dateComponents([.month, .day], from: d)
                comps.year = year
                guard var candidate = cal.date(from: comps) else { continue }
                if candidate.timeIntervalSince(today) > 183 * 86_400 {
                    comps.year = year - 1
                    candidate = cal.date(from: comps) ?? candidate
                }
                return candidate
            }
            return d
        }
        return nil
    }
}
