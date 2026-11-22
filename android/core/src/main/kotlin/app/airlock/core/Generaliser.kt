package app.airlock.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Generalisation ladder and rewrite validation (port of generaliser.ts). Dates are parsed like Swift's
 * `DateFormatter` (en_US_POSIX, UTC, non-lenient); all date maths is in UTC.
 */
object Generaliser {
    const val MAX_WORDS = 8
    private const val DAY_MS = 86_400_000L

    /** Swift's `.rounded()` — half away from zero. */
    private fun roundHalfAway(x: Double): Double = Math.signum(x) * Js.round(Math.abs(x)).toDouble()

    private val MONTHS = listOf("january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december")

    private fun monthIndex(name: String): Int? {
        val n = name.lowercase()
        val full = MONTHS.indexOf(n)
        if (full >= 0) return full
        val abbr = MONTHS.indexOfFirst { it.substring(0, 3) == n }
        return if (n.length == 3 && abbr >= 0) abbr else null
    }

    /** Epoch millis of a valid UTC calendar date (`month` 0-based), or null. Years 0–99 are invalid, as with JS `Date.UTC`. */
    private fun validDate(y: Int, m: Int, d: Int): Long? {
        if (m < 0 || m > 11 || d < 1 || d > 31) return null
        if (y in 0..99) return null
        return try {
            LocalDate.of(y, m + 1, d).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        } catch (_: java.time.DateTimeException) {
            null
        }
    }

    private fun utc(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC)

    /** Two-digit years map into [today − 80, today + 20] like DateFormatter's `yy`. */
    private fun expandYear(yy: Int, today: Instant): Int {
        val current = today.atZone(ZoneOffset.UTC).year
        var year = (current / 100) * 100 + yy
        if (year > current + 20) year -= 100 else if (year < current - 80) year += 100
        return year
    }

    private val ORDINAL = Js.pattern("(\\d)(st|nd|rd|th)\\b")
    private val NUMERIC = Regex("(\\d{1,2})([/-])(\\d{1,2})\\2(\\d{4}|\\d{2})")
    private val ISO = Regex("(\\d{4})-(\\d{1,2})-(\\d{1,2})")
    private val D_M_Y = Regex("(\\d{1,2}) ([A-Za-z]+) (\\d{4})")
    private val M_D_Y = Regex("([A-Za-z]+) (\\d{1,2}) (\\d{4})")
    private val M_D = Regex("([A-Za-z]+) (\\d{1,2})")
    private val D_M = Regex("(\\d{1,2}) ([A-Za-z]+)")

    /** Parses the date forms the detectors produce; null if not a real date. Returns a UTC instant at midnight. */
    fun parseDate(raw: String, today: Instant): Instant? {
        val s = Js.words(ORDINAL.matcher(raw.replace(",", " ").replace(".", " ")).replaceAll("$1")).joinToString(" ")
        NUMERIC.matchEntire(s)?.let { m ->
            val a = m.groupValues[1].toInt()
            val b = m.groupValues[3].toInt()
            val y = if (m.groupValues[4].length == 2) expandYear(m.groupValues[4].toInt(), today) else m.groupValues[4].toInt()
            val (mm, dd) = if (a > 12) (b - 1) to a else (a - 1) to b
            return validDate(y, mm, dd)?.let(Instant::ofEpochMilli)
        }
        ISO.matchEntire(s)?.let { m ->
            return validDate(m.groupValues[1].toInt(), m.groupValues[2].toInt() - 1, m.groupValues[3].toInt())?.let(Instant::ofEpochMilli)
        }
        val day: Int
        val month: Int?
        var year: Int? = null
        val dmy = D_M_Y.matchEntire(s)
        val mdy = if (dmy == null) M_D_Y.matchEntire(s) else null
        val md = if (dmy == null && mdy == null) M_D.matchEntire(s) else null
        val dm = if (dmy == null && mdy == null && md == null) D_M.matchEntire(s) else null
        when {
            dmy != null -> { day = dmy.groupValues[1].toInt(); month = monthIndex(dmy.groupValues[2]); year = dmy.groupValues[3].toInt() }
            mdy != null -> { day = mdy.groupValues[2].toInt(); month = monthIndex(mdy.groupValues[1]); year = mdy.groupValues[3].toInt() }
            md != null -> { day = md.groupValues[2].toInt(); month = monthIndex(md.groupValues[1]) }
            dm != null -> { day = dm.groupValues[1].toInt(); month = monthIndex(dm.groupValues[2]) }
            else -> return null
        }
        if (month == null) return null
        if (year != null) return validDate(year, month, day)?.let(Instant::ofEpochMilli)
        // No year: the most recent such date, not more than ~6 months ahead.
        val thisYear = today.atZone(ZoneOffset.UTC).year
        val candidate = validDate(thisYear, month, day) ?: return null
        val chosen = if (candidate - today.toEpochMilli() > 183 * DAY_MS) (validDate(thisYear - 1, month, day) ?: candidate) else candidate
        return Instant.ofEpochMilli(chosen)
    }

