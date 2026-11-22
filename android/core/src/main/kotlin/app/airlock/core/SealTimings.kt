package app.airlock.core

/**
 * Where a seal's time went (FX-02; port of timing.ts). Numbers only — never content or prompts (INV-8). Shown in
 * Review's "Timing" disclosure; not part of the hashed receipt.
 */
data class SealTimings(
    /** Vault + pattern detection. */
    val rulesMs: Double = 0.0,
    val detectMs: Double = 0.0,
    /** `detect.*` calls (one per chunk, more when a chunk is halved). */
    val detectCalls: Int = 0,
    /** `detect-repair.*` calls (broken JSON). */
    val repairCalls: Int = 0,
    val generaliseMs: Double = 0.0,
    val generaliseCalls: Int = 0,
    val redTeamMs: Double = 0.0,
    val redTeamCalls: Int = 0,
    /** From the start of the seal to the first on-device reply; null when no model call ran. */
    val firstModelOutputMs: Double? = null,
    /** The whole seal, up to the draft Review shows. */
    val totalMs: Double = 0.0,
)

/** Wraps the phone-only engine for one seal and counts calls by prompt-id family. Only forwards (INV-3). */
internal class CallMeter(
    private val inner: PhoneOnlyEngine,
    private val startedAt: Double,
    private val clock: () -> Double = { System.nanoTime() / 1e6 },
) : PhoneOnlyEngine {
    private val counts = HashMap<String, Int>()
    private var total = 0

    @Volatile var firstModelOutputMs: Double? = null
        private set

    override suspend fun availability(): PhoneAvailability = inner.availability()

    override suspend fun respond(prompt: PhonePrompt, options: PhoneOptions): EngineResult {
        val family = prompt.promptId.replace(Regex("""\.v\d+$"""), "")
        synchronized(this) {
            counts[family] = (counts[family] ?: 0) + 1
            total++
        }
        try {
            return inner.respond(prompt, options)
        } finally {
            synchronized(this) { if (firstModelOutputMs == null) firstModelOutputMs = clock() - startedAt }
        }
    }

    fun calls(family: String? = null): Int = synchronized(this) { if (family == null) total else counts[family] ?: 0 }
}

/**
 * FX-02: what the Vault and the rules found, before any model call — shown at once on the sealing screen (local
 * only; it holds raw text and never leaves the device).
 */
data class RulesPreview(
    /** The normalised text the spans point into. */
    val text: String,
    /** Non-overlapping, in order; the longest wins where two overlap. */
    val spans: List<Span>,
    /** Distinct details (same text, any case, counted once). */
    val count: Int,
) {
    data class Span(val start: Int, val end: Int, val category: PrivacyCategory)

    override fun toString(): String = "RulesPreview(${spans.size} spans)"

    companion object {
        fun of(text: String, candidates: List<Candidate>): RulesPreview {
            val sorted = candidates.sortedWith(compareBy<Candidate> { it.span.start }.thenByDescending { it.span.end - it.span.start })
            val spans = ArrayList<Span>()
            for (c in sorted) {
                val last = spans.lastOrNull()
                if (last != null && c.span.start < last.end) {
                    if (c.span.end - c.span.start > last.end - last.start) spans[spans.size - 1] = Span(c.span.start, c.span.end, c.category)
                    continue
                }
                spans.add(Span(c.span.start, c.span.end, c.category))
            }
            val count = spans.mapTo(HashSet()) { text.substring(it.start, it.end).lowercase() }.size
            return RulesPreview(text, spans, count)
        }
    }
}
