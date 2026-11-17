package app.airlock.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class TypesTest {
    @Test fun placeholderGrammar() {
        assertEquals(Placeholders.Parsed(PrivacyCategory.PERSON, 1), Placeholders.parse("PERSON_1"))
        assertEquals(Placeholders.Parsed(PrivacyCategory.PERSON, null), Placeholders.parse("person_me"))
        assertEquals(PrivacyCategory.LOCATION, Placeholders.parse("LOC_12")?.category)
        for (bad in listOf("ORG_ME", "PERSON_01", "PERSON_", "_1", "QUASI_1", "FOO_1", "PERSON_1x", "PERSON_0")) assertNull(Placeholders.parse(bad), bad)
        assertFailsWith<IllegalArgumentException> { Placeholders.make(PrivacyCategory.QUASI, 1) }
        assertEquals("[[ORG_2]]", Placeholders.token(Placeholders.make(PrivacyCategory.ORG, 2)))
    }

    @Test fun orderingIsCategoryPriorityThenMeThenNumber() {
        val ids = listOf("LOC_1", "PERSON_2", "SECRET_1", "PERSON_ME", "PERSON_10", "ID_3", "CONTACT_1", "PERSON_1")
        assertEquals(listOf("SECRET_1", "ID_3", "CONTACT_1", "PERSON_ME", "PERSON_1", "PERSON_2", "PERSON_10", "LOC_1"), ids.sortedWith(Placeholders.ORDER))
    }

    @Test fun entityMapNextIdSkipsMe() {
        val m = EntityMap(listOf(
            Entity.make(Placeholders.ME, PrivacyCategory.PERSON, "Maya Chen", setOf(DetectorId.VAULT), Confidence.HIGH),
            Entity.make("PERSON_2", PrivacyCategory.PERSON, "Raj", setOf(DetectorId.LLM), Confidence.MEDIUM),
        ))
        assertEquals("PERSON_3", m.nextId(PrivacyCategory.PERSON))
        assertEquals("ORG_1", m.nextId(PrivacyCategory.ORG))
        assertEquals(listOf("PERSON_ME", "PERSON_2"), m.sorted().map { it.id })
        assertEquals(setOf("Raj"), m["PERSON_2"]?.surfaceForms)
    }

    @Test fun actionWireForm() {
        for (s in listOf("placeholder", "keep", "block", "generalise:2")) assertEquals(s, Action.parse(s).wire)
        assertEquals(false, Action.Keep.mustNotEgress)
    }

    @Test fun mulberryMatchesTheWebSequence() {
        // web: rng(42)() x3 — shared so property tests reproduce across platforms.
        val r = Mulberry32(42)
        assertEquals(listOf(0.6011037519201636, 0.44829055899754167, 0.8524657934904099), List(3) { r.next() })
    }

    @Test fun fixturesAreReachable() {
        assertEquals(true, Fixtures.repoFile("spec/fixtures/gate.json").isFile)
    }
}
