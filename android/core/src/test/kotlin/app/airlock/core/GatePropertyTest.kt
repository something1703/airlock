package app.airlock.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.fail

/**
 * Port of web/tests/gate-property.test.ts — docs/09-TESTING.md §2: 10,000 seeded cases (same seed and RNG call order
 * as the web). Clean drafts must always pass; every mutation (surface form, Vault alias with random case/diacritics,
 * pattern instance, zero-width variant, homoglyph variant, partial organisation name) must always block.
 */
class GatePropertyTest {
    private val PEOPLE = listOf("Raj Patel", "Lena Okafor", "Tomasz Wiśniewski", "Aiko Tanaka", "Jorge Álvarez", "Priya Natarajan", "Dmitri Volkov", "Siobhan Kearney")
    private val ORGS = listOf("Brightline Logistics", "Harbor View Clinic", "Northgate Academy")
    private val FILLER = ("the heater has been broken for three weeks and nobody called back about repair please help me reply firmly landlord says it is fine " +
        "but not cold apartment since october we talked yesterday again today kind of frustrating thanks a lot").split(" ")
    private val CONFUSABLES = mapOf("a" to "а", "e" to "е", "o" to "о", "p" to "р", "c" to "с", "i" to "і")
    private val ZERO_WIDTH = listOf("​", "‌", "‍", "⁠", "﻿")
    private val ACCENTS = mapOf("a" to "á", "e" to "é", "i" to "í", "o" to "ó", "u" to "ú", "n" to "ñ")
    private val IBANS = listOf("GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606")

    private class Scenario(val entities: List<Entity>, val vault: List<VaultEntry>)

    private fun <T> shuffle(r: Mulberry32, xs: List<T>): MutableList<T> {
        val a = xs.toMutableList()
        for (i in a.size - 1 downTo 1) {
            val j = (r.next() * (i + 1)).toInt()
            val t = a[i]; a[i] = a[j]; a[j] = t
        }
        return a
    }

    private fun scenario(r: Mulberry32): Scenario {
        val names = shuffle(r, PEOPLE)
        val vaultName = names.removeAt(0)
        val count = r.int(1, 3)
        val entities = ArrayList<Entity>()
        for (i in 0 until count) {
            val name = names[i]
            entities.add(Entity.make("PERSON_${i + 1}", PrivacyCategory.PERSON, name, setOf(DetectorId.LLM), Confidence.HIGH, surfaceForms = linkedSetOf(name, name.split(" ")[0])))
        }
        val org = r.pick(ORGS)
        entities.add(Entity.make("ORG_1", PrivacyCategory.ORG, org, setOf(DetectorId.LLM), Confidence.HIGH, surfaceForms = setOf(org), action = Action.Generalise(2), generalisedText = "an organisation"))
        return Scenario(entities, listOf(VaultEntry("v1", vaultName, listOf(vaultName.split(" ")[0]), PrivacyCategory.PERSON, "my sister", false)))
    }

    private fun cleanDraft(s: Scenario, r: Mulberry32): Pair<MutableList<String>, List<LegendLine>> {
        val words = MutableList(r.int(4, 30)) { r.pick(FILLER) }
        val people = s.entities.filter { it.category == PrivacyCategory.PERSON }
        val used = LinkedHashSet<String>()
        var i = r.int(1, 3)
        while (i > 0) {
            val e = r.pick(people)
            used.add(e.id)
            val pos = r.int(0, words.size)
            val suffix = if (r.next() < 0.5) "'s" else ""
            words.add(pos, Placeholders.token(e.id) + suffix)
            i--
        }
        if (r.next() < 0.5) words.add(r.int(0, words.size), "an organisation")
        return words to used.sortedWith(Placeholders.ORDER).map { LegendLine(it, "the user's landlord") }
    }

    private fun card(r: Mulberry32): String {
        val digits = mutableListOf(4)
        repeat(14) { digits.add(r.int(0, 9)) }
        var sum = 0
        digits.reversed().forEachIndexed { i, d ->
            val x = if (i % 2 == 0) d * 2 else d
            sum += if (x > 9) x - 9 else x
        }
        digits.add((10 - (sum % 10)) % 10)
        val s = digits.joinToString("")
        return if (r.next() < 0.5) s else listOf(0, 4, 8, 12).joinToString(" ") { s.substring(it, it + 4) }
    }

    private fun mutation(kind: Int, s: Scenario, r: Mulberry32): String {
        val forms = shuffle(r, s.entities.flatMap { it.surfaceForms })
        return when (kind) {
            0 -> forms[0] + if (r.next() < 0.5) "'s" else ""
            1 -> {
                val term = r.pick(s.vault[0].allTerms())
                Js.codePoints(term).joinToString("") { ch ->
                    var c = ch
                    val a = ACCENTS[ch.lowercase()]
                    if (a != null && r.int(0, 2) == 0) c = a
                    if (r.next() < 0.5) c.uppercase() else c.lowercase()
                }
            }
            2 -> when (r.int(0, 4)) {
                0 -> card(r)
                1 -> r.pick(IBANS)
                2 -> "user${r.int(1, 9999)}@mail.example.org"
                3 -> "312-555-${r.int(0, 9999).toString().padStart(4, '0')}"
                else -> {
                    val a = r.int(100, 665)
                    val b = r.int(10, 99)
                    val c = r.int(1000, 9999)
                    "$a-$b-$c"
                }
            }
            3 -> {
                val chars = Js.codePoints(forms[0]).toMutableList()
                val pos = r.int(1, chars.size - 1)
                chars.add(pos, r.pick(ZERO_WIDTH))
                chars.joinToString("")
            }
            5 -> {
                val org = s.entities.first { it.category == PrivacyCategory.ORG }.canonical.split(" ")
                if (r.next() < 0.5) org.take(2).joinToString(" ") else org[0]
            }
            else -> {
                val form = forms.firstOrNull { f -> Js.codePoints(f).any { it in CONFUSABLES } } ?: forms[0]
                val chars = Js.codePoints(form).toMutableList()
                val idx = chars.indices.filter { chars[it] in CONFUSABLES }
                if (idx.isNotEmpty()) {
                    val i = r.pick(idx)
                    chars[i] = CONFUSABLES.getValue(chars[i])
                }
                chars.joinToString("")
            }
        }
    }

    private fun draftOf(text: String, legend: List<LegendLine>, map: EntityMap) = SealDraft(text, legend, emptyList(), map, emptyList(), emptySet(), emptySet())

    @Test fun tenThousandCases() {
        val r = Mulberry32(20261116)
        val patterns = PatternDetector()
        var falseBlocks = 0
        var misses = 0
        for (i in 0 until 10_000) {
            val s = scenario(r)
            val gate = EgressGate(patterns, s.vault)
            val map = EntityMap(s.entities)
            val (words, legend) = cleanDraft(s, r)
            if (i % 2 == 0) {
                try {
                    gate.seal(draftOf(words.joinToString(" "), legend, map))
                } catch (e: GateBlocked) {
                    falseBlocks++
                    if (falseBlocks <= 3) fail("false block on clean draft: ${words.joinToString(" ")} → ${e.checks}")
                }
            }
            val mutated = words.toMutableList()
            val kind = i % 6
            val pos = r.int(0, mutated.size)
            mutated.add(pos, mutation(kind, s, r))
            val text = mutated.joinToString(" ")
            try {
                gate.seal(draftOf(text, legend, map))
                misses++
                if (misses <= 5) fail("mutation kind $kind passed the gate: $text")
            } catch (_: GateBlocked) {
            }
        }
        assertEquals(0, falseBlocks)
        assertEquals(0, misses)
    }
}
