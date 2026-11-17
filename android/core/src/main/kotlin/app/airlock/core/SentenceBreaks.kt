package app.airlock.core

/**
 * UAX #29 sentence boundaries (rules SB1–SB998) — the rules ICU, and therefore `Intl.Segmenter` on the web, applies.
 * `java.text.BreakIterator` uses older, different rules (e.g. no break after a line feed), so the chunker uses this.
 * Sentence_Break values are derived from `Character` properties; the Sentence_Terminal list covers the BMP.
 */
internal object SentenceBreaks {
    private enum class SB { CR, LF, SEP, EXTEND, FORMAT, SP, LOWER, UPPER, OLETTER, NUMERIC, ATERM, SCONTINUE, STERM, CLOSE, OTHER }

    private val SCONTINUE = setOf(
        0x002c, 0x002d, 0x003a, 0x055d, 0x060c, 0x060d, 0x07f8, 0x1802, 0x1808, 0x2013, 0x2014, 0x3001, 0xfe10, 0xfe11, 0xfe13, 0xfe31, 0xfe32,
        0xfe50, 0xfe51, 0xfe55, 0xfe58, 0xfe63, 0xff0c, 0xff0d, 0xff1a, 0xff64,
    )
    private val STERM = setOf(
        0x0021, 0x003f, 0x0589, 0x061d, 0x061e, 0x061f, 0x06d4, 0x0700, 0x0701, 0x0702, 0x07f9, 0x0837, 0x0839, 0x083d, 0x083e, 0x0964, 0x0965,
        0x104a, 0x104b, 0x1362, 0x1367, 0x1368, 0x166e, 0x1735, 0x1736, 0x17d4, 0x17d5, 0x1803, 0x1809, 0x1944, 0x1945, 0x1aa8, 0x1aa9, 0x1aaa,
        0x1aab, 0x1b4e, 0x1b4f, 0x1b5a, 0x1b5b, 0x1b5e, 0x1b5f, 0x1b7d, 0x1b7e, 0x1c3b, 0x1c3c, 0x1c7e, 0x1c7f, 0x203c, 0x203d, 0x2047, 0x2048,
        0x2049, 0x2e2e, 0x2e3c, 0x2e53, 0x2e54, 0x3002, 0xa4ff, 0xa60e, 0xa60f, 0xa6f3, 0xa6f7, 0xa876, 0xa877, 0xa8ce, 0xa8cf, 0xa92f, 0xa9c8,
        0xa9c9, 0xaa5d, 0xaa5e, 0xaa5f, 0xaaf0, 0xaaf1, 0xabeb, 0xfe56, 0xfe57, 0xff01, 0xff1f, 0xff61,
    )
    private val QUOTATION = setOf(
        0x0022, 0x0027, 0x275b, 0x275c, 0x275d, 0x275e, 0x275f, 0x2760, 0x2e00, 0x2e01, 0x2e02, 0x2e03, 0x2e04, 0x2e05, 0x2e06, 0x2e07, 0x2e08,
        0x2e09, 0x2e0a, 0x2e0b, 0x2e0c, 0x2e0d, 0x2e1c, 0x2e1d, 0x2e20, 0x2e21, 0x1f676, 0x1f677, 0x1f678,
    )

    private fun prop(cp: Int): SB {
        val t = Character.getType(cp)
        return when {
            cp == 0x0d -> SB.CR
            cp == 0x0a -> SB.LF
            cp == 0x85 || cp == 0x2028 || cp == 0x2029 -> SB.SEP
            t == Character.NON_SPACING_MARK.toInt() || t == Character.ENCLOSING_MARK.toInt() || t == Character.COMBINING_SPACING_MARK.toInt() ||
                cp == 0x200c || cp == 0x200d || cp == 0xff9e || cp == 0xff9f || cp in 0x1f3fb..0x1f3ff || cp in 0xe0020..0xe007f -> SB.EXTEND
            t == Character.FORMAT.toInt() -> SB.FORMAT
            cp == 0x09 || cp == 0x0b || cp == 0x0c || cp == 0x20 || cp == 0xa0 || cp == 0x1680 || cp in 0x2000..0x200a || cp == 0x202f ||
                cp == 0x205f || cp == 0x3000 -> SB.SP
            Character.isLowerCase(cp) -> SB.LOWER
            Character.isUpperCase(cp) || Character.isTitleCase(cp) -> SB.UPPER
            Character.isAlphabetic(cp) || cp == 0x05f3 -> SB.OLETTER
            t == Character.DECIMAL_DIGIT_NUMBER.toInt() || cp == 0x066b || cp == 0x066c -> SB.NUMERIC
            cp == 0x2e || cp == 0x2024 || cp == 0xfe52 || cp == 0xff0e -> SB.ATERM
            cp in SCONTINUE -> SB.SCONTINUE
            cp in STERM -> SB.STERM
            t == Character.START_PUNCTUATION.toInt() || t == Character.END_PUNCTUATION.toInt() || t == Character.INITIAL_QUOTE_PUNCTUATION.toInt() ||
                t == Character.FINAL_QUOTE_PUNCTUATION.toInt() || cp in QUOTATION -> SB.CLOSE
            else -> SB.OTHER
        }
    }

