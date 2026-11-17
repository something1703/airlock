package app.airlock.core

import java.math.BigDecimal

/** One money amount and its bucket ("$1,000–1,500"). */
data class MoneyHit(val span: TextSpan, val bucket: String)

/** Strict-dial money bucketing (port of money.ts): only amounts with a currency symbol. */
object Money {
    private val MONEY = Js.pattern("(?<![\\w.])([$€£₹])\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?(?!\\d|,\\d)")

    fun findMoney(text: String): List<MoneyHit> {
        val hits = ArrayList<MoneyHit>()
        val m = MONEY.matcher(text)
        while (m.find()) {
            val value = (m.group(2) ?: "").replace(",", "").toDouble()
            if (!value.isFinite()) continue
            hits.add(MoneyHit(TextSpan(m.start(), m.end()), bucket(value, m.group(1) ?: "$")))
        }
        return hits
    }

    /** Half-magnitude buckets: 1,240 → 1,000–1,500; 85 → 85–90; 7 → under 10. */
    fun bucket(value: Double, symbol: String): String {
        if (value < 10) return "under ${symbol}10"
        val magnitude = Math.pow(10.0, (jsNumberString(value).length - 1).toDouble())
        val step = maxOf(1.0, Math.floor(magnitude / 2))
        val low = Math.floor(value / step) * step
        return "$symbol${grouped(low)}–${grouped(low + step)}"
    }

    /**
     * `String(n)` for a non-negative finite double (shortest round-trip digits; exponent form from 1e21 up).
     * Java 19+ `Double.toString` yields the shortest digits too, so this matches JS for every value that matters.
     */
    internal fun jsNumberString(n: Double): String {
        if (n == 0.0) return "0"
        val bd = BigDecimal(java.lang.Double.toString(n)).stripTrailingZeros()
        val digits = bd.unscaledValue().abs().toString()
        val k = digits.length
        val e = k - bd.scale() // decimal exponent: value = 0.d1d2… × 10^e
        return when {
            e in k..21 -> digits + "0".repeat(e - k)
            e in 1..21 -> digits.substring(0, e) + "." + digits.substring(e)
            e in -5..0 -> "0." + "0".repeat(-e) + digits
            else -> {
                val exp = e - 1
                val sign = if (exp < 0) "-" else "+"
                (if (k == 1) digits else digits[0] + "." + digits.substring(1)) + "e" + sign + Math.abs(exp)
            }
        }
    }

    /** `n.toLocaleString("en-US")` for a non-negative integer-valued double. */
    private fun grouped(n: Double): String {
        val s = BigDecimal(java.lang.Double.toString(n)).setScale(0, java.math.RoundingMode.HALF_EVEN).toBigInteger().toString()
        val sb = StringBuilder()
        for ((i, c) in s.withIndex()) {
            if (i > 0 && (s.length - i) % 3 == 0) sb.append(',')
            sb.append(c)
        }
        return sb.toString()
    }
}
