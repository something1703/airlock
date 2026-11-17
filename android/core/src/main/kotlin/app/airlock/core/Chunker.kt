package app.airlock.core

import kotlin.math.ceil

/** A piece of normalised text sized for the on-device window. `text` is exactly `fullText[span]`. */
data class Chunk(val index: Int, val span: TextSpan, val text: String)

/**
 * Stage 2 — chunking for the on-device window (port of chunker.ts / Chunker.swift). Chunks cover the whole text
 * in order, consecutive chunks overlap by one sentence, and each stays within the token budget unless a single
 * unbreakable run is longer than it. Sentence boundaries are UAX #29 ([SentenceBreaks]), like ICU's `Intl.Segmenter`
 * on the web.
 */
object Chunker {
    private fun isDense(cp: Int): Boolean =
        cp in 0x0400..0x052f || cp in 0x0590..0x08ff || cp in 0x0900..0x0dff || cp in 0x0e00..0x0eff || cp in 0x1100..0x11ff ||
            cp in 0x3040..0x30ff || cp in 0x3400..0x4dbf || cp in 0x4e00..0x9fff || cp in 0xac00..0xd7af || cp in 0xf900..0xfaff ||
            cp in 0xff00..0xffef

    /** Conservative token estimate: chars / 3.2 (Latin-like), chars / 1.8 (CJK, Indic, Arabic, Cyrillic). */
    fun estimateTokens(s: String): Int {
        var weighted = 0.0
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            weighted += if (isDense(cp)) 1 / 1.8 else 1 / 3.2
            i += Character.charCount(cp)
        }
        return ceil(weighted - 1e-9).toInt()
    }

    /** Contiguous sentence spans (trailing whitespace belongs to the sentence before it). */
    private fun sentenceSpans(text: String): List<TextSpan> {
        val spans = ArrayList<TextSpan>()
        var start = 0
        for (b in SentenceBreaks.boundaries(text)) {
            spans.add(TextSpan(start, b))
            start = b
        }
        if (start < text.length) spans.add(TextSpan(start, text.length))
        return spans.ifEmpty { listOf(TextSpan(0, text.length)) }
    }

    private fun hardSplit(span: TextSpan, text: String, budget: Int): List<TextSpan> {
        if (estimateTokens(text.substring(span.start, span.end)) <= budget) return listOf(span)
        val pieces = ArrayList<TextSpan>()
        var start = span.start
        while (start < span.end) {
            var end = minOf(span.end, start + Math.floor(budget * 1.8).toInt())
            if (end < span.end) {
                var k = end
                while (k > start + 1 && !Js.isWhitespace(text[k - 1])) k--
                if (k > start + 1) end = k
                if (end < text.length && text[end].code in 0xdc00..0xdfff) end += 1
            }
            pieces.add(TextSpan(start, end))
            start = end
        }
        return pieces
    }

    fun chunks(text: String, budgetTokens: Int): List<Chunk> {
        val budget = maxOf(50, budgetTokens)
        if (text.isEmpty()) return emptyList()
        val sentences = sentenceSpans(text).flatMap { hardSplit(it, text, budget) }
        val result = ArrayList<TextSpan>()
        var i = 0
        while (i < sentences.size) {
            var j = i
            var end = sentences[i].end
            while (j + 1 < sentences.size) {
                val candidate = text.substring(sentences[i].start, sentences[j + 1].end)
                if (estimateTokens(candidate) > budget) break
                j++
                end = sentences[j].end
            }
            result.add(TextSpan(sentences[i].start, end))
            if (j + 1 >= sentences.size) break
            i = if (j > i) j else j + 1
        }
        return result.mapIndexed { index, span -> Chunk(index, span, text.substring(span.start, span.end)) }
    }

    /** Splits a chunk in two near the middle at whitespace (for `contextTooLong`). */
    fun halve(chunk: Chunk, fullText: String): List<Chunk> {
        val mid = chunk.span.start + (chunk.span.end - chunk.span.start) / 2
        var cut = mid
        while (cut > chunk.span.start + 1 && !(cut < fullText.length && Js.isWhitespace(fullText[cut]))) cut--
        if (cut <= chunk.span.start + 1) cut = mid
        if (cut < fullText.length && fullText[cut].code in 0xdc00..0xdfff) cut += 1
        if (cut <= chunk.span.start || cut >= chunk.span.end) return listOf(chunk)
        val a = TextSpan(chunk.span.start, cut)
        val b = TextSpan(cut, chunk.span.end)
        return listOf(
            Chunk(chunk.index, a, fullText.substring(a.start, a.end)),
            Chunk(chunk.index, b, fullText.substring(b.start, b.end)),
        )
    }
}
