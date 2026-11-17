package app.airlock.core

/** A checksum or plausibility check on a matched value. */
typealias Validator = (String) -> Boolean

/**
 * Checksum and plausibility validators (port of validators.ts / Validators.swift). Pure functions,
 * pinned by spec/fixtures/validators.json.
 */
object Validators {
    private fun isDigit(c: String): Boolean = c.length == 1 && c[0] in '0'..'9'
    private fun digitsOf(s: String): String = Js.codePoints(s).filter(::isDigit).joinToString("")

    fun luhn(s: String): Boolean {
        val cs = Js.codePoints(s)
        val digits = cs.filter(::isDigit).map { it[0] - '0' }
        val nonSeparators = cs.count { !(it.length == 1 && Js.isWhitespace(it[0])) && it != "-" }
        if (digits.size < 2 || digits.size != nonSeparators) return false
        var sum = 0
        digits.reversed().forEachIndexed { i, d ->
            if (i % 2 == 1) {
                val dd = d * 2
                sum += if (dd > 9) dd - 9 else dd
            } else sum += d
        }
        return sum % 10 == 0
    }

    fun card(s: String): Boolean {
        val digits = digitsOf(s)
        if (digits.length < 13 || digits.length > 19 || digits.toSet().size <= 1) return false
        return luhn(s)
    }

    private val ALNUM_UPPER = Regex("^[A-Z0-9]+$")
    private val IBAN_HEAD = Regex("^[A-Z]{2}[0-9]{2}")

    private fun stripWhitespace(s: String): String = buildString { for (c in s) if (!Js.isWhitespace(c)) append(c) }

    fun iban(s: String): Boolean {
        val compact = stripWhitespace(s.uppercase())
        if (compact.length < 15 || compact.length > 34 || !ALNUM_UPPER.matches(compact)) return false
        if (IBAN_HEAD.find(compact)?.range?.first != 0) return false
        val rearranged = compact.substring(4) + compact.substring(0, 4)
        var remainder = 0
        for (c in rearranged) {
            remainder = if (c in '0'..'9') (remainder * 10 + (c - '0')) % 97 else (remainder * 100 + (c.code - 55)) % 97
        }
        return remainder == 1
    }

    private val ALL_DIGITS = Regex("^[0-9]+$")

    fun ssn(s: String): Boolean {
        val parts = s.split("-").filter { it.isNotEmpty() }
        if (parts.size != 3 || parts[0].length != 3 || parts[1].length != 2 || parts[2].length != 4) return false
        if (!parts.all { ALL_DIGITS.matches(it) }) return false
        val (area, group, serial) = parts.map { it.toInt() }
        return area != 0 && area != 666 && area < 900 && group != 0 && serial != 0
    }

    private val NI_INVALID = setOf("BG", "GB", "NK", "KN", "TN", "NT", "ZZ")

    fun ukNI(s: String): Boolean {
        val compact = stripWhitespace(s.uppercase())
        if (compact.length != 9) return false
        return compact.substring(0, 2) !in NI_INVALID && compact[1] != 'O'
    }

