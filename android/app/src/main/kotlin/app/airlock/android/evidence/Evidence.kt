// Evidence (docs/06-UI-UX.md §5.12): what AirlockBench measured, shown in the app. Port of web/src/app/evidence.ts.
// Sources, in order:
//   1. Remote Config `evidence_json` (so the final run can go live without a new APK),
//   2. the newest NON-mock run bundled from eval/reports/<run>/evidence.json (copied in by Gradle),
//   3. the newest mock run — always shown with its "MOCK RUN" label, never as real results.
// Schema: eval/schemas/evidence.schema.json. Benchmark data is synthetic; nothing here is user content.
package app.airlock.android.evidence

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import java.util.Locale

/** A rate with its 95% interval and sample size. Values are fractions in 0…1. */
data class Measure(val value: Double, val low: Double, val high: Double, val n: Int)

/** One ablation step: the leak rate with layers up to and including [label] switched on. */
data class AblationRow(val config: String, val label: String, val leak: Measure)

/** One validated benchmark report. A mock run always carries its [label]. */
data class Evidence(
    val schemaVersion: Int,
    val mock: Boolean,
    val label: String?,
    val runId: String,
    val createdAt: String,
    val dataset: String,
    val split: String,
    val n: Int,
    val languages: List<String>,
    val onDeviceModel: String?,
    val headlineConfig: String?,
    val leakRate: Measure,
    val leakRateWithVault: Measure?,
    val namesCaught: Measure,
    val quality: Measure,
    val onDevice: Measure?,
    val restoreFidelity: Measure?,
    val reidTwoAttrs: Measure?,
    val gateBlockRate: Measure?,
    val ablation: List<AblationRow>,
    val misses: List<String>,
    val method: String,
)

private fun JsonElement?.num(): Double? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

private fun JsonElement?.measure(): Measure? {
    val o = this as? JsonObject ?: return null
    val v = o["value"].num() ?: return null
    val lo = o["low"].num() ?: return null
    val hi = o["high"].num() ?: return null
    val n = o["n"].num() ?: return null
    return Measure(v, lo, hi, n.toInt())
}

/** Structural check — anything malformed is ignored rather than shown (same rules as the web). */
fun parseEvidence(raw: JsonElement?): Evidence? {
    val e = raw as? JsonObject ?: return null
    if (e["schemaVersion"].num() != 1.0) return null
    val mock = e["mock"].bool() ?: return null
    val runId = e["runId"].str() ?: return null
    val leakRate = e["leakRate"].measure() ?: return null
    val namesCaught = e["namesCaught"].measure() ?: return null
    val quality = e["quality"].measure() ?: return null
    val ablation = (e["ablation"] as? JsonArray ?: return null).map { a ->
        val o = a as? JsonObject ?: return null
        AblationRow(o["config"].str() ?: "", o["label"].str() ?: return null, o["leak"].measure() ?: return null)
    }
    val misses = (e["misses"] as? JsonArray ?: return null).map { it.str() ?: return null }
    val label = e["label"].str()
    if (mock && label == null) return null // a mock run must carry its label
    return Evidence(
        schemaVersion = 1, mock = mock, label = label, runId = runId,
        createdAt = e["createdAt"].str() ?: "", dataset = e["dataset"].str() ?: "", split = e["split"].str() ?: "",
        n = e["n"].num()?.toInt() ?: leakRate.n,
        languages = (e["languages"] as? JsonArray)?.mapNotNull { it.str() } ?: emptyList(),
        onDeviceModel = e["onDeviceModel"].str(), headlineConfig = e["headlineConfig"].str(),
        leakRate = leakRate, leakRateWithVault = e["leakRateWithVault"].measure(), namesCaught = namesCaught, quality = quality,
        onDevice = e["onDevice"].measure(), restoreFidelity = e["restoreFidelity"].measure(), reidTwoAttrs = e["reidTwoAttrs"].measure(),
        gateBlockRate = e["gateBlockRate"].measure(), ablation = ablation, misses = misses, method = e["method"].str() ?: "",
    )
}

/** Parses JSON text; `null` for anything that is not a valid report. */
fun parseEvidence(json: String): Evidence? = try {
    parseEvidence(Json.parseToJsonElement(json))
} catch (_: IllegalArgumentException) { // kotlinx SerializationException extends it
    null
}

/** Real runs beat mock runs; newer beats older (ISO-8601 `createdAt` sorts as text). */
fun pickEvidence(candidates: List<JsonElement?>): Evidence? =
    candidates.mapNotNull(::parseEvidence).sortedWith(compareBy<Evidence> { it.mock }.thenByDescending { it.createdAt }).firstOrNull()

/** Reports Gradle copied from eval/reports/<run>/evidence.json into Java resources (`airlock/evidence/`). */
object BundledEvidence {
    private fun read(path: String): String? = BundledEvidence::class.java.getResourceAsStream(path)?.use { it.readBytes().toString(Charsets.UTF_8) }

    /** Run ids, from the generated index (resources cannot be listed on Android). */
    val runIds: List<String> by lazy { read("/airlock/evidence/index.txt")?.lines()?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList() }

    fun all(): List<JsonElement?> = runIds.map { id ->
        read("/airlock/evidence/$id.json")?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() }
    }
}

/** [remoteJson] is AppConfig's `evidence_json` ("{}" when unset). Remote Config wins when it parses. */
fun loadEvidence(remoteJson: String, bundled: () -> List<JsonElement?> = BundledEvidence::all): Evidence? =
    parseEvidence(remoteJson) ?: pickEvidence(bundled())

/** "41.7%" — a fraction as a percentage with [digits] decimals. */
fun pct(v: Double, digits: Int = 0, locale: Locale = Locale.getDefault()): String = String.format(locale, "%.${digits}f%%", v * 100)
