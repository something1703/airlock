package app.airlock.core

/** Model Armor outcome recorded on a receipt. */
enum class ArmorStatus(val wire: String) {
    PASS("pass"), BLOCKED("blocked"), NOT_CONFIGURED("notConfigured"), UNKNOWN("unknown");

    companion object {
        fun fromWire(s: String): ArmorStatus? = entries.firstOrNull { it.wire == s }
    }
}

/** A tamper-evident record of one thing that left the device (no raw or restored text — INV-7). */
data class Receipt(
    val id: String,
    val seq: Int,
    /** ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z`. */
    val createdAt: String,
    val threadId: String,
    val route: Route,
    val modelVersion: String,
    val outboundSha256: String,
    val outboundChars: Int,
    val counts: Map<String, Int>,
    val gatePassed: Boolean,
    val gateChecks: List<String>,
    val armor: ArmorStatus,
    val latencyMs: Map<String, Long>,
    val prevHash: String,
    val hash: String,
    /** The exact sealed text that left (local only; excluded from the hash). */
    val outboundText: String? = null,
) {
    override fun toString(): String = "Receipt($id, seq=$seq)"
}

/** Result of [HashChain.verifyChain]. */
sealed interface ChainVerification {
    data class Valid(val count: Int) : ChainVerification
    data class Invalid(val index: Int, val seq: Int, val reason: Reason) : ChainVerification

    enum class Reason { HASH_MISMATCH, PREV_HASH_MISMATCH, SEQ_GAP, GENESIS_MISMATCH }
}

/**
 * The receipt hash chain (port of hashchain.ts). hash = sha256_hex(prevHash + canonicalJSON(fields)); canonical JSON
 * is byte-identical to Swift's `CanonicalJSON` and Python `json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)`: keys sorted by UTF-16 code unit, no whitespace, minimal string escaping, integers only.
 */
object HashChain {
    val GENESIS: String = "0".repeat(64)

    /** Canonical JSON of `null`, Boolean, Int/Long, String, List and Map<String, *> values. Non-integers are rejected. */
    fun canonicalJson(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> if (v) "true" else "false"
        is Int, is Long, is Short, is Byte -> v.toString()
        is Double -> {
            require(v.isFinite() && v == Math.rint(v)) { "canonical JSON allows integers only" }
            (if (v < 0) "-" else "") + Money.jsNumberString(Math.abs(v))
        }
        is Float -> canonicalJson(v.toDouble())
        is String -> Js.quote(v)
        is List<*> -> v.joinToString(",", "[", "]") { canonicalJson(it) }
        is Map<*, *> -> v.entries.map { it.key.toString() to it.value }.sortedWith { a, b -> a.first.compareTo(b.first) }
            .joinToString(",", "{", "}") { (k, value) -> Js.quote(k) + ":" + canonicalJson(value) }
        else -> throw IllegalArgumentException("unsupported canonical JSON value")
    }

    /** The hashed fields: everything except `hash` and `outboundText`. */
    fun hashedFields(r: Receipt): Map<String, Any?> = mapOf(
        "armor" to r.armor.wire, "counts" to r.counts, "createdAt" to r.createdAt,
        "gate" to mapOf("checks" to r.gateChecks, "passed" to r.gatePassed), "id" to r.id, "latencyMs" to r.latencyMs,
        "modelVersion" to r.modelVersion, "outboundChars" to r.outboundChars, "outboundSha256" to r.outboundSha256,
        "prevHash" to r.prevHash, "route" to r.route.wire, "seq" to r.seq, "threadId" to r.threadId,
    )

    fun computeHash(r: Receipt): String = sha256Hex(r.prevHash + canonicalJson(hashedFields(r)))
    fun sealReceipt(r: Receipt): Receipt = r.copy(hash = computeHash(r))

    /** Verifies receipts in chain order (ascending `seq`). */
    fun verifyChain(receipts: List<Receipt>): ChainVerification {
        var expectedPrev = GENESIS
        var expectedSeq: Int? = null
        for ((index, r) in receipts.withIndex()) {
            if (index == 0 && r.prevHash != GENESIS) return ChainVerification.Invalid(index, r.seq, ChainVerification.Reason.GENESIS_MISMATCH)
            if (expectedSeq != null && r.seq != expectedSeq) return ChainVerification.Invalid(index, r.seq, ChainVerification.Reason.SEQ_GAP)
            if (r.prevHash != expectedPrev) return ChainVerification.Invalid(index, r.seq, ChainVerification.Reason.PREV_HASH_MISMATCH)
            if (computeHash(r) != r.hash) return ChainVerification.Invalid(index, r.seq, ChainVerification.Reason.HASH_MISMATCH)
            expectedPrev = r.hash
            expectedSeq = r.seq + 1
        }
        return ChainVerification.Valid(receipts.size)
    }
}
