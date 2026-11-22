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
