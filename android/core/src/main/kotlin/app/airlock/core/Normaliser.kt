package app.airlock.core

import java.text.BreakIterator
import java.text.Normalizer as JNormalizer
import java.util.Locale

/**
 * Text after normalisation, with a map back to the original (port of normaliser.ts / Normaliser.swift).
 * Guarantees `originalOffsets.size == text.length + 1`; the last element is the original length.
 */
data class NormalisedText(val text: String, val originalOffsets: List<Int>) {
    fun toOriginal(span: TextSpan): TextSpan {
        val last = originalOffsets.size - 1
        val start = originalOffsets.getOrNull(minOf(span.start, last)) ?: 0
        val end = originalOffsets.getOrNull(minOf(span.end, last)) ?: start
        return TextSpan(start, maxOf(start, end))
    }
}

/**
 * Stage 1 — per grapheme: strip zero-width/invisible characters, straighten smart quotes, NFKC, collapse
 * horizontal whitespace runs to one space, CRLF/CR → "\n". Idempotent (used by gate G6).
 */
object Normaliser {
    /** Maximum input accepted for sealing (≈ 15k words). */
    const val MAX_INPUT_UTF16 = 60_000

    private val INVISIBLE = setOf(
        0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
        0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
    )

    private val QUOTES = mapOf(
        0x2018 to "'", 0x2019 to "'", 0x201a to "'", 0x201b to "'", 0x2032 to "'", 0x02bc to "'",
        0x201c to "\"", 0x201d to "\"", 0x201e to "\"", 0x201f to "\"", 0x2033 to "\"",
    )

    private val NEWLINE_LIKE = setOf(0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029)

    private fun isHorizontalWhitespace(s: String): Boolean {
        if (s.isEmpty()) return false
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (!Js.isWhitespace(cp) || cp in NEWLINE_LIKE) return false
            i += Character.charCount(cp)
        }
        return true
    }

    fun normalise(input: String): NormalisedText {
        val out = StringBuilder(input.length)
        val offsets = ArrayList<Int>(input.length + 1)
        var lastWasSpace = false
        fun push(s: String, from: Int) {
            out.append(s)
            repeat(s.length) { offsets.add(from) }
        }

        val bi = BreakIterator.getCharacterInstance(Locale.ROOT)
        bi.setText(input)
        var at = bi.first()
        var next = bi.next()
        while (next != BreakIterator.DONE) {
            val segment = input.substring(at, next)
            val segStart = at
            at = next
            next = bi.next()

            if (segment == "\r\n" || segment == "\r" || segment == "\n") {
                push("\n", segStart)
                lastWasSpace = false
                continue
            }
            val cleaned = StringBuilder(segment.length)
            var i = 0
            while (i < segment.length) {
                val cp = segment.codePointAt(i)
                val n = Character.charCount(cp)
                if (cp !in INVISIBLE) cleaned.append(QUOTES[cp] ?: segment.substring(i, minOf(segment.length, i + n)))
                i += n
            }
            if (cleaned.isEmpty()) continue
            val nfkc = JNormalizer.normalize(cleaned, JNormalizer.Form.NFKC)
            if (isHorizontalWhitespace(nfkc)) {
                if (!lastWasSpace) {
                    push(" ", segStart)
                    lastWasSpace = true
                }
                continue
            }
            push(nfkc, segStart)
            lastWasSpace = false
        }
        offsets.add(input.length)
        return NormalisedText(out.toString(), offsets)
    }

    fun isNormalised(text: String): Boolean = normalise(text).text == text
}
