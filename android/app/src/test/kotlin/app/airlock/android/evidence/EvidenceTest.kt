package app.airlock.android.evidence

import app.airlock.android.repoRoot
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Mirrors web/tests/evidence.test.ts, plus the Gradle bundling of eval/reports. */
class EvidenceTest {
    private val base: JsonObject = Json.parseToJsonElement(
        """{"schemaVersion":1,"runId":"r","createdAt":"2026-11-20T00:00:00Z","dataset":"synth-v1","split":"test","n":10,"languages":["en"],
           "leakRate":{"value":0.1,"low":0.05,"high":0.2,"n":10},"namesCaught":{"value":0.9,"low":0.8,"high":0.95,"n":20},
           "quality":{"value":0.8,"low":0.7,"high":0.9,"n":10},
           "ablation":[{"config":"B","label":"Rules","leak":{"value":0.5,"low":0.4,"high":0.6,"n":10}}],"misses":[],"method":"https://example.org"}""",
    ).jsonObject

    private fun with(vararg kv: Pair<String, Any?>): JsonObject = JsonObject(
        base + kv.associate { (k, v) ->
            k to when (v) {
                is JsonElement -> v
                is Boolean -> JsonPrimitive(v)
                is Number -> JsonPrimitive(v)
                else -> JsonPrimitive(v as String)
            }
        },
    )

    @Test fun neverAcceptsAMockRunWithoutItsLabelOrMalformedData() {
        assertNull(parseEvidence(with("mock" to true)))
        assertNotNull(parseEvidence(with("mock" to true, "label" to "MOCK RUN — not real model results")))
        assertNull(parseEvidence(with("mock" to false, "leakRate" to buildJsonObject { put("value", "x") })))
        assertNull(parseEvidence(with("mock" to false, "schemaVersion" to 2)))
        assertNull(parseEvidence(with("mock" to "false"))) // a string is not a boolean
        assertNull(parseEvidence(with("mock" to false, "misses" to Json.parseToJsonElement("[1]"))))
        assertNull(parseEvidence(with("mock" to false, "ablation" to Json.parseToJsonElement("""[{"label":"x"}]"""))))
        assertNull(parseEvidence(null as JsonElement?))
        assertNull(parseEvidence("not json"))
        assertNull(parseEvidence("{}"))
    }

    @Test fun prefersRealRunsOverMockRunsThenTheNewest() {
        val mockNew = with("mock" to true, "label" to "MOCK", "runId" to "mock", "createdAt" to "2026-11-30T00:00:00Z")
        val realOld = with("mock" to false, "runId" to "real-old", "createdAt" to "2026-11-20T00:00:00Z")
        val realNew = with("mock" to false, "runId" to "real-new", "createdAt" to "2026-11-25T00:00:00Z")
        assertEquals("real-new", pickEvidence(listOf(mockNew, realOld, realNew))?.runId)
        assertEquals("mock", pickEvidence(listOf(mockNew))?.runId)
        assertNull(pickEvidence(listOf(null, JsonPrimitive(3))))
    }

    @Test fun remoteConfigWinsOtherwiseTheBundledReports() {
        assertEquals("from-rc", loadEvidence(with("mock" to false, "runId" to "from-rc").toString())?.runId)
        val bundled = assertNotNull(loadEvidence("{}"))
        assertTrue(if (bundled.mock) !bundled.label.isNullOrEmpty() else true)
        assertEquals(bundled.runId, loadEvidence("not json")?.runId)
    }

    @Test fun bundlesEveryReportUnderEvalReports() {
        val onDisk = File(repoRoot, "eval/reports").listFiles().orEmpty().filter { File(it, "evidence.json").isFile }.map { it.name }.sorted()
        assertTrue(onDisk.isNotEmpty())
        assertEquals(onDisk, BundledEvidence.runIds)
        // Every bundled report is valid, so none is silently dropped.
        assertEquals(onDisk.size, BundledEvidence.all().mapNotNull(::parseEvidence).size)
    }

    @Test fun readsTheMockSampleFully() {
        val e = assertNotNull(parseEvidence(File(repoRoot, "eval/reports/mock-sample/evidence.json").readText()))
        assertTrue(e.mock)
        assertEquals("MOCK RUN — not real model results", e.label)
        assertEquals(listOf("de", "en", "es"), e.languages)
        assertEquals(4, e.ablation.size)
        assertNotNull(e.onDevice)
        assertEquals(3, e.misses.size)
    }

    @Test fun formatsPercentages() {
        assertEquals("41.7%", pct(0.4167, 1, Locale.ROOT))
        assertEquals("40%", pct(0.4, 0, Locale.ROOT))
        assertEquals("100%", pct(1.0, 0, Locale.ROOT))
    }
}
