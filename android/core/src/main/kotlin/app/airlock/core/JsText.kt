// JavaScript string and regex semantics, so the Kotlin engine matches web/src/engine byte-for-byte.
// The TypeScript uses JS `\s` (Unicode whitespace), ASCII `\d`/`\w`/`\b`, `\p{…}` general categories,
// `String.prototype.trim`, `split(/\s+/u)` and `JSON.parse`; this file gives exact equivalents.
package app.airlock.core

import java.util.regex.Pattern

/** Helpers reproducing ECMAScript text semantics on the JVM. Pure functions; no state. */
object Js {
    /** ECMAScript `\s`: WhiteSpace (TAB, VT, FF, ZWNBSP, any Zs) plus LineTerminator. */
    fun isWhitespace(cp: Int): Boolean = when (cp) {
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff -> true
        else -> cp in 0x2000..0x200a
    }

    fun isWhitespace(c: Char): Boolean = isWhitespace(c.code)

    /** Body of a regex character class equal to JS `\s` (for use inside `[...]`). */
    const val WS_CLASS_BODY = "\\x{09}-\\x{0D}\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}"
    const val WS = "[$WS_CLASS_BODY]"

    /** `String.prototype.trim`. */
    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isWhitespace(s[a])) a++
        while (b > a && isWhitespace(s[b - 1])) b--
        return s.substring(a, b)
    }

    /** `s.split(/\s+/u)` — keeps a leading/trailing empty piece exactly like JS. */
    fun splitWhitespace(s: String): List<String> {
        val out = ArrayList<String>()
        var start = 0
        var i = 0
        while (i < s.length) {
            if (isWhitespace(s[i])) {
                var j = i
                while (j < s.length && isWhitespace(s[j])) j++
                out.add(s.substring(start, i))
                start = j
                i = j
            } else i++
        }
        out.add(s.substring(start))
        return out
    }

    /** `s.split(/\s+/u).filter(Boolean)`. */
    fun words(s: String): List<String> = splitWhitespace(s).filter { it.isNotEmpty() }

    /** `[...s].length`. */
    fun codePointLength(s: String): Int = s.codePointCount(0, s.length)

    /** `[...s]` — one string per code point. */
    fun codePoints(s: String): List<String> {
        val out = ArrayList<String>(s.length)
        var i = 0
        while (i < s.length) {
            val n = Character.charCount(s.codePointAt(i))
            out.add(s.substring(i, minOf(s.length, i + n)))
            i += n
        }
        return out
    }

    fun isL(cp: Int): Boolean = Character.isLetter(cp)
    fun isLu(cp: Int): Boolean = Character.getType(cp) == Character.UPPERCASE_LETTER.toInt()
    fun isM(cp: Int): Boolean = when (Character.getType(cp)) {
        Character.NON_SPACING_MARK.toInt(), Character.ENCLOSING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt() -> true
        else -> false
    }
    fun isN(cp: Int): Boolean = when (Character.getType(cp)) {
        Character.DECIMAL_DIGIT_NUMBER.toInt(), Character.LETTER_NUMBER.toInt(), Character.OTHER_NUMBER.toInt() -> true
        else -> false
    }
    fun isP(cp: Int): Boolean = when (Character.getType(cp)) {
        Character.CONNECTOR_PUNCTUATION.toInt(), Character.DASH_PUNCTUATION.toInt(), Character.START_PUNCTUATION.toInt(),
        Character.END_PUNCTUATION.toInt(), Character.INITIAL_QUOTE_PUNCTUATION.toInt(), Character.FINAL_QUOTE_PUNCTUATION.toInt(),
        Character.OTHER_PUNCTUATION.toInt() -> true
        else -> false
    }
    fun isS(cp: Int): Boolean = when (Character.getType(cp)) {
        Character.MATH_SYMBOL.toInt(), Character.CURRENCY_SYMBOL.toInt(), Character.MODIFIER_SYMBOL.toInt(), Character.OTHER_SYMBOL.toInt() -> true
        else -> false
    }

    /** True if any code point of `s` satisfies `p` (JS `/\p{…}/u.test(s)`). */
    inline fun any(s: String, p: (Int) -> Boolean): Boolean {
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (p(cp)) return true
            i += Character.charCount(cp)
        }
        return false
    }

    /** True if every code point of a non-empty `s` satisfies `p` (JS `/^\p{…}+$/u.test(s)`). */
    inline fun all(s: String, p: (Int) -> Boolean): Boolean {
        if (s.isEmpty()) return false
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (!p(cp)) return false
            i += Character.charCount(cp)
        }
        return true
    }

    /** Removes leading and trailing code points matching `p` (JS `s.replace(/^[…]+|[…]+$/gu, "")`). */
    inline fun trimWhere(s: String, p: (Int) -> Boolean): String {
        var a = 0
        while (a < s.length) {
            val cp = s.codePointAt(a)
            if (!p(cp)) break
            a += Character.charCount(cp)
        }
        var b = s.length
        while (b > a) {
            val cp = s.codePointBefore(b)
            if (!p(cp)) break
            b -= Character.charCount(cp)
        }
        return s.substring(a, b)
    }

    /**
     * Compiles a JavaScript regex source (as written for `new RegExp(src, "u")`) to an equivalent Java pattern:
     * `\s`/`\S` become the JS whitespace class, `.` excludes only JS line terminators, `$` means end of input,
     * and an unescaped `[` inside a class is literal. `\d`, `\w` and `\b` are ASCII in both engines (JDK 19+).
     */
    fun pattern(src: String, ignoreCase: Boolean = false): Pattern = Pattern.compile(JsRegexTranslator(src, ignoreCase).translate())

    /**
     * Rewrites JS regex syntax so nothing is left to Java's differing defaults: `\s` is the JS whitespace set;
     * `\d`/`\w`/`\b` are ASCII (Java's `\b` treats a combining mark after a letter as a word character); and
     * `ignoreCase` is JS `iu` simple case folding spelled out for ASCII letters (`ſ`≡`s`, Kelvin `K`≡`k`, but Turkish
     * `İ`/`ı` never match `i`/`I` as they would with Java's `UNICODE_CASE`). Every class literal is emitted as `\x{…}`.
     */
    private class JsRegexTranslator(val src: String, val ignoreCase: Boolean) {
        private var i = 0
        private val out = StringBuilder(src.length * 2)
        private val wordBody = "A-Za-z0-9_" + if (ignoreCase) "\\x{17f}\\x{212a}" else ""

        private fun hex(cp: Int) = "\\x{" + Integer.toHexString(cp) + "}"

        /** Code points JS `iu` folds together with `cp` (only ASCII letters may appear in case-insensitive sources). */
        private fun variants(cp: Int): List<Int> {
            if (!ignoreCase) return emptyList()
            require(!(cp > 0x7f && Character.toUpperCase(cp) != Character.toLowerCase(cp))) { "non-ASCII cased letter in a case-insensitive source" }
            val v = ArrayList<Int>(3)
            if (cp in 'a'.code..'z'.code) v.add(cp - 32)
            if (cp in 'A'.code..'Z'.code) v.add(cp + 32)
            if (cp == 's'.code || cp == 'S'.code) v.add(0x17f)
            if (cp == 'k'.code || cp == 'K'.code) v.add(0x212a)
            return v
        }

        /** Reads the rest of `\p{…}`, `\x{…}`, `\u{…}`, `\uXXXX` or `\xXX` verbatim (the backslash and letter are consumed). */
        private fun braced(letter: Char): String {
            val sb = StringBuilder("\\").append(letter)
            if (i < src.length && src[i] == '{') {
                val close = src.indexOf('}', i)
                require(close > 0) { "unterminated escape" }
                sb.append(src, i, close + 1)
                i = close + 1
            } else {
                val n = if (letter == 'u') 4 else if (letter == 'x') 2 else 0
                require(i + n <= src.length) { "short escape" }
                sb.append(src, i, i + n)
                i += n
            }
            return sb.toString()
        }

        fun translate(): String {
            while (i < src.length) {
                val c = src[i]
                when {
                    c == '\\' -> escapeOutside()
                    c == '[' -> { i++; charClass() }
                    c == '.' -> { out.append("[^\\n\\r\\x{2028}\\x{2029}]"); i++ }
                    c == '$' -> { out.append("\\z"); i++ }
                    c == '(' && src.startsWith("(?<", i) && i + 3 < src.length && src[i + 3].isLetter() -> {
                        val close = src.indexOf('>', i)
                        require(close > 0) { "bad group name" }
                        out.append(src, i, close + 1)
                        i = close + 1
                    }
                    else -> {
                        val cp = src.codePointAt(i)
                        i += Character.charCount(cp)
                        val v = variants(cp)
                        if (v.isEmpty()) out.appendCodePoint(cp)
                        else {
                            out.append('[').append(hex(cp))
                            v.forEach { out.append(hex(it)) }
                            out.append(']')
                        }
                    }
                }
            }
            return out.toString()
        }

        private fun escapeOutside() {
            require(i + 1 < src.length) { "trailing backslash" }
            val n = src[i + 1]
            i += 2
            when (n) {
                's' -> out.append(WS)
                'S' -> out.append("[^").append(WS_CLASS_BODY).append(']')
                'd' -> out.append("[0-9]")
                'D' -> out.append("[^0-9]")
                'w' -> out.append('[').append(wordBody).append(']')
                'W' -> out.append("[^").append(wordBody).append(']')
                'b' -> out.append("(?:(?<=[$wordBody])(?![$wordBody])|(?<![$wordBody])(?=[$wordBody]))")
                'B' -> out.append("(?:(?<=[$wordBody])(?=[$wordBody])|(?<![$wordBody])(?![$wordBody]))")
                'p', 'P', 'x', 'u' -> out.append(braced(n))
                'n' -> out.append("\\n")
                'r' -> out.append("\\r")
                't' -> out.append("\\t")
                'f' -> out.append("\\f")
                'v' -> out.append(hex(0x0b))
                'k' -> {
                    val close = src.indexOf('>', i)
                    require(close > 0) { "bad backreference" }
                    out.append("\\k").append(src, i, close + 1)
                    i = close + 1
                }
                in '1'..'9' -> out.append('\\').append(n)
                else -> {
                    require(!n.isLetterOrDigit()) { "unsupported escape \\$n" }
                    out.append(hex(n.code))
                }
            }
        }

        /** Translates a class body (after `[`). */
        private fun charClass() {
            val body = StringBuilder()
            var negated = false
            if (i < src.length && src[i] == '^') { negated = true; i++ }
            while (true) {
                require(i < src.length) { "unterminated class" }
                if (src[i] == ']') { i++; break }
                val lo = classAtom(body) ?: continue
                if (i + 1 < src.length && src[i] == '-' && src[i + 1] != ']') {
                    i++
                    val before = body.length
                    val hi = classAtom(body)
                    require(hi != null && before == body.length && hi >= lo) { "bad class range" }
                    body.append(hex(lo)).append('-').append(hex(hi))
                    for (cp in lo..hi) variants(cp).forEach { body.append(hex(it)) }
                } else {
                    body.append(hex(lo))
                    variants(lo).forEach { body.append(hex(it)) }
                }
            }
            out.append('[')
            if (negated) out.append('^')
            out.append(body).append(']')
        }

        /** One class atom: its code point, or null after appending a class escape (`\s`, `\d`, `\w`, `\p{…}`) to `body`. */
        private fun classAtom(body: StringBuilder): Int? {
            if (src[i] != '\\') {
                val cp = src.codePointAt(i)
                i += Character.charCount(cp)
                return cp
            }
            require(i + 1 < src.length) { "trailing backslash" }
            val n = src[i + 1]
            i += 2
            return when (n) {
                's' -> { body.append(WS_CLASS_BODY); null }
                'd' -> { body.append("0-9"); null }
                'w' -> { body.append(wordBody); null }
                'p', 'P' -> { body.append(braced(n)); null }
                'n' -> 0x0a
                'r' -> 0x0d
                't' -> 0x09
                'f' -> 0x0c
                'v' -> 0x0b
                'b' -> 0x08
                'x', 'u' -> braced(n).substring(2).trim('{', '}').toInt(16)
                else -> {
                    require(!n.isLetterOrDigit()) { "unsupported class escape \\$n" }
                    n.code
                }
            }
        }
    }

    /** `JSON.stringify(s)` for a string: minimal escaping, lone surrogates as `\uXXXX`. */
    fun quote(s: String): String {
        val sb = StringBuilder(s.length + 2)
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000c' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\u").append(String.format("%04x", c.code))
                Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { sb.append(c).append(s[i + 1]); i++ }
                Character.isSurrogate(c) -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
        return sb.toString()
    }

    /** UTF-8 bytes like `TextEncoder`: lone surrogates become U+FFFD. */
    fun utf8(s: String): ByteArray {
        val out = java.io.ByteArrayOutputStream(s.length + 8)
        var i = 0
        while (i < s.length) {
            val c = s[i]
            var cp = c.code
            if (Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) {
                cp = Character.toCodePoint(c, s[i + 1]); i++
            } else if (Character.isSurrogate(c)) cp = 0xfffd
            when {
                cp < 0x80 -> out.write(cp)
                cp < 0x800 -> { out.write(0xc0 or (cp shr 6)); out.write(0x80 or (cp and 0x3f)) }
                cp < 0x10000 -> { out.write(0xe0 or (cp shr 12)); out.write(0x80 or ((cp shr 6) and 0x3f)); out.write(0x80 or (cp and 0x3f)) }
                else -> {
                    out.write(0xf0 or (cp shr 18)); out.write(0x80 or ((cp shr 12) and 0x3f))
                    out.write(0x80 or ((cp shr 6) and 0x3f)); out.write(0x80 or (cp and 0x3f))
                }
            }
            i++
        }
        return out.toByteArray()
    }

    /** `Math.round` (half toward +∞). */
    fun round(x: Double): Long = Math.round(x)
}

