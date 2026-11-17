package app.airlock.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/** Port of web/tests/detect.test.ts. */
class DetectTest {
    @Test fun packsAreTheSwiftResources() {
        for (f in listOf("core", "national")) {
            val swift = Fixtures.repoFile("Packages/AirlockKit/Sources/AirlockDetect/PatternPacks/$f.json").readText()
            val bundled = requireNotNull(javaClass.getResourceAsStream("/airlock/packs/$f.json")).use { it.readBytes().toString(Charsets.UTF_8) }
            assertEquals(swift, bundled, "$f drifted")
        }
        assertEquals(listOf("core", "national"), PatternPacks.BUNDLED.map { it.id })
    }

    @Test fun validatorsFixture() {
        var checked = 0
        for ((name, cases) in Fixtures.element("validators.json").entries) {
            if (cases !is kotlinx.serialization.json.JsonArray) continue
            val v = assertNotNull(Validators.named(name), "no validator $name")
            for (c in cases) {
                assertEquals(c["valid"].bool, v(c["input"].str), "$name(${c["input"].str})")
                checked++
            }
        }
        assertTrue(checked > 40)
    }

    @Test fun normaliseFixture() {
        for (c in Fixtures.element("normalise.json")["cases"].list) assertEquals(c["expected"].str, Normaliser.normalise(c["input"].str).text, c["name"].str)
    }

    @Test fun normaliseRandomIsIdempotentWithMonotonicOffsets() {
        val r = Mulberry32(7)
        val pieces = listOf("Raj", " ", "  ", "​", "“", "”", "Ｒ", "ﬁ", "\r\n", "é", "é", "👩‍👩‍👧", "\t", "14 Elm St", "‮", "@", "x")
        repeat(500) {
            val input = List(r.int(1, 30)) { r.pick(pieces) }.joinToString("")
            val n = Normaliser.normalise(input)
            assertEquals(n.text.length + 1, n.originalOffsets.size)
            assertEquals(input.length, n.originalOffsets.last())
            for (k in 1 until n.originalOffsets.size) assertTrue(n.originalOffsets[k] >= n.originalOffsets[k - 1])
            assertEquals(n.text, Normaliser.normalise(n.text).text)
            assertTrue(Normaliser.isNormalised(n.text))
        }
    }

    @Test fun mapsSpanBackToOriginal() {
        val original = "Hi​  “Raj Patel”"
        val n = Normaliser.normalise(original)
        val span = FoldedSearch.ranges("Raj Patel", n.text)[0]
        val back = n.toOriginal(span)
        assertEquals("Raj Patel", original.substring(back.start, back.end))
    }

    @Test fun foldedSearch() {
        assertEquals(listOf(0), FoldedSearch.ranges("Raj", "Raj's car, not Rajesh").map { it.start })
        assertTrue(FoldedSearch.contains("José", "jose said"))
        assertTrue(FoldedSearch.contains("Raj Patel", "RAJ\n  PATEL"))
        assertFalse(FoldedSearch.contains("Raj Patel", "Raj Patelson"))
        assertEquals(emptyList(), FoldedSearch.ranges("  ", "a  b"))
        assertFalse(FoldedSearch.contains("Will", "I will call", true))
        assertTrue(FoldedSearch.contains("Will", "Will called", true))
        assertTrue(FoldedSearch.contains("José", "Jose called", true))
        val text = "the ﬁle of Raj"
        val span = FoldedSearch.ranges("Raj", text)[0]
        assertEquals("Raj", text.substring(span.start, span.end))
    }

    @Test fun patternsFixture() {
        val detector = PatternDetector()
        val fx = Fixtures.element("patterns.json")
        // Fake secrets are stored in parts so no key-shaped string exists in the repo; join them here.
        val templates = fx["templates"].entries.associate { (k, v) -> k to v.strings.joinToString("") }
        fun expand(s: String) = templates.entries.fold(s) { acc, (k, v) -> acc.replace("{{$k}}", v) }
        for (c in fx["cases"].list) {
            val name = c["name"].str
            val text = expand(c["text"].str)
            val found = detector.detect(text)
            for (e in c["expect"].list) {
                val t = expand(e["text"].str)
                assertTrue(found.any { it.text == t && it.category.wire == e["category"].str && it.subtype == e["subtype"].str },
                    "[$name] expected $t; got ${found.map { "${it.text}=${it.category.wire}/${it.subtype}" }}")
            }
            for (a in c["absent"].list) {
                val t = expand(a["text"].str)
                val sub = a["subtype"].strOrNull
                assertFalse(found.any { it.text == t && (sub == null || it.subtype == sub) }, "[$name] $t must not be detected")
            }
            for (f in found) assertEquals(f.text, text.substring(f.span.start, f.span.end))
        }
    }

