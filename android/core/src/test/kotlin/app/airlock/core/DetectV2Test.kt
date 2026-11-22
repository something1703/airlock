package app.airlock.core

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** `detect.v2` (FX-02): shared conformance cases from spec/fixtures/detect.json, plus robustness and shape checks. */
class DetectV2Test {
    @Serializable
    private class Mask(val start: Int, val end: Int, val text: String, val category: String, val subtype: String? = null, val detector: String)

    @Serializable
    private class Case(
        val name: String,
        val promptId: String,
        val text: String,
        val masks: List<Mask>,
        val modelOutput: String,
        val expect: List<List<String?>>,
        val generals: Map<String, String>,
        val promptIncludes: List<String>,
        val promptExcludes: List<String>,
        val hallucinated: Int,
    )

    @Serializable
    private class Fx(val cases: List<Case>)

    private val prompts = PromptLibrary()

    @Test fun sharedConformanceCases() = runTest {
        for (c in Fixtures.load<Fx>("detect.json").cases) {
            val masks = c.masks.map {
                Candidate(TextSpan(it.start, it.end), it.text, PrivacyCategory.fromWire(it.category)!!, it.subtype, DetectorId.entries.first { d -> d.wire == it.detector }, Confidence.HIGH)
            }
            val phone = MockPhoneEngine { _, _ -> c.modelOutput }
            val r = LLMDetector(phone, prompts, 3000, c.promptId, masks).detect(c.text)
            assertEquals(c.promptId, phone.calledPromptIds.first(), c.name)
            assertEquals(c.expect, r.candidates.map { listOf(it.text, it.category.wire, it.confidence.wire, it.roleHint) }, c.name)
            assertEquals(c.generals, r.generals, c.name)
            assertEquals(c.hallucinated, r.hallucinatedDropped, c.name)
            assertTrue(r.failedChunks.isEmpty(), c.name)
            val sent = phone.calls.first().text
            for (s in c.promptIncludes) assertTrue(sent.contains(s), "${c.name}: prompt should include $s")
            for (s in c.promptExcludes) assertFalse(sent.contains(s), "${c.name}: prompt should not include $s")
        }
    }

    @Test fun brokenReplyIsRepairedOnceThenFailed() = runTest {
        val phone = MockPhoneEngine { _, _ -> "I cannot do that" }
        val r = LLMDetector(phone, prompts, 3000, "detect.v2").detect("Hi Raj.")
        assertEquals(listOf("detect.v2", "detect-repair.v1"), phone.calledPromptIds)
        assertEquals(listOf(0), r.failedChunks)
    }

    @Test fun plausibleGeneralShapeCheck() {
        for (g in listOf("a large hospital", "a nearby street", "a chronic condition")) assertTrue(Generaliser.plausibleGeneral(g, "Mercy General Hospital"), g)
        assertFalse(Generaliser.plausibleGeneral("Two-week turnaround required for repairs.", "14 days"))
        assertFalse(Generaliser.plausibleGeneral("a very large and busy teaching hospital in town", "Mercy General"))
        assertFalse(Generaliser.plausibleGeneral("a [[ORG_1]] clinic", "Mercy"))
        assertFalse(Generaliser.plausibleGeneral("The hospital", "mercy"))
        assertTrue(Generaliser.plausibleGeneral("The hospital", "Mercy"))
        assertFalse(Generaliser.plausibleGeneral("", "Mercy"))
    }
}