    private fun isParaSep(p: SB?) = p == SB.SEP || p == SB.CR || p == SB.LF
    private fun isSATerm(p: SB?) = p == SB.ATERM || p == SB.STERM

    /** UTF-16 offsets where a new sentence starts (strictly inside `text`, ascending). */
    fun boundaries(text: String): List<Int> {
        val offs = ArrayList<Int>()
        val props = ArrayList<SB>()
        var k = 0
        while (k < text.length) {
            val cp = text.codePointAt(k)
            offs.add(k)
            props.add(prop(cp))
            k += Character.charCount(cp)
        }
        val n = props.size
        // SB5: X (Extend | Format)* → X — absorbed characters are null; X is anything but sot and ParaSep.
        val eff = arrayOfNulls<SB>(n)
        var base: SB? = null
        for (i in 0 until n) {
            val p = props[i]
            if ((p == SB.EXTEND || p == SB.FORMAT) && base != null && !isParaSep(base)) {
                eff[i] = null
            } else {
                eff[i] = p
                base = p
            }
        }
        val out = ArrayList<Int>()
        for (i in 1 until n) {
            val prev = props[i - 1]
            if (prev == SB.CR && props[i] == SB.LF) continue // SB3
            if (isParaSep(prev)) { out.add(offs[i]); continue } // SB4
            if (eff[i] == null) continue // SB5
            if (breaksBefore(eff, i)) out.add(offs[i])
        }
        return out
    }

    /** SB6–SB11 at the boundary before index `i` (not absorbed). */
    private fun breaksBefore(eff: Array<SB?>, i: Int): Boolean {
        val cur = eff[i]
        // Walk back over effective characters: Sp*, then Close*, then (S|A)Term.
        var j = i - 1
        fun prevIndex(from: Int): Int {
            var x = from
            while (x >= 0 && eff[x] == null) x--
            return x
        }
        j = prevIndex(j)
        if (j < 0) return false
        val p1 = eff[j]
        if (p1 == SB.ATERM && cur == SB.NUMERIC) return false // SB6
        if (p1 == SB.ATERM && cur == SB.UPPER) { // SB7
            val j2 = prevIndex(j - 1)
            if (j2 >= 0 && (eff[j2] == SB.UPPER || eff[j2] == SB.LOWER)) return false
        }
        var sp = 0
        while (j >= 0 && eff[j] == SB.SP) { sp++; j = prevIndex(j - 1) }
        while (j >= 0 && eff[j] == SB.CLOSE) j = prevIndex(j - 1)
        if (j < 0 || !isSATerm(eff[j])) return false // SB998: no terminator, no break
        val term = eff[j]
        if (term == SB.ATERM) { // SB8
            var f = i
            while (f < eff.size) {
                val p = eff[f]
                if (p != null && (p == SB.OLETTER || p == SB.UPPER || p == SB.LOWER || isParaSep(p) || isSATerm(p))) break
                f++
            }
            if (f < eff.size && eff[f] == SB.LOWER) return false
        }
        if (cur == SB.SCONTINUE || isSATerm(cur)) return false // SB8a
        if (sp == 0 && (cur == SB.CLOSE || cur == SB.SP || isParaSep(cur))) return false // SB9
        if (cur == SB.SP || isParaSep(cur)) return false // SB10
        return true // SB11
    }
}