    @Test fun neverOverlapping() {
        val found = PatternDetector().detect("Card 4111 1111 1111 1111, SSN 123-45-6789, call 312-555-0147, mail a@b.co, code 4821, Order #ZX81234.")
        for (i in found.indices) for (j in i + 1 until found.size) assertTrue(found[i].span.end <= found[j].span.start || found[j].span.end <= found[i].span.start)
    }

    @Test fun randomInsertedIds() {
        val r = Mulberry32(42)
        val filler = "the heater has been broken for three weeks and nobody has called back about the repair yet".split(" ")
        val secrets = listOf(
            Triple("4111 1111 1111 1111", PrivacyCategory.ID, "card"), Triple("5555555555554444", PrivacyCategory.ID, "card"),
            Triple("GB82WEST12345698765432", PrivacyCategory.ID, "iban"), Triple("maya.chen@example.com", PrivacyCategory.CONTACT, "email"),
            Triple("r.patel+rent@mail.example.org", PrivacyCategory.CONTACT, "email"), Triple("123-45-6789", PrivacyCategory.ID, "ssn"),
            Triple("+44 20 7946 0958", PrivacyCategory.CONTACT, "phone"), Triple("312-555-0147", PrivacyCategory.CONTACT, "phone"),
            Triple("sk-" + "abcdefghijklmnopqrstuv12", PrivacyCategory.SECRET, "api_key"),
        )
        repeat(1000) {
            val words = MutableList(r.int(3, 25)) { r.pick(filler) }
            val (value, category, subtype) = r.pick(secrets)
            words.add(r.int(0, words.size), value)
            val text = words.joinToString(" ") + r.pick(listOf(".", ",", "", "!", ";"))
            val found = PatternDetector().detect(text)
            assertTrue(found.any { it.text == value && it.category == category && it.subtype == subtype }, "$value not found in: $text")
        }
    }

    @Test fun disablingAPackAndBadRules() {
        assertFalse(PatternDetector(PatternPacks.BUNDLED, setOf("national")).detect("PAN ABCPE1234F").any { it.subtype == "national_id" })
        val bad = assertFailsWith<IllegalArgumentException> { PatternDetector(listOf(PatternPack("x", "", listOf(PatternRule("bad", "id", "x", "low", "("))))) }
        assertTrue(bad.message!!.contains("bad"))
        val unknown = assertFailsWith<IllegalArgumentException> { PatternDetector(listOf(PatternPack("x", "", listOf(PatternRule("r", "id", "x", "low", "a", validator = "nope"))))) }
        assertTrue(unknown.message!!.contains("unknown validator"))
    }

    @Test fun vaultFixture() {
        val fx = Fixtures.element("vault.json")
        val matcher = VaultMatcher(fx["entries"].list.map(::fixtureVault))
        for (c in fx["cases"].list) {
            val found = matcher.detect(c["text"].str)
            for (e in c["expect"].list) assertTrue(found.any { it.text == e["text"].str && it.vaultEntryId == e["entryId"].str }, "[${c["name"].str}] expected ${e["text"].str}; got ${found.map { it.text }}")
            for (a in c["absent"].strings) assertFalse(found.any { it.text == a }, "[${c["name"].str}] $a must not match")
            assertTrue(found.all { it.detector == DetectorId.VAULT && it.confidence == Confidence.HIGH })
        }
        val hit = VaultMatcher(listOf(VaultEntry("me", "Maya Chen", emptyList(), PrivacyCategory.PERSON, "me", true))).detect("Sincerely, Maya Chen")[0]
        assertEquals("the user", hit.roleHint)
        assertEquals("self", hit.subtype)
    }
}
