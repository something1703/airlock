import Foundation

/// Checksum and plausibility validators for pattern detectors.
///
/// Guarantees: pure functions over the digits/characters given; separators
/// (spaces, dashes) are ignored. Behaviour is pinned by
/// `spec/fixtures/validators.json`, shared with the web and Android engines.
public enum Validators {
    /// Luhn (mod 10) — payment cards (13–19 digits), Canadian SIN.
    public static func luhn(_ s: String) -> Bool {
        let digits = s.compactMap(\.wholeNumberValue)
        guard digits.count >= 2, digits.count == s.filter({ !$0.isWhitespace && $0 != "-" }).count else { return false }
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            if i % 2 == 1 {
                let doubled = d * 2
                sum += doubled > 9 ? doubled - 9 : doubled
            } else {
                sum += d
            }
        }
        return sum % 10 == 0
    }

    /// Payment card: 13–19 digits, Luhn-valid, not all one digit.
    public static func card(_ s: String) -> Bool {
        let digits = s.filter(\.isNumber)
        guard (13...19).contains(digits.count), Set(digits).count > 1 else { return false }
        return luhn(s)
    }

    /// IBAN ISO 7064 mod-97 == 1, length 15–34, country letters + 2 check digits.
    public static func iban(_ s: String) -> Bool {
        let compact = s.uppercased().filter { !$0.isWhitespace }
        guard (15...34).contains(compact.count), compact.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
            return false
        }
        let chars = Array(compact)
        guard chars[0].isLetter, chars[1].isLetter, chars[2].isNumber, chars[3].isNumber else { return false }
        let rearranged = chars[4...] + chars[..<4]
        var remainder = 0
        for c in rearranged {
            if let d = c.wholeNumberValue {
                remainder = (remainder * 10 + d) % 97
            } else if let ascii = c.asciiValue {
                let v = Int(ascii) - 55  // A=10 … Z=35
                remainder = (remainder * 100 + v) % 97
            } else {
                return false
            }
        }
        return remainder == 1
    }

    /// US SSN `AAA-GG-SSSS`: area not 000/666/900–999, group not 00, serial not 0000.
    public static func ssn(_ s: String) -> Bool {
        let parts = s.split(separator: "-")
        guard parts.count == 3, parts[0].count == 3, parts[1].count == 2, parts[2].count == 4,
            let area = Int(parts[0]), let group = Int(parts[1]), let serial = Int(parts[2])
        else { return false }
        return area != 0 && area != 666 && area < 900 && group != 0 && serial != 0
    }

    /// UK National Insurance number: excluded prefixes and letters per HMRC rules.
    public static func ukNI(_ s: String) -> Bool {
        let compact = s.uppercased().filter { !$0.isWhitespace }
        guard compact.count == 9 else { return false }
        let prefix = String(compact.prefix(2))
        let invalidPrefixes: Set<String> = ["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]
        guard !invalidPrefixes.contains(prefix), compact[compact.index(after: compact.startIndex)] != "O" else { return false }
        return true
    }

    // MARK: Verhoeff (Aadhaar)

    private static let verhoeffD: [[Int]] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
        [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
        [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
        [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
        [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    ]
    private static let verhoeffP: [[Int]] = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
        [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
        [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
        [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
    ]

    /// Verhoeff checksum (Indian Aadhaar numbers).
    public static func verhoeff(_ s: String) -> Bool {
        let digits = s.compactMap(\.wholeNumberValue)
        guard !digits.isEmpty else { return false }
        var c = 0
        for (i, d) in digits.reversed().enumerated() {
            c = verhoeffD[c][verhoeffP[i % 8][d]]
        }
        return c == 0
    }

    /// Aadhaar: 12 digits, first digit 2–9, Verhoeff-valid.
    public static func aadhaar(_ s: String) -> Bool {
        let digits = s.filter(\.isNumber)
        guard digits.count == 12, let first = digits.first?.wholeNumberValue, first >= 2 else { return false }
        return verhoeff(digits)
    }

    /// Indian PAN `AAAAA9999A`, 4th letter is the holder type.
    public static func pan(_ s: String) -> Bool {
        let chars = Array(s.uppercased())
        guard chars.count == 10 else { return false }
        return "PCHFATBLJG".contains(chars[3])
    }

    /// Shannon entropy in bits per character.
    public static func shannonEntropy(_ s: String) -> Double {
        guard !s.isEmpty else { return 0 }
        var counts: [Character: Int] = [:]
        for c in s { counts[c, default: 0] += 1 }
        let n = Double(s.count)
        return counts.values.reduce(0) { acc, k in
            let p = Double(k) / n
            return acc - p * log2(p)
        }
    }

    /// Phone: 7–15 digits and not shaped like a date (`2026-11-21`, `21/11/2026`).
    public static func phone(_ s: String) -> Bool {
        guard (7...15).contains(s.filter(\.isNumber).count) else { return false }
        let dateShapes = [#"^\d{4}-\d{2}-\d{2}$"#, #"^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$"#]
        return !dateShapes.contains { s.range(of: $0, options: .regularExpression) != nil }
    }

    /// At least one digit (reference numbers, passports).
    public static func hasDigit(_ s: String) -> Bool { s.contains(where: \.isNumber) }

    /// Licence plate token: has both a letter and a digit.
    public static func plate(_ s: String) -> Bool { s.contains(where: \.isNumber) && s.contains(where: \.isLetter) }

    /// High-entropy secret: ≥ 24 chars, letters and digits, Shannon entropy ≥ 3.5 bits/char.
    public static func entropySecret(_ s: String) -> Bool {
        s.count >= 24 && s.contains(where: \.isLetter) && s.contains(where: \.isNumber) && shannonEntropy(s) >= 3.5
    }

    private static let profileHosts = [
        "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com", "tiktok.com",
        "github.com", "youtube.com", "threads.net", "reddit.com", "t.me", "wa.me", "venmo.com", "cash.app",
    ]
    private static let identifyingTokens = [
        "id=", "uid", "user", "token", "account", "acct", "profile", "member", "session", "invite",
        "reset", "email=", "phone=", "/u/", "/in/", "/@", "ref=",
    ]

    /// URL that points at a person or carries identifiers (profile pages, ids,
    /// tokens, or a ≥ 8-char alphanumeric run with a digit in the path/query).
    /// Bare domains and generic paths (`https://www.irs.gov/help`) are not identifying.
    public static func urlIdentifying(_ s: String) -> Bool {
        var rest = s.lowercased()
        for scheme in ["https://", "http://"] where rest.hasPrefix(scheme) { rest.removeFirst(scheme.count) }
        let slash = rest.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" })
        let host = String(slash.map { rest[..<$0] } ?? Substring(rest)).replacingOccurrences(of: "www.", with: "")
        let path = slash.map { String(rest[$0...]) } ?? ""
        let meaningfulPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/?#"))
        if profileHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) }), !meaningfulPath.isEmpty { return true }
        if identifyingTokens.contains(where: { path.contains($0) }) { return true }
        let runs = path.split(whereSeparator: { !($0.isLetter || $0.isNumber) })
        return runs.contains { $0.count >= 8 && $0.contains(where: \.isNumber) }
    }

    /// Looks up a validator by the name used in pattern packs and fixtures.
    public static func named(_ name: String) -> (@Sendable (String) -> Bool)? {
        switch name {
        case "luhn": luhn
        case "card": card
        case "iban": iban
        case "ssn": ssn
        case "uk_ni": ukNI
        case "verhoeff": verhoeff
        case "aadhaar": aadhaar
        case "pan": pan
        case "phone": phone
        case "has_digit": hasDigit
        case "plate": plate
        case "entropy_secret": entropySecret
        case "url_identifying": urlIdentifying
        default: nil
        }
    }
}