/** Thrown by [JsJson.parse] on input `JSON.parse` would reject. Carries no input text (INV-8). */
class JsonSyntaxError(message: String) : Exception(message)

/**
 * A strict parser with exactly `JSON.parse`'s grammar (RFC 8259; duplicate keys: last wins). Values are
 * `null`, `Boolean`, `Double`, `String`, `List<Any?>` and `Map<String, Any?>` (insertion-ordered).
 */
object JsJson {
    fun parse(s: String): Any? {
        val p = Parser(s)
        p.ws()
        val v = p.value()
        p.ws()
        if (p.i != s.length) throw JsonSyntaxError("unexpected trailing input")
        return v
    }

    private class Parser(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }
        fun fail(): Nothing = throw JsonSyntaxError("invalid JSON at $i")

        fun value(): Any? {
            if (i >= s.length) fail()
            return when (s[i]) {
                '{' -> obj()
                '[' -> arr()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> num()
            }
        }

        fun lit(word: String, v: Any?): Any? {
            if (!s.startsWith(word, i)) fail()
            i += word.length
            return v
        }

        fun obj(): Map<String, Any?> {
            val m = LinkedHashMap<String, Any?>()
            i++
            ws()
            if (i < s.length && s[i] == '}') { i++; return m }
            while (true) {
                ws()
                if (i >= s.length || s[i] != '"') fail()
                val k = str()
                ws()
                if (i >= s.length || s[i] != ':') fail()
                i++
                ws()
                m[k] = value()
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    '}' -> { i++; return m }
                    else -> fail()
                }
            }
        }

        fun arr(): List<Any?> {
            val a = ArrayList<Any?>()
            i++
            ws()
            if (i < s.length && s[i] == ']') { i++; return a }
            while (true) {
                ws()
                a.add(value())
                ws()
                if (i >= s.length) fail()
                when (s[i]) {
                    ',' -> i++
                    ']' -> { i++; return a }
                    else -> fail()
                }
            }
        }

        fun str(): String {
            val sb = StringBuilder()
            i++
            while (true) {
                if (i >= s.length) fail()
                val c = s[i]
                when {
                    c == '"' -> { i++; return sb.toString() }
                    c == '\\' -> {
                        if (i + 1 >= s.length) fail()
                        when (s[i + 1]) {
                            '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                            'b' -> sb.append('\b'); 'f' -> sb.append('\u000c'); 'n' -> sb.append('\n')
                            'r' -> sb.append('\r'); 't' -> sb.append('\t')
                            'u' -> {
                                if (i + 6 > s.length) fail()
                                val hex = s.substring(i + 2, i + 6)
                                if (!hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) fail()
                                sb.append(hex.toInt(16).toChar())
                                i += 4
                            }
                            else -> fail()
                        }
                        i += 2
                    }
                    c.code < 0x20 -> fail()
                    else -> { sb.append(c); i++ }
                }
            }
        }

        fun num(): Double {
            val start = i
            if (i < s.length && s[i] == '-') i++
            if (i >= s.length) fail()
            if (s[i] == '0') i++
            else if (s[i] in '1'..'9') { while (i < s.length && s[i] in '0'..'9') i++ }
            else fail()
            if (i < s.length && s[i] == '.') {
                i++
                if (i >= s.length || s[i] !in '0'..'9') fail()
                while (i < s.length && s[i] in '0'..'9') i++
            }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                if (i >= s.length || s[i] !in '0'..'9') fail()
                while (i < s.length && s[i] in '0'..'9') i++
            }
            return s.substring(start, i).toDouble()
        }
    }
}
