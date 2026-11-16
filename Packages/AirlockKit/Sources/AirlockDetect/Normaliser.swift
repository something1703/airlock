import AirlockCore
import Foundation

/// Text after normalisation, with a map back to the original.
///
/// Guarantees: `originalOffsets.count == text.utf16.count + 1`;
/// `originalOffsets[i]` is the original UTF-16 offset where normalised unit `i`
/// came from, and the last element is the original length. `toOriginal(_:)`
/// therefore maps any normalised span to the original text the user sees.
public struct NormalisedText: Sendable, Hashable {
    public let text: String
    public let originalOffsets: [Int]

    public func toOriginal(_ span: TextSpan) -> TextSpan {
        let start = originalOffsets[min(span.start, originalOffsets.count - 1)]
        // End: the original start of the first unit *after* the span.
        let end = originalOffsets[min(span.end, originalOffsets.count - 1)]
        return TextSpan(start: start, end: max(start, end))
    }
}

/// Stage 1 — ingest and normalise (`docs/03-PRIVACY-ENGINE.md` §3).
///
/// Guarantees, applied in this order per character:
/// 1. zero-width and invisible format characters are removed (a classic filter dodge);
/// 2. smart quotes become ASCII quotes;
/// 3. NFKC compatibility normalisation (full-width digits, ligatures, etc.);
/// 4. runs of horizontal whitespace collapse to one space; CRLF/CR become `\n`.
/// `normalise` is idempotent: `normalise(normalise(x).text).text == normalise(x).text`
/// (used by gate check G6).
public enum Normaliser {
    /// Maximum input accepted for sealing (≈ 15k words).
    public static let maxInputUTF16 = 60_000

    /// Zero-width / invisible characters stripped before detection.
    public static let invisibleScalars: Set<UInt32> = [
        0x00AD,  // soft hyphen
        0x180E,  // Mongolian vowel separator
        0x200B, 0x200C, 0x200D, 0x200E, 0x200F,  // ZW space/non-joiner/joiner, LRM, RLM
        0x202A, 0x202B, 0x202C, 0x202D, 0x202E,  // bidi embeddings/overrides
        0x2060, 0x2061, 0x2062, 0x2063, 0x2064,  // word joiner, invisible operators
        0x2066, 0x2067, 0x2068, 0x2069,  // bidi isolates
        0xFEFF,  // BOM / ZW no-break space
    ]

    private static let quoteMap: [UInt32: String] = [
        0x2018: "'", 0x2019: "'", 0x201A: "'", 0x201B: "'", 0x2032: "'", 0x02BC: "'",
        0x201C: "\"", 0x201D: "\"", 0x201E: "\"", 0x201F: "\"", 0x2033: "\"",
    ]

    public static func normalise(_ input: String) -> NormalisedText {
        var out = ""
        out.reserveCapacity(input.utf8.count)
        var offsets: [Int] = []
        offsets.reserveCapacity(input.utf16.count + 1)
        var originalOffset = 0
        var lastWasSpace = false

        for character in input {
            let originalLength = String(character).utf16.count
            defer { originalOffset += originalLength }

            // CRLF is a single Character in Swift.
            if character == "\r\n" || character == "\r" || character == "\n" {
                append("\n", from: originalOffset, to: &out, offsets: &offsets)
                lastWasSpace = false
                continue
            }

            var cleaned = ""
            for scalar in character.unicodeScalars {
                if invisibleScalars.contains(scalar.value) { continue }
                if let q = quoteMap[scalar.value] { cleaned += q } else { cleaned.unicodeScalars.append(scalar) }
            }
            guard !cleaned.isEmpty else { continue }

            let nfkc = cleaned.precomposedStringWithCompatibilityMapping
            if nfkc.allSatisfy({ $0.isWhitespace && !$0.isNewline }) {
                if !lastWasSpace {
                    append(" ", from: originalOffset, to: &out, offsets: &offsets)
                    lastWasSpace = true
                }
                continue
            }
            append(nfkc, from: originalOffset, to: &out, offsets: &offsets)
            lastWasSpace = false
        }
        offsets.append(originalOffset)
        return NormalisedText(text: out, originalOffsets: offsets)
    }

    private static func append(_ s: String, from original: Int, to out: inout String, offsets: inout [Int]) {
        out += s
        offsets.append(contentsOf: repeatElement(original, count: s.utf16.count))
    }

    /// Whether `text` is already in normal form (gate check G6).
    public static func isNormalised(_ text: String) -> Bool {
        normalise(text).text == text
    }
}
