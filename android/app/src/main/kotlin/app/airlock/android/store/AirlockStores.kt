package app.airlock.android.store

import app.airlock.core.Action
import app.airlock.core.ArmorStatus
import app.airlock.core.Confidence
import app.airlock.core.DetectorId
import app.airlock.core.Entity
import app.airlock.core.EntityMap
import app.airlock.core.LegendLine
import app.airlock.core.PrivacyCategory
import app.airlock.core.Receipt
import app.airlock.core.Route
import app.airlock.core.TaskKind
import app.airlock.core.VaultEntry
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

// MARK: Records (port of the web's typed records; JSON inside each encrypted file)

/** A task as stored: kind + optional tone. */
@Serializable
data class TaskDto(val kind: String, val tone: String? = null) {
    fun toTask(): TaskKind = when (kind) {
        "explain" -> TaskKind.Explain
        "questions" -> TaskKind.Questions
        "summary" -> TaskKind.Summary
        "actions" -> TaskKind.Actions
        "reply" -> TaskKind.Reply(tone ?: "firm but polite")
        "rewrite" -> TaskKind.Rewrite(tone ?: "clear and polite")
        "custom" -> TaskKind.Custom
        else -> TaskKind.Help
    }

    companion object {
        fun of(t: TaskKind) = TaskDto(t.kind, (t as? TaskKind.Reply)?.tone ?: (t as? TaskKind.Rewrite)?.tone)
    }
}

@Serializable
data class LegendDto(val placeholder: String, val description: String)

/** The sealed side of a user turn, kept so it can be re-checked by the gate on load (never trusted as-is). */
@Serializable
data class StoredSealed(
    val text: String, val legend: List<LegendDto>, val revealedVaultIds: List<String>, val keptValues: List<String>,
    /** FX-02: answered on the device from the raw message. There is no sealed version (the fields above are empty). */
    val local: Boolean = false,
) {
    fun legendLines(): List<LegendLine> = legend.map { LegendLine(it.placeholder, it.description) }

    companion object {
        fun legendOf(lines: List<LegendLine>) = lines.map { LegendDto(it.placeholder, it.description) }
    }
}

@Serializable
data class StoredOutcome(
    val route: String, val modelVersion: String, val ranOnDevice: Boolean, val fellBackToPhone: Boolean, val latencyMs: Double, val receiptId: String?,
    /** FX-02: written on the device from the raw message; shown as it is, never restored, sent or backed up. */
    val local: Boolean = false,
)

@Serializable
data class StoredTurn(
    val kind: String, // "user" | "assistant"
    val raw: String? = null,
    val sealed: StoredSealed? = null,
    val task: TaskDto? = null,
    val status: String? = null, // "done" | "error"
    val modelText: String? = null,
    /** An `EngineErrorCode` wire value, never a message. */
    val error: String? = null,
    val outcome: StoredOutcome? = null,
)

@Serializable
data class ThreadRecord(val v: Int = 1, val id: String, val title: String, val task: TaskDto, val createdAt: Long, val updatedAt: Long, val turns: List<StoredTurn>)

@Serializable
data class CaptureRecord(val id: String, val createdAt: Long, val threadId: String?, val source: String, val text: String)

@Serializable
private data class VaultDto(val id: String, val canonical: String, val aliases: List<String>, val category: String, val roleHint: String? = null, val isUser: Boolean)

@Serializable
private data class EntityDto(
    val id: String, val category: String, val canonical: String, val surfaceForms: List<String>, val roleHint: String? = null, val action: String,
    val generalisedText: String? = null, val sources: List<String>, val confidence: String, val subtype: String? = null, val vaultEntryId: String? = null,
)

@Serializable
private data class ReceiptDto(
    val id: String, val seq: Int, val createdAt: String, val threadId: String, val route: String, val modelVersion: String, val outboundSha256: String,
    val outboundChars: Int, val counts: Map<String, Int>, val gatePassed: Boolean, val gateChecks: List<String>, val armor: String,
    val latencyMs: Map<String, Long>, val prevHash: String, val hash: String, val outboundText: String? = null,
)

fun routeOf(wire: String): Route = Route.entries.firstOrNull { it.wire == wire } ?: Route.CLOUD_FIRST

