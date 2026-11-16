import AirlockCore
import Foundation
import NaturalLanguage

/// A piece of normalised text sized for the on-device window.
public struct Chunk: Sendable, Hashable {
    public let index: Int
    /// UTF-16 span in the full normalised text.
    public let span: TextSpan
    package let text: String
}

/// Stage 2 — chunking for the on-device limit (`docs/03-PRIVACY-ENGINE.md` §4).
///
/// Guarantees:
/// - Chunks cover the whole text, in order; consecutive chunks overlap by one sentence
///   (catches names split by a boundary).
/// - Every chunk's estimated tokens ≤ the budget, unless a single unbreakable run of
///   characters is longer than the budget (then it is cut by characters).
/// - Token estimates are conservative: chars / 3.2 for Latin-like scripts, chars / 1.8 for
///   CJK, Indic, Arabic and Cyrillic (the SDK can't count tokens in hybrid mode).
public enum Chunker {
    public static func estimateTokens(_ s: String) -> Int {
        var weighted = 0.0
        for scalar in s.unicodeScalars {
            weighted += isDenseScript(scalar) ? 1 / 1.8 : 1 / 3.2
        }
        return Int((weighted - 1e-9).rounded(.up))  // epsilon: 180 × (1/1.8) must be 100, not 101
    }

    static func isDenseScript(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x0400...0x052F,  // Cyrillic
            0x0590...0x08FF,  // Hebrew, Arabic, Syriac, Thaana, NKo
            0x0900...0x0DFF,  // Indic
            0x0E00...0x0EFF,  // Thai, Lao
            0x1100...0x11FF, 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xAC00...0xD7AF,  // CJK, kana, Hangul
            0xF900...0xFAFF, 0xFF00...0xFFEF:
            true
        default: false
        }
    }

    public static func chunks(_ text: String, budgetTokens: Int) -> [Chunk] {
        let budget = max(50, budgetTokens)
        let ns = text as NSString
        guard ns.length > 0 else { return [] }
        let sentences = sentenceSpans(text).flatMap { hardSplit($0, in: ns, budget: budget) }

        var result: [TextSpan] = []
        var i = 0
        while i < sentences.count {
            var j = i
            var end = sentences[i].end
            while j + 1 < sentences.count {
                let candidate = TextSpan(start: sentences[i].start, end: sentences[j + 1].end)
                guard estimateTokens(ns.substring(with: candidate.nsRange)) <= budget else { break }
                j += 1
                end = sentences[j].end
            }
            result.append(TextSpan(start: sentences[i].start, end: end))
            if j + 1 >= sentences.count { break }
            // Overlap: next chunk starts with this chunk's last sentence (if it had more than one).
            i = j > i ? j : j + 1
        }
        return result.enumerated().map { Chunk(index: $0.offset, span: $0.element, text: ns.substring(with: $0.element.nsRange)) }
    }

    /// Splits a chunk in two at a sentence or whitespace boundary near the middle (for `contextTooLong`).
    public static func halve(_ chunk: Chunk, in fullText: String) -> [Chunk] {
        let ns = fullText as NSString
        let mid = chunk.span.start + chunk.span.length / 2
        var cut = mid
        while cut > chunk.span.start + 1, let s = Unicode.Scalar(ns.character(at: cut)), !CharacterSet.whitespacesAndNewlines.contains(s) {
            cut -= 1
        }
        if cut <= chunk.span.start + 1 { cut = mid }
        if cut < ns.length, UTF16.isTrailSurrogate(ns.character(at: cut)) { cut += 1 }
        guard cut > chunk.span.start, cut < chunk.span.end else { return [chunk] }
        let a = TextSpan(start: chunk.span.start, end: cut), b = TextSpan(start: cut, end: chunk.span.end)
        return [
            Chunk(index: chunk.index, span: a, text: ns.substring(with: a.nsRange)),
            Chunk(index: chunk.index, span: b, text: ns.substring(with: b.nsRange)),
        ]
    }

    /// Contiguous sentence spans (trailing whitespace belongs to the sentence before it).
    static func sentenceSpans(_ text: String) -> [TextSpan] {
        let tokenizer = NLTokenizer(unit: .sentence)
        tokenizer.string = text
        var spans: [TextSpan] = []
        tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
            spans.append(TextSpan(NSRange(range, in: text)))
            return true
        }
        let total = text.utf16.count
        guard !spans.isEmpty else { return [TextSpan(start: 0, end: total)] }
        // Make contiguous: each sentence runs to the next one's start; first starts at 0.
        var contiguous: [TextSpan] = []
        for (k, s) in spans.enumerated() {
            let start = k == 0 ? 0 : contiguous[k - 1].end
            let end = k + 1 < spans.count ? spans[k + 1].start : total
            contiguous.append(TextSpan(start: start, end: max(start, max(s.end, end))))
        }
        return contiguous.filter { $0.length > 0 }
    }

    static func hardSplit(_ span: TextSpan, in ns: NSString, budget: Int) -> [TextSpan] {
        guard estimateTokens(ns.substring(with: span.nsRange)) > budget else { return [span] }
        var pieces: [TextSpan] = []
        var start = span.start
        while start < span.end {
            // Conservative character budget (dense-script rate).
            var end = min(span.end, start + Int(Double(budget) * 1.8))
            if end < span.end {
                var k = end
                while k > start + 1, let s = Unicode.Scalar(ns.character(at: k - 1)), !CharacterSet.whitespacesAndNewlines.contains(s) {
                    k -= 1
                }
                if k > start + 1 { end = k }
                if end < ns.length, UTF16.isTrailSurrogate(ns.character(at: end)) { end += 1 }
            }
            pieces.append(TextSpan(start: start, end: end))
            start = end
        }
        return pieces
    }
}