    /** "late 30s" (balanced) or "30s" (coarse). Children/teens are never given exact ages. */
    fun ageDescription(dob: Instant, today: Instant, coarse: Boolean): String {
        val t = today.atZone(ZoneOffset.UTC)
        val d = dob.atZone(ZoneOffset.UTC)
        var years = t.year - d.year
        val beforeBirthday = t.monthValue < d.monthValue || (t.monthValue == d.monthValue && t.dayOfMonth < d.dayOfMonth)
        if (beforeBirthday) years -= 1
        if (years < 0) return "an adult"
        if (years < 13) return "a child"
        if (years < 20) return "a teenager"
        val decade = (years / 10) * 10
        if (coarse) return "${decade}s"
        val pos = years % 10
        return "${if (pos <= 3) "early" else if (pos <= 6) "mid" else "late"} ${decade}s"
    }

    /** "3 weeks ago", "in 2 days", "about 2 years ago". */
    fun relativeDescription(date: Instant, today: Instant): String {
        val days = roundHalfAway((date.toEpochMilli() - today.toEpochMilli()).toDouble() / DAY_MS)
        val n = Math.abs(days)
        val future = days > 0
        fun phrase(k: Double, unit: String): String {
            val kk = k.toLong()
            val u = if (k == 1.0) unit else unit + "s"
            return if (future) "in $kk $u" else "$kk $u ago"
        }
        if (n == 0.0) return "today"
        if (n == 1.0) return if (future) "tomorrow" else "yesterday"
        if (n < 7) return phrase(n, "day")
        if (n < 60) return phrase(roundHalfAway(n / 7), "week")
        if (n < 365) return phrase(roundHalfAway(n / 30.4), "month")
        val years = roundHalfAway(n / 365.25)
        val s = if (years == 1.0) "" else "s"
        return if (future) "in about ${years.toLong()} year$s" else "about ${years.toLong()} year$s ago"
    }

    /** The fallback phrase for an entity at a generalisation level (never contains the entity's value). */
    fun ladderDefault(e: Entity, level: Int, today: Instant = Instant.now()): String = when (e.category) {
        PrivacyCategory.ORG -> "an organisation"
        PrivacyCategory.LOCATION -> if (level >= 3) "a place" else "a city"
        PrivacyCategory.HEALTH -> if (level >= 3) "a health matter" else "a medical condition"
        PrivacyCategory.QUASI -> "a specific detail"
        PrivacyCategory.DATE -> {
            val date = parseDate(e.canonical, today)
            when {
                date == null -> if (e.subtype == "dob") "an adult" else "a recent date"
                e.subtype == "dob" -> ageDescription(date, today, level >= 3)
                else -> relativeDescription(date, today)
            }
        }
        PrivacyCategory.PERSON -> "a person"
        PrivacyCategory.CONTACT -> "contact details"
        PrivacyCategory.ID -> "a reference number"
        PrivacyCategory.SECRET -> "a secret"
    }

    /**
     * A rewrite is accepted only if it is non-empty, ≤ 8 words, different from the phrase, contains no entity term
     * (surface forms, partial names, distinctive words) and no pattern hit outside dates.
     */
    /**
     * Shape check for a phrase the model wrote to replace [replaced] (FX-02, `detect.v2` `general`): at most 6 words, no
     * sentence punctuation or brackets, and no capital first letter unless the replaced text started with one. It stops a
     * whole sentence being dropped into the middle of another; [validateRewrite] still runs after it.
     */
    fun plausibleGeneral(phrase: String, replaced: String): Boolean {
        val p = Js.trim(phrase)
        if (p.isEmpty() || Js.splitWhitespace(p).size > 6) return false
        if (p.any { it in ".!?;:[]{}<>|\n" }) return false
        val startedUpper = Js.trim(replaced).firstOrNull()?.isUpperCase() ?: false
        return !((p.firstOrNull()?.isUpperCase() ?: false) && !startedUpper)
    }

    fun validateRewrite(rewrite: String, phrase: String, entities: EntityMap, patterns: PatternDetector): Boolean {
        val r = Js.trim(rewrite)
        if (r.isEmpty() || Js.splitWhitespace(r).size > MAX_WORDS) return false
        if (FoldedSearch.fold(r) == FoldedSearch.fold(phrase)) return false
        if (r.contains("[[")) return false
        val hay = FoldedSearch.Haystack(r)
        for (e in entities.sorted()) {
            if (e.category == PrivacyCategory.DATE && !e.action.mustNotEgress) continue
            for (term in Terms.entityTerms(e)) if (FoldedSearch.ranges(term.text, hay, term.caseSensitive).isNotEmpty()) return false
        }
        return patterns.detect(r).none { it.category != PrivacyCategory.DATE }
    }
}
