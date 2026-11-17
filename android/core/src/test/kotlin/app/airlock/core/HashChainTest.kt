package app.airlock.core

import kotlinx.serialization.json.JsonElement
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** Port of web/tests/hashchain.test.ts. */
class HashChainTest {
    @Test fun knownVectors() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256Hex(""))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha256Hex("abc"))
    }

    @Test fun utf8MatchesTheJdkOnWellFormedText() {
        val r = Mulberry32(11)
        val alphabet = listOf("a", "Z", " ", "é", "漢", "👩‍👩‍👧", "\n", "\u0001")
        repeat(400) { i ->
            val s = List(i % 150) { r.pick(alphabet) }.joinToString("")
            val want = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
            assertEquals(want, sha256Hex(s))
        }
        // TextEncoder semantics: a lone surrogate is encoded as U+FFFD.
        assertEquals(sha256Hex("a�b"), sha256Hex("a\ud800b"))
    }

    private fun receiptOf(j: JsonElement, hash: String) = Receipt(
        id = j["id"].str, seq = j["seq"].int, createdAt = j["createdAt"].str, threadId = j["threadId"].str,
        route = Route.entries.first { it.wire == j["route"].str }, modelVersion = j["modelVersion"].str, outboundSha256 = j["outboundSha256"].str,
        outboundChars = j["outboundChars"].int, counts = j["counts"].entries.associate { it.key to it.value.int },
        gatePassed = j["gate"]["passed"].bool, gateChecks = j["gate"]["checks"].strings, armor = requireNotNull(ArmorStatus.fromWire(j["armor"].str)),
        latencyMs = j["latencyMs"].entries.associate { it.key to it.value.int.toLong() }, prevHash = j["prevHash"].str, hash = hash,
    )

    @Test fun fixtureIsByteIdentical() {
        val f = Fixtures.element("hashchain.json")
        assertEquals(HashChain.GENESIS, f["genesis"].str)
        val links = f["chain"].list
        val receipts = links.map { receiptOf(it["receipt"], it["hash"].str) }
        links.forEachIndexed { i, link ->
            assertEquals(link["canonical"].str, HashChain.canonicalJson(HashChain.hashedFields(receipts[i])))
            assertEquals(link["hash"].str, HashChain.computeHash(receipts[i]))
        }
        assertEquals(ChainVerification.Valid(3), HashChain.verifyChain(receipts))
    }

    private fun chain(n: Int): MutableList<Receipt> {
        val out = ArrayList<Receipt>()
        var prev = HashChain.GENESIS
        for (i in 1..n) {
            val r = HashChain.sealReceipt(
                Receipt(
                    id = "rcpt_$i", seq = i, createdAt = "2026-11-2${i % 10}T10:00:00Z", threadId = "thr_${i % 7}", route = Route.entries[i % 4],
                    modelVersion = "m${i % 3}", outboundSha256 = sha256Hex(i.toString()), outboundChars = i * 10, counts = mapOf("person" to i % 5, "org" to i % 2),
                    gatePassed = true, gateChecks = listOf("G1", "G2"), armor = ArmorStatus.NOT_CONFIGURED, latencyMs = mapOf("seal" to i.toLong()), prevHash = prev, hash = "",
                ),
            )
            out.add(r)
            prev = r.hash
        }
        return out
    }

    @Test fun verifiesAThousandAndIgnoresLocalText() {
        val c = chain(1000)
        assertEquals(ChainVerification.Valid(1000), HashChain.verifyChain(c))
        assertEquals(c[0].hash, HashChain.computeHash(c[0].copy(outboundText = "anything")))
    }

    @Test fun singleChangedFieldIsCaught() {
        for (i in listOf(0, 1, 17, 499, 999)) {
            val c = chain(1000)
            c[i] = c[i].copy(outboundChars = c[i].outboundChars + 1)
            assertEquals(ChainVerification.Invalid(i, i + 1, ChainVerification.Reason.HASH_MISMATCH), HashChain.verifyChain(c))
        }
    }

    @Test fun forgeriesGapsAndGenesis() {
        val c = chain(10)
        c[4] = HashChain.sealReceipt(c[4].copy(modelVersion = "forged"))
        assertEquals(ChainVerification.Invalid(5, 6, ChainVerification.Reason.PREV_HASH_MISMATCH), HashChain.verifyChain(c))
        val gap = chain(3)
        gap.removeAt(1)
        assertEquals(ChainVerification.Invalid(1, 3, ChainVerification.Reason.SEQ_GAP), HashChain.verifyChain(gap))
        assertEquals(ChainVerification.Invalid(0, 2, ChainVerification.Reason.GENESIS_MISMATCH), HashChain.verifyChain(chain(3).drop(1)))
        assertEquals(ChainVerification.Valid(0), HashChain.verifyChain(emptyList()))
    }

    @Test fun canonicalEscapingAndOrdering() {
        assertEquals("{\"a\":[\"q\\\"\\\\\\n\\t\\u0001é\",true,null],\"b\":-1}", HashChain.canonicalJson(mapOf("b" to -1, "a" to listOf("q\"\\\n\t\u0001é", true, null))))
        assertFailsWith<IllegalArgumentException> { HashChain.canonicalJson(1.5) }
        assertEquals(1, Mulberry32(1).int(1, 1))
    }
}
