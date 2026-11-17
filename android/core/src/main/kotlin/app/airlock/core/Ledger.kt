package app.airlock.core

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** Aggregates for the Privacy screen. */
data class LedgerStats(
    val requests: Int,
    val sealedDetails: Int,
    val generalised: Int,
    val onDeviceAnswers: Int,
    val cloudAnswers: Int,
    val blocked: Int,
    val byCategory: Map<String, Int>,
)

/**
 * The local append-only receipt chain (port of ledger.ts / ReceiptLedger.swift). On-device answers (nothing left the
 * device) are counted but create no receipt. `onAppend` lets the store persist each receipt. Appends are serialised.
 */
class ReceiptLedger(
    receipts: List<Receipt> = emptyList(),
    private val onAppend: suspend (Receipt) -> Unit = {},
) {
    private val list = ArrayList(receipts)
    private val onDevice = ArrayList<Instant>()
    private val mutex = Mutex()

    val receipts: List<Receipt> get() = synchronized(list) { list.toList() }

    suspend fun append(
        sealed: SealedText, threadId: String, route: Route, modelVersion: String, armor: ArmorStatus, sealMs: Double, networkMs: Double,
        at: Instant = Instant.now(),
    ): Receipt = mutex.withLock {
        val last = synchronized(list) { list.lastOrNull() }
        val r = makeReceipt(sealed, (last?.seq ?: 0) + 1, last?.hash ?: HashChain.GENESIS, threadId, route, modelVersion, armor, sealMs, networkMs, at)
        synchronized(list) { list.add(r) }
        onAppend(r)
        r
    }

    fun recordOnDeviceAnswer(at: Instant = Instant.now()) {
        synchronized(onDevice) { onDevice.add(at) }
    }

    fun verify(): ChainVerification = HashChain.verifyChain(receipts)

    fun stats(since: Instant): LedgerStats {
        val iso = timestamp(since)
        val recent = receipts.filter { it.createdAt >= iso }
        val byCategory = LinkedHashMap<String, Int>()
        val cats = PrivacyCategory.ALL.mapTo(HashSet()) { it.wire }
        for (r in recent) for ((k, v) in r.counts) if (k in cats) byCategory[k] = (byCategory[k] ?: 0) + v
        val generalised = recent.sumOf { it.counts["generalised"] ?: 0 }
        val onDeviceCount = synchronized(onDevice) { onDevice.count { it >= since } }
        return LedgerStats(
            requests = recent.size,
            sealedDetails = byCategory.values.sum() + generalised,
            generalised = generalised,
            onDeviceAnswers = onDeviceCount + recent.count { it.modelVersion == ON_DEVICE_MODEL },
            cloudAnswers = recent.count { it.modelVersion != ON_DEVICE_MODEL && it.armor != ArmorStatus.BLOCKED },
            blocked = recent.count { it.armor == ArmorStatus.BLOCKED },
            byCategory = byCategory,
        )
    }

    companion object {
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC)

        /** ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z`. */
        fun timestamp(d: Instant): String = ISO.format(d)

        fun makeReceipt(
            sealed: SealedText, seq: Int, prevHash: String, threadId: String, route: Route, modelVersion: String, armor: ArmorStatus,
            sealMs: Double, networkMs: Double, at: Instant,
        ): Receipt {
            val outbound = sealed.outbound()
            return HashChain.sealReceipt(
                Receipt(
                    id = "rcpt_" + seq.toString().padStart(4, '0'), seq = seq, createdAt = timestamp(at), threadId = threadId, route = route,
                    modelVersion = modelVersion, outboundSha256 = sealed.gateReport.outboundSha256, outboundChars = Js.codePointLength(outbound),
                    counts = LinkedHashMap(sealed.gateReport.counts), gatePassed = !sealed.gateReport.bypassed,
                    gateChecks = sealed.gateReport.checksPassed.map { it.name }, armor = armor,
                    latencyMs = linkedMapOf("seal" to Js.round(sealMs), "network" to Js.round(networkMs)),
                    prevHash = prevHash, hash = "", outboundText = outbound,
                ),
            )
        }
    }
}