    private val VD = arrayOf(
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), intArrayOf(1, 2, 3, 4, 0, 6, 7, 8, 9, 5), intArrayOf(2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
        intArrayOf(3, 4, 0, 1, 2, 8, 9, 5, 6, 7), intArrayOf(4, 0, 1, 2, 3, 9, 5, 6, 7, 8), intArrayOf(5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
        intArrayOf(6, 5, 9, 8, 7, 1, 0, 4, 3, 2), intArrayOf(7, 6, 5, 9, 8, 2, 1, 0, 4, 3), intArrayOf(8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
        intArrayOf(9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
    )
    private val VP = arrayOf(
        intArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9), intArrayOf(1, 5, 7, 6, 2, 8, 3, 0, 9, 4), intArrayOf(5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
        intArrayOf(8, 9, 1, 6, 0, 4, 3, 5, 2, 7), intArrayOf(9, 4, 5, 3, 1, 2, 6, 8, 7, 0), intArrayOf(4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
        intArrayOf(2, 7, 9, 3, 8, 0, 6, 4, 1, 5), intArrayOf(7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
    )

    fun verhoeff(s: String): Boolean {
        val digits = Js.codePoints(s).filter(::isDigit).map { it[0] - '0' }
        if (digits.isEmpty()) return false
        var c = 0
        digits.reversed().forEachIndexed { i, d -> c = VD[c][VP[i % 8][d]] }
        return c == 0
    }

    fun aadhaar(s: String): Boolean {
        val digits = digitsOf(s)
        return digits.length == 12 && digits[0] - '0' >= 2 && verhoeff(digits)
    }

    fun pan(s: String): Boolean {
        val c = s.uppercase()
        return c.length == 10 && "PCHFATBLJG".contains(c[3])
    }

    fun shannonEntropy(s: String): Double {
        if (s.isEmpty()) return 0.0
        val counts = LinkedHashMap<String, Int>()
        val cs = Js.codePoints(s)
        for (c in cs) counts[c] = (counts[c] ?: 0) + 1
        var h = 0.0
        for (k in counts.values) {
            val p = k.toDouble() / cs.size
            h -= p * JsMath.log2(p)
        }
        return h
    }

    private val ISO_DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val NUM_DATE = Regex("^\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}$")

    fun phone(s: String): Boolean {
        val n = digitsOf(s).length
        if (n < 7 || n > 15) return false
        return !(ISO_DATE.matches(s) || NUM_DATE.matches(s))
    }

    fun hasDigit(s: String): Boolean = Js.codePoints(s).any(::isDigit)
    fun plate(s: String): Boolean = hasDigit(s) && Js.any(s, Js::isL)
    fun entropySecret(s: String): Boolean = Js.codePointLength(s) >= 24 && Js.any(s, Js::isL) && hasDigit(s) && shannonEntropy(s) >= 3.5

    private val PROFILE_HOSTS = listOf(
        "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com", "tiktok.com", "github.com", "youtube.com", "threads.net",
        "reddit.com", "t.me", "wa.me", "venmo.com", "cash.app",
    )
    private val IDENTIFYING = listOf(
        "id=", "uid", "user", "token", "account", "acct", "profile", "member", "session", "invite", "reset", "email=", "phone=", "/u/", "/in/", "/@", "ref=",
    )

    private fun isPathSep(c: Char) = c == '/' || c == '?' || c == '#'

    /** URL that points at a person or carries identifiers; bare domains and generic paths are not identifying. */
    fun urlIdentifying(s: String): Boolean {
        var rest = s.lowercase()
        for (scheme in listOf("https://", "http://")) if (rest.startsWith(scheme)) rest = rest.substring(scheme.length)
        val cut = rest.indexOfFirst(::isPathSep)
        val host = (if (cut >= 0) rest.substring(0, cut) else rest).replace("www.", "")
        val path = if (cut >= 0) rest.substring(cut) else ""
        val meaningful = path.trimStart(::isPathSep).trimEnd(::isPathSep)
        if (PROFILE_HOSTS.any { host == it || host.endsWith(".$it") } && meaningful.isNotEmpty()) return true
        if (IDENTIFYING.any { path.contains(it) }) return true
        return splitNonWord(path).any { it.length >= 8 && hasDigit(it) }
    }

    /** `s.split(/[^\p{L}\p{N}]+/u)` (the empty pieces don't matter to the caller). */
    private fun splitNonWord(s: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            val n = Character.charCount(cp)
            if (Js.isL(cp) || Js.isN(cp)) cur.append(s, i, minOf(s.length, i + n))
            else if (cur.isNotEmpty()) { out.add(cur.toString()); cur.setLength(0) }
            i += n
        }
        out.add(cur.toString())
        return out
    }

    /** Looks up a validator by the name used in pattern packs and fixtures. */
    fun named(name: String): Validator? = when (name) {
        "luhn" -> ::luhn
        "card" -> ::card
        "iban" -> ::iban
        "ssn" -> ::ssn
        "uk_ni" -> ::ukNI
        "verhoeff" -> ::verhoeff
        "aadhaar" -> ::aadhaar
        "pan" -> ::pan
        "phone" -> ::phone
        "has_digit" -> ::hasDigit
        "plate" -> ::plate
        "entropy_secret" -> ::entropySecret
        "url_identifying" -> ::urlIdentifying
        else -> null
    }
}

/** `Math.log2` exactly as V8 computes it (a port of FreeBSD msun `e_log2.c`, which V8's ieee754::log2 is). */
object JsMath {
    private const val TWO54 = 1.80143985094819840000e+16
    private const val IVLN2HI = 1.44269504072144627571e+00
    private const val IVLN2LO = 1.67517131648865118353e-10
    private const val LG1 = 6.666666666666735130e-01
    private const val LG2 = 3.999999999940941908e-01
    private const val LG3 = 2.857142874366239149e-01
    private const val LG4 = 2.222219843214978396e-01
    private const val LG5 = 1.818357216161805012e-01
    private const val LG6 = 1.531383769920937332e-01
    private const val LG7 = 1.479819860511658591e-01

    private fun kLog1p(f: Double): Double {
        val s = f / (2.0 + f)
        val z = s * s
        val w = z * z
        val t1 = w * (LG2 + w * (LG4 + w * LG6))
        val t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)))
        val r = t2 + t1
        val hfsq = 0.5 * f * f
        return s * (hfsq + r)
    }

    fun log2(input: Double): Double {
        var x = input
        var bits = java.lang.Double.doubleToRawLongBits(x)
        var hx = (bits ushr 32).toInt()
        val lx = bits.toInt()
        var k = 0
        if (hx < 0x00100000) {
            if (((hx and 0x7fffffff) or lx) == 0) return Double.NEGATIVE_INFINITY
            if (hx < 0) return Double.NaN
            k -= 54
            x *= TWO54
            bits = java.lang.Double.doubleToRawLongBits(x)
            hx = (bits ushr 32).toInt()
        }
        if (hx >= 0x7ff00000) return x + x
        if (hx == 0x3ff00000 && lx == 0) return 0.0
        k += (hx shr 20) - 1023
        hx = hx and 0x000fffff
        val i = (hx + 0x95f64) and 0x100000
        x = withHigh(x, hx or (i xor 0x3ff00000))
        k += i shr 20
        val y = k.toDouble()
        val f = x - 1.0
        val hfsq = 0.5 * f * f
        val r = kLog1p(f)
        var hi = f - hfsq
        hi = java.lang.Double.longBitsToDouble(java.lang.Double.doubleToRawLongBits(hi) and -0x100000000L)
        val lo = (f - hi) - hfsq + r
        var valHi = hi * IVLN2HI
        var valLo = (lo + hi) * IVLN2LO + lo * IVLN2HI
        val w = y + valHi
        valLo += (y - w) + valHi
        valHi = w
        return valLo + valHi
    }

    private fun withHigh(x: Double, high: Int): Double {
        val low = java.lang.Double.doubleToRawLongBits(x) and 0xffffffffL
        return java.lang.Double.longBitsToDouble((high.toLong() shl 32) or low)
    }
}
