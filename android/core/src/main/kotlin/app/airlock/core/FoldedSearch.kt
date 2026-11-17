package app.airlock.core

import java.text.Normalizer
import java.util.regex.Pattern

/**
 * Case-, diacritic- and width-insensitive, word-bounded search (port of foldedSearch.ts / FoldedSearch.swift),
 * shared by the Vault matcher (D1), the egress gate (G1/G2/G5) and the restore fidelity check.
 *
 * A hit never starts or ends inside a word — the character before and after must not be a letter, digit or
 * combining mark — so "Raj" matches "Raj's" but never "Rajesh". Whitespace in the needle matches any run of
 * whitespace. All spans are UTF-16 offsets into the *original* text.
 */
object FoldedSearch {
    /** Lowercased (unless `keepCase`), diacritic-stripped, width-folded form. */
    fun fold(s: String, keepCase: Boolean = false): String {
        val sb = StringBuilder(s.length)
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            val n = Character.charCount(cp)
            sb.append(foldChar(s.substring(i, minOf(s.length, i + n)), keepCase))
            i += n
        }
        return sb.toString()
    }

    // Per-code-unit memo for BMP characters (folding is a pure function of the character). Strings are immutable,
    // so a racy fill is safe.
    private val lowerCache = arrayOfNulls<String>(0x10000)
    private val keepCache = arrayOfNulls<String>(0x10000)

    private fun foldChar(ch: String, keepCase: Boolean): String {
        if (ch.length != 1) return foldUncached(ch, keepCase)
        val cache = if (keepCase) keepCache else lowerCache
        val code = ch[0].code
        return cache[code] ?: foldUncached(ch, keepCase).also { cache[code] = it }
    }

    private fun foldUncached(ch: String, keepCase: Boolean): String {
        val nfkd = Normalizer.normalize(ch, Normalizer.Form.NFKD)
        val sb = StringBuilder(nfkd.length)
        var i = 0
        while (i < nfkd.length) {
            val cp = nfkd.codePointAt(i)
            val n = Character.charCount(cp)
            if (!Js.isM(cp)) sb.append(nfkd, i, minOf(nfkd.length, i + n))
            i += n
        }
        val stripped = sb.toString()
        return if (keepCase) stripped else stripped.lowercase()
    }

    internal class Folded(val text: String, val starts: IntArray, val ends: IntArray)

    private fun foldWithMap(s: String, keepCase: Boolean): Folded {
        val text = StringBuilder(s.length)
        val starts = ArrayList<Int>(s.length)
        val ends = ArrayList<Int>(s.length)
        var off = 0
        while (off < s.length) {
            val cp = s.codePointAt(off)
            val n = minOf(Character.charCount(cp), s.length - off)
            val f = foldChar(s.substring(off, off + n), keepCase)
            repeat(f.length) {
                starts.add(off)
                ends.add(off + n)
            }
            text.append(f)
            off += n
        }
        return Folded(text.toString(), starts.toIntArray(), ends.toIntArray())
    }

    private fun isWordChar(cp: Int): Boolean = Js.isL(cp) || Js.isM(cp) || Js.isN(cp)

    /** True if the code point at UTF-16 `index` is outside the string or not part of a word. */
    fun isBoundary(text: String, index: Int): Boolean {
        if (index < 0 || index >= text.length) return true
        var i = index
        val unit = text[i]
        if (unit.code in 0xdc00..0xdfff && i > 0) {
            val prev = text[i - 1]
            if (prev.code in 0xd800..0xdbff) i -= 1
        }
        return !isWordChar(text.codePointAt(i))
    }

    /**
     * All non-overlapping hits of `needle` in `haystack`, left to right.
     * `caseSensitive` keeps diacritic/width folding but requires exact letter case (used by the gate's
     * name-token check so "Will" the name doesn't match "will" the verb).
     */
    fun ranges(needle: String, haystack: String, caseSensitive: Boolean = false): List<TextSpan> = ranges(needle, Haystack(haystack), caseSensitive)

    /** A haystack whose folded forms are computed once, for searching many needles (the gate checks hundreds of terms). */
    class Haystack(val text: String) {
        private var lower: Folded? = null
        private var keep: Folded? = null
        internal fun folded(caseSensitive: Boolean): Folded =
            if (caseSensitive) keep ?: foldWithMap(text, true).also { keep = it } else lower ?: foldWithMap(text, false).also { lower = it }
    }

    /** [ranges] over a prepared [Haystack]; results are identical. */
    fun ranges(needle: String, hay: Haystack, caseSensitive: Boolean = false): List<TextSpan> {
        val haystack = hay.text
        val tokens = Js.splitWhitespace(Js.trim(needle)).filter { it.isNotEmpty() }.map { fold(it, caseSensitive) }.filter { it.isNotEmpty() }
        if (tokens.isEmpty()) return emptyList()
        val re = Pattern.compile(tokens.joinToString(Js.WS + "+") { Pattern.quote(it) })
        val f = hay.folded(caseSensitive)
        val results = ArrayList<TextSpan>()
        val m = re.matcher(f.text)
        var searchStart = 0
        while (searchStart < f.text.length) {
            if (!m.find(searchStart)) break
            val fs = m.start()
            val fe = m.end()
            if (fe == fs) break
            if (fs >= f.starts.size || fe - 1 >= f.ends.size) break
            val start = f.starts[fs]
            val end = f.ends[fe - 1]
            if (isBoundary(haystack, start - 1) && isBoundary(haystack, end)) {
                results.add(TextSpan(start, end))
                searchStart = fe
            } else {
                searchStart = fs + 1
            }
        }
        return results
    }

    /** Whether `needle` occurs anywhere in `haystack` (word-bounded, folded). */
    fun contains(needle: String, haystack: String, caseSensitive: Boolean = false): Boolean = ranges(needle, haystack, caseSensitive).isNotEmpty()
}
