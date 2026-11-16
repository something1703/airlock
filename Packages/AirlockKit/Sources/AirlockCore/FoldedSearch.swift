import Foundation

/// Case- and diacritic-insensitive, word-bounded search, shared by the Vault
/// matcher (D1), the egress gate (G1/G2) and the restore fidelity check.
///
/// Guarantees: a hit never starts or ends inside a word — the UTF-16 unit
/// before and after must not be a letter, digit or combining mark — so "Raj"
/// matches "Raj's" and "Raj," but never "Rajesh". Whitespace inside the needle
/// matches any run of whitespace in the haystack. All spans are UTF-16.
public enum FoldedSearch {
    /// All non-overlapping hits of `needle` in `haystack`, left to right.
    /// `caseSensitive: true` keeps diacritic/width folding but requires exact letter case
    /// (used by the gate's name-token check so "Will" the name doesn't match "will" the verb).
    public static func ranges(of needle: String, in haystack: String, caseSensitive: Bool = false) -> [TextSpan] {
        let trimmed = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        let opts = caseSensitive ? options.subtracting(.caseInsensitive) : options
        let tokens = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
        if tokens.count > 1 {
            return multiTokenRanges(tokens, in: haystack, options: opts)
        }
        return singleTokenRanges(trimmed, in: haystack, options: opts)
    }

    /// Whether `needle` occurs anywhere in `haystack` (word-bounded, folded).
    public static func contains(_ needle: String, in haystack: String) -> Bool {
        !ranges(of: needle, in: haystack).isEmpty
    }

    /// Lowercased, diacritic-stripped, width-folded form — for comparing names.
    public static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    private static let options: NSString.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]

    private static func singleTokenRanges(_ needle: String, in haystack: String, options: NSString.CompareOptions) -> [TextSpan] {
        let ns = haystack as NSString
        var results: [TextSpan] = []
        var searchStart = 0
        while searchStart < ns.length {
            let found = ns.range(of: needle, options: options, range: NSRange(location: searchStart, length: ns.length - searchStart))
            guard found.location != NSNotFound, found.length > 0 else { break }
            if isBoundary(ns, at: found.location - 1), isBoundary(ns, at: found.location + found.length) {
                results.append(TextSpan(found))
                searchStart = found.location + found.length
            } else {
                searchStart = found.location + 1
            }
        }
        return results
    }

    private static func multiTokenRanges(_ tokens: [String], in haystack: String, options: NSString.CompareOptions) -> [TextSpan] {
        let ns = haystack as NSString
        var results: [TextSpan] = []
        for first in singleTokenRanges(tokens[0], in: haystack, options: options) {
            if let last = results.last, first.start < last.end { continue }
            var cursor = first.end
            var ok = true
            for token in tokens.dropFirst() {
                // Require at least one whitespace unit, then the token at a boundary.
                var ws = cursor
                while ws < ns.length, let scalar = Unicode.Scalar(ns.character(at: ws)),
                    CharacterSet.whitespacesAndNewlines.contains(scalar)
                {
                    ws += 1
                }
                guard ws > cursor, ws < ns.length else { ok = false; break }
                let window = NSRange(location: ws, length: ns.length - ws)
                let hit = ns.range(of: token, options: options.union(.anchored), range: window)
                guard hit.location == ws, hit.length > 0, isBoundary(ns, at: hit.location + hit.length) else {
                    ok = false
                    break
                }
                cursor = hit.location + hit.length
            }
            if ok { results.append(TextSpan(start: first.start, end: cursor)) }
        }
        return results
    }

    /// True if the unit at `index` is outside the string or is not part of a word.
    package static func isBoundary(_ ns: NSString, at index: Int) -> Bool {
        guard index >= 0, index < ns.length else { return true }
        let unit = ns.character(at: index)
        guard let scalar = Unicode.Scalar(unit) else {
            // Surrogate half: part of a non-BMP character (emoji, rare scripts) — treat as a letter
            // only if it's a letter; conservatively say "not a boundary" for letters we can't see.
            return false
        }
        return !(CharacterSet.alphanumerics.contains(scalar) || CharacterSet.nonBaseCharacters.contains(scalar))
    }
}