/** All sensitive persistence. Nothing here ever syncs (INV-6, INV-7). */
class AirlockStores(val store: EncryptedStore) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private fun safe(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "_").take(100)

    // Entities (placeholder → real value) — INV-6.
    fun saveEntities(thread: String, map: EntityMap) {
        val list = map.sorted().map { e ->
            EntityDto(
                e.id, e.category.wire, e.canonical, e.surfaceForms.sorted(), e.roleHint, e.action.wire, e.generalisedText,
                e.sources.map { it.wire }.sorted(), e.confidence.wire, e.subtype, e.vaultEntryId,
            )
        }
        store.writeText("entities-${safe(thread)}", json.encodeToString(list))
    }

    fun loadEntities(thread: String): EntityMap = try {
        val list = json.decodeFromString<List<EntityDto>>(store.readText("entities-${safe(thread)}"))
        EntityMap(
            list.mapNotNull { d ->
                val cat = PrivacyCategory.fromWire(d.category) ?: return@mapNotNull null
                Entity(
                    id = d.id, category = cat, canonical = d.canonical, surfaceForms = d.surfaceForms.toSet() + d.canonical, roleHint = d.roleHint,
                    action = Action.parse(d.action), generalisedText = d.generalisedText, sources = d.sources.mapNotNull(DetectorId::fromWire).toSet(),
                    confidence = Confidence.fromWire(d.confidence) ?: Confidence.MEDIUM, subtype = d.subtype, vaultEntryId = d.vaultEntryId,
                )
            },
        )
    } catch (e: StoreError) {
        if (e.code == StoreError.Code.NOT_FOUND) EntityMap() else throw e
    }

    // Vault.
    fun saveVault(entries: List<VaultEntry>) {
        store.writeText("vault", json.encodeToString(entries.map { VaultDto(it.id, it.canonical, it.aliases, it.category.wire, it.roleHint, it.isUser) }))
    }

    fun loadVault(): List<VaultEntry> = try {
        json.decodeFromString<List<VaultDto>>(store.readText("vault")).mapNotNull { d ->
            VaultEntry(d.id, d.canonical, d.aliases, PrivacyCategory.fromWire(d.category) ?: return@mapNotNull null, d.roleHint, d.isUser)
        }
    } catch (e: StoreError) {
        if (e.code == StoreError.Code.NOT_FOUND) emptyList() else throw e
    }

    // Raw captures: what the user pasted, purged after `raw_purge_days`.
    fun saveCapture(text: String, source: String, threadId: String?, now: Long = System.currentTimeMillis(), id: String = UUID.randomUUID().toString()): CaptureRecord {
        val rec = CaptureRecord(id, now, threadId, source, text)
        store.writeText("capture-${safe(id)}", json.encodeToString(rec))
        return rec
    }

    fun captures(): List<CaptureRecord> = store.list("capture-").mapNotNull { n ->
        try {
            json.decodeFromString<CaptureRecord>(store.readText(n))
        } catch (_: Exception) {
            null // Unreadable (wrong key / tampered): skipped here, removed by purge.
        }
    }.sortedByDescending { it.createdAt }

    /** Deletes captures older than `days` days (and unreadable ones); returns how many were removed. */
    fun purgeCaptures(days: Int, now: Long = System.currentTimeMillis()): Int {
        val cutoff = now - maxOf(0, days) * 86_400_000L
        var removed = 0
        for (n in store.list("capture-")) {
            val keep = try {
                json.decodeFromString<CaptureRecord>(store.readText(n)).createdAt >= cutoff
            } catch (_: Exception) {
                false
            }
            if (!keep) {
                store.delete(n)
                removed++
            }
        }
        return removed
    }

    // Conversations (raw turns, sealed turns, model text). Local only, encrypted; never synced (INV-7).
    fun saveThread(rec: ThreadRecord) = store.writeText("thread-${safe(rec.id)}", json.encodeToString(rec))

    fun threads(): List<ThreadRecord> = store.list("thread-").mapNotNull { n ->
        try {
            json.decodeFromString<ThreadRecord>(store.readText(n)).takeIf { it.v == 1 }
        } catch (_: Exception) {
            null
        }
    }.sortedByDescending { it.updatedAt }

    /** Deletes a conversation, its entity map and its captures. Receipts stay (the chain must stay verifiable). */
    fun deleteThread(thread: String) {
        store.delete("thread-${safe(thread)}")
        store.delete("entities-${safe(thread)}")
        for (c in captures()) if (c.threadId == thread) store.delete("capture-${safe(c.id)}")
    }

    // Receipts.
    fun saveReceipt(r: Receipt) {
        val d = ReceiptDto(
            r.id, r.seq, r.createdAt, r.threadId, r.route.wire, r.modelVersion, r.outboundSha256, r.outboundChars, r.counts, r.gatePassed,
            r.gateChecks, r.armor.wire, r.latencyMs, r.prevHash, r.hash, r.outboundText,
        )
        store.writeText("receipt-${r.seq.toString().padStart(8, '0')}", json.encodeToString(d))
    }

    /** Unreadable receipts are skipped, so a tampered file shows up as a broken chain on Verify. */
    fun receipts(): List<Receipt> = store.list("receipt-").mapNotNull { n ->
        val d = try {
            json.decodeFromString<ReceiptDto>(store.readText(n))
        } catch (_: Exception) {
            return@mapNotNull null
        }
        Receipt(
            d.id, d.seq, d.createdAt, d.threadId, routeOf(d.route), d.modelVersion, d.outboundSha256, d.outboundChars, d.counts, d.gatePassed,
            d.gateChecks, ArmorStatus.fromWire(d.armor) ?: ArmorStatus.UNKNOWN, d.latencyMs, d.prevHash, d.hash, d.outboundText,
        )
    }

    fun deleteEverything() = store.deleteEverything()
}
