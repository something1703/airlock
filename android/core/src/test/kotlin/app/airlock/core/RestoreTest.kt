package app.airlock.core

import kotlinx.serialization.json.JsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Port of web/tests/restore.test.ts. */
class RestoreTest {
    @Test fun placeholderFixture() {
        val f = Fixtures.element("placeholders.json")
        val parser = PlaceholderParser(f["known"].strings.toSet())
        for (c in f["cases"].list) {
            val text = c["text"].str
            val got = parser.tokens(text)
            assertEquals(c["expect"].list.map { it["original"].str }, got.map { it.original }, text)
            assertEquals(c["expect"].list.map { it["id"].str }, got.map { it.id }, text)
            assertEquals(c["expect"].list.map { it["canonical"].bool }, got.map { it.isCanonical }, text)
            for (t in got) {
                assertTrue(t.original.length <= PlaceholderParser.MAX_TOKEN_LENGTH)
                assertEquals(t.original, text.substring(t.span.start, t.span.end))
            }
        }
    }

    private val fx = Fixtures.element("restore.json")
    private val secretDisplay = fx["secretDisplay"].str
    private fun mapOf(g: JsonElement) = EntityMap(g["entities"].list.map(::fixtureEntity))
    private fun ctxOf(g: JsonElement, c: JsonElement) =
        RestoreContext(mapOf(g), c["userFirstName"].strOrNull, c["writingAsUser"].bool, secretDisplay)

    @Test fun restoreFixture() {
        for (g in fx["groups"].list) for (c in g["cases"].list) {
            val r = Restorer.restore(c["output"].str, ctxOf(g, c))
            assertEquals(c["expected"].str, r.text, "[${c["name"].str}]")
            assertEquals(c["unknown"].strings, r.unknownIds, "[${c["name"].str}] unknown")
        }
    }

    @Test fun streamingEqualsUnaryAtEverySplit() {
        for (g in fx["groups"].list) for (c in g["cases"].list) {
            val ctx = ctxOf(g, c)
            val output = c["output"].str
            val unary = Restorer.restore(output, ctx)
            for (split in 0..output.length) {
                // Real SDK chunks are valid strings: skip splits inside a surrogate pair.
                if (split > 0 && split < output.length && output[split - 1].isHighSurrogate()) continue
                val head = output.substring(0, split)
                val tail = output.substring(split)
                val d = StreamingRestorer(ctx)
                d.append(head); d.append(tail); d.finish()
                assertEquals(unary.segments, d.segments, "[${c["name"].str}] delta split $split")
                val cu = StreamingRestorer(ctx)
                cu.update(head); cu.update(head + tail); cu.finish()
                assertEquals(unary.segments, cu.segments, "[${c["name"].str}] cumulative split $split")
            }
        }
    }

    @Test fun randomMultiChunkStreaming() {
        val g = fx["groups"].list[0]
        val ctx = RestoreContext(mapOf(g), secretDisplay = secretDisplay)
        val r = Mulberry32(2026)
        val parts = listOf(
            "[[PERSON_1]]", "[[ORG_1]]", "[[LOC_1]]", "[[SECRET_1]]", "[[PERSON_ME]]", "[[PERSON_9]]", "PERSON_1", "[Person_1]", "【PERSON_1】",
            "[[", "]]", "[", "PERSON", "_", "1", "'s ", " the ", "heater ", "\n", "é", "👩‍👧", "[[PERSON_1",
        )
        repeat(500) {
            val answer = List(r.int(1, 40)) { r.pick(parts) }.joinToString("")
            val unary = Restorer.restore(answer, ctx)
            val s = StreamingRestorer(ctx)
            var k = 0
            while (k < answer.length) {
                var end = minOf(answer.length, k + r.int(1, 12))
                if (end < answer.length && answer[end].isLowSurrogate()) end += 1
                s.append(answer.substring(k, end))
                k = end
            }
            s.finish()
            assertEquals(unary.segments, s.segments, "answer: $answer")
        }
    }

    @Test fun neverRestoresASecret() {
        val ctx = RestoreContext(mapOf(fx["groups"].list[0]))
        for (v in listOf("[[SECRET_1]]", "[SECRET_1]", "SECRET_1", "[[ SECRET_1 ]]", "【SECRET_1】", "[[Secret_1]]")) {
            val r = Restorer.restore("code: $v", ctx)
            assertFalse(r.text.contains("482913"))
            assertEquals(1, r.secretsHidden)
        }
    }

    @Test fun restoredRangesAndBoundedHoldBack() {
        val r = Restorer.restore("Hi [[PERSON_1]], see [[ORG_1]].", RestoreContext(mapOf(fx["groups"].list[0])))
        assertEquals(listOf("Raj Patel", "Mercy General Hospital"), r.restoredRanges.map { r.text.substring(it.first.start, it.first.end) })
        val s = StreamingRestorer(RestoreContext(EntityMap()))
        val emitted = s.append("word ".repeat(20)).joinToString("") { (it as? RestoredSegment.Text)?.text ?: "" }
        assertEquals(100 - StreamingRestorer.HOLD_BACK, emitted.length)
    }

    @Test fun flagsAGuessedName() {
        val ctx = RestoreContext(EntityMap(listOf(Entity.make("PERSON_1", PrivacyCategory.PERSON, "Raj Patel", setOf(DetectorId.VAULT), Confidence.HIGH, surfaceForms = setOf("Raj")))))
        assertTrue(Restorer.fidelityCheck("Tell [[PERSON_1]] politely.", ctx).isClean)
        assertEquals(listOf("PERSON_1"), Restorer.fidelityCheck("Tell Raj politely.", ctx).guessedEntities)
        assertEquals(listOf("ORG_4"), Restorer.fidelityCheck("Ask [[ORG_4]].", ctx).unknownIds)
    }
}
