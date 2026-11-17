package app.airlock.core

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail

/** Port of web/tests/seal.test.ts (policy, merger, generaliser, money, seal pipeline, egress gate fixtures). */
class SealTest {
    private val patterns = PatternDetector()
    private fun utc(s: String): Instant = Instant.parse("${s}T00:00:00Z")

    private val PREFIX = mapOf("person" to "PERSON", "org" to "ORG", "location" to "LOC", "contact" to "CONTACT", "id" to "ID", "date" to "DATE", "health" to "HEALTH", "secret" to "SECRET")

    @Test fun policyFixture() {
        val cases = Fixtures.element("policy.json")["cases"].list
        assertTrue(cases.size >= 40)
        for (c in cases) {
            val dial = DialPreset.entries.first { it.wire == c["dial"].str }
            val engine = PolicyEngine(dial, PolicySettings(protectHealth = c["protectHealth"].bool))
            val category = c["category"].str
            val e = Entity.make(
                id = if (category == "quasi") "PERSON_ME" else "${PREFIX[category]}_1", category = cat(category), canonical = c["canonical"].str,
                sources = setOf(DetectorId.LLM), confidence = Confidence.HIGH, subtype = c["subtype"].strOrNull, vaultEntryId = if (c["vault"].bool) "v" else null,
            )
            val o = c["override"].takeUnless { it.isNull }?.let { UserOverride(Action.parse(it["action"].str), it["revealThisTime"].bool) }
            assertEquals(c["expected"].str, engine.action(e, o).wire, "${c["dial"].str} $category/${c["subtype"].strOrNull} override=${c["override"]}")
        }
    }

    @Test fun modesPerDial() {
        assertEquals(RedTeamMode.OFF, PolicyEngine(DialPreset.OPEN).redTeamMode)
        assertEquals(ReviewMode.IF_LOW_CONFIDENCE_OR_RISK, PolicyEngine(DialPreset.BALANCED).reviewMode)
        assertEquals(ReviewMode.ALWAYS, PolicyEngine(DialPreset.STRICT).reviewMode)
        assertTrue(PolicyEngine(DialPreset.STRICT).bucketsMoney)
    }

    private fun candidateOf(x: kotlinx.serialization.json.JsonElement, detector: DetectorId? = null) = Candidate(
        span = TextSpan(x["start"].int, x["end"].int), text = x["text"].str, category = cat(x["category"].str), subtype = x["subtype"].strOrNull,
        detector = detector ?: requireNotNull(DetectorId.fromWire(x["detector"].str)), confidence = Confidence.HIGH, roleHint = x["roleHint"].strOrNull,
        sameAs = x["sameAs"].strOrNull, vaultEntryId = x["vaultEntryId"].strOrNull,
    )

    @Test fun mergeFixture() {
        for (c in Fixtures.element("merge.json")["cases"].list) {
            val name = c["name"].str
            val r = Merger.merge(c["candidates"].list.map { candidateOf(it) }, c["text"].str, EntityMap(c["existing"].list.map(::fixtureEntity)), c["vault"].list.map(::fixtureVault))
            val expect = c["expect"]
            for (e in expect["entities"].list) {
                val got = assertNotNull(r.entities[e["id"].str], "[$name] missing ${e["id"].str}; have ${r.entities.keys()}")
                assertEquals(e["canonical"].str, got.canonical, "[$name] canonical of ${e["id"].str}")
                for (f in e["formsInclude"].strings) assertTrue(f in got.surfaceForms, "[$name] ${e["id"].str} forms lack $f")
                e["confidence"].strOrNull?.let { assertEquals(it, got.confidence.wire) }
                e["vaultEntryId"].strOrNull?.let { assertEquals(it, got.vaultEntryId) }
            }
            assertEquals(expect["entities"].list.size, r.entities.size, "[$name] entity count")
            assertEquals(expect["mentions"].list.map { it.strings }, r.mentions.map { listOf(it.text, it.entityId) }, "[$name] mentions")
            assertEquals(expect["ambiguous"].list.map { "${it.strings[0]}>${it.strings[1]}" }.toSet(), r.ambiguous.map { "${it.entity}>${it.possiblySameAs}" }.toSet(), "[$name] ambiguous")
        }
    }

    @Test fun idsFollowFirstAppearance() {
        val text = "Lena met Omar and Lena left."
        fun mk(t: String, s: Int) = Candidate(TextSpan(s, s + 4), t, PrivacyCategory.PERSON, detector = DetectorId.LLM, confidence = Confidence.HIGH)
        assertEquals(listOf("PERSON_1", "PERSON_2", "PERSON_1"), Merger.merge(listOf(mk("Omar", 9), mk("Lena", 0), mk("Lena", 18)), text).mentions.map { it.entityId })
    }

    private val today = utc("2026-11-21")
    private fun dateEntity(canonical: String, subtype: String) = Entity.make("DATE_1", PrivacyCategory.DATE, canonical, setOf(DetectorId.PATTERN), Confidence.HIGH, subtype = subtype)

    @Test fun agesFromDob() {
        assertEquals("late 30s", Generaliser.ladderDefault(dateEntity("4 Mar 1989", "dob"), 2, today))
        assertEquals("30s", Generaliser.ladderDefault(dateEntity("4 Mar 1989", "dob"), 3, today))
        assertEquals("a teenager", Generaliser.ladderDefault(dateEntity("2010-05-01", "dob"), 2, today))
        assertEquals("a teenager", Generaliser.ageDescription(utc("2010-12-25"), today, false))
    }

    @Test fun relativeDates() {
        for ((raw, expected) in listOf("Oct 28" to "3 weeks ago", "2026-11-20" to "yesterday", "21/11/2026" to "today", "Dec 5, 2026" to "in 2 weeks", "2025-11-21" to "about 1 year ago", "not a date" to "a recent date")) {
            assertEquals(expected, Generaliser.ladderDefault(dateEntity(raw, "date"), 1, today), raw)
        }
        assertEquals("tomorrow", Generaliser.relativeDescription(utc("2026-11-22"), today))
    }

    @Test fun validatesRewrites() {
        val map = EntityMap(listOf(Entity.make("ORG_1", PrivacyCategory.ORG, "Mercy General Hospital", setOf(DetectorId.LLM), Confidence.HIGH, surfaceForms = setOf("Mercy General"), action = Action.Generalise(2))))
        fun ok(r: String) = Generaliser.validateRewrite(r, "Mercy General Hospital", map, patterns)
        assertTrue(ok("a large hospital"))
        for (bad in listOf("", "a very large and busy teaching hospital in the city centre", "Mercy General Hospital", "the Mercy General campus", "call 312-555-0147", "[[ORG_1]]")) assertFalse(ok(bad), bad)
    }

    @Test fun moneyBuckets() {
        assertEquals("$1,000–1,500", Money.bucket(1240.0, "$"))
        assertEquals("€85–90", Money.bucket(85.0, "€"))
        assertEquals("under £10", Money.bucket(7.0, "£"))
        assertEquals(listOf("$1,000–1,500", "₹45,000–50,000"), Money.findMoney("Rent is $1,240.50 and ₹45000, not 1,240.").map { it.bucket })
        assertEquals("1e+21", Money.jsNumberString(1e21))
        assertEquals("1152921504606847000", Money.jsNumberString(Math.pow(2.0, 60.0)))
    }

    @Test fun roleRewriting() {
        assertEquals("the user's landlord", Sealer.rewriteRole("the writer's landlord"))
        assertEquals("the user's sister", Sealer.rewriteRole("my sister"))
        assertEquals("the user", Sealer.rewriteRole("me"))
        assertEquals("the user's landlord", Sealer.rewriteRole("landlord"))
        assertEquals("a coworker", Sealer.rewriteRole("a coworker"))
    }

    private class Run(val draft: SealDraft, val merge: MergeResult)

    /** The deterministic pipeline as the app runs it (minus the on-device LLM, whose candidates are given). */
    private fun runPipeline(raw: String, vault: List<VaultEntry>, llm: List<Candidate>, dial: DialPreset, today: Instant, overrides: Map<PlaceholderId, UserOverride> = emptyMap()): Run {
        val n = Normaliser.normalise(raw)
        val candidates = VaultMatcher(vault).detect(n.text) + patterns.detect(n.text) + llm
        val m = Merger.merge(candidates, n.text, EntityMap(), vault)
        return Run(Sealer(PolicyEngine(dial), patterns, today).draft(n, m, overrides), m)
    }

    @Test fun sealFixture() {
        for (c in Fixtures.element("seal.json")["cases"].list) {
            val name = c["name"].str
            val llm = c["llm"].list.map { candidateOf(it, DetectorId.LLM).copy(sameAs = null, vaultEntryId = null) }
            val vault = c["vault"].list.map(::fixtureVault)
            val overrides = c["overrides"].list.associate { it["id"].str to UserOverride(Action.parse(it["action"].str), it["revealThisTime"].bool) }
            val run = runPipeline(c["text"].str, vault, llm, DialPreset.entries.first { it.wire == c["dial"].str }, utc(c["today"].str), overrides)
            assertEquals(c["expectedText"].str, run.draft.text, "[$name]")
            assertEquals(c["expectedLegend"].list.map { it.strings }, run.draft.legend.map { listOf(it.placeholder, it.description) }, "[$name] legend")
            try {
                EgressGate(patterns, vault).seal(run.draft)
            } catch (e: GateBlocked) {
                fail("[$name] gate must pass: ${e.checks}")
            }
        }
    }

    @Test fun replacementsMapBack() {
        val vault = listOf(VaultEntry("v", "Raj", emptyList(), PrivacyCategory.PERSON, "my landlord", false))
        val run = runPipeline("Hi Raj, call 312-555-0147.", vault, emptyList(), DialPreset.BALANCED, Instant.now())
        for (r in run.draft.replacements) assertEquals("[[${r.entityId}]]", run.draft.text.substring(r.sealedSpan.start, r.sealedSpan.end))
        assertEquals("Hi [[PERSON_1]], call [[CONTACT_1]].", run.draft.text)
    }

    @Test fun leakyRoleHintFallsBack() {
        val llm = listOf(Candidate(TextSpan(0, 11), "Lena Okafor", PrivacyCategory.PERSON, detector = DetectorId.LLM, confidence = Confidence.HIGH, roleHint = "Okafor's manager at a@b.co"))
        assertEquals("a person mentioned in the message", runPipeline("Lena Okafor emailed.", emptyList(), llm, DialPreset.BALANCED, Instant.now()).draft.legend[0].description)
    }

    @Test fun gateFixture() {
        for (c in Fixtures.element("gate.json")["cases"].list) {
            val name = c["name"].str
            val gate = EgressGate(patterns, c["vault"].list.map(::fixtureVault), GateLimits(c["maxUTF16"].intOrNull ?: 40_000))
            val map = EntityMap(c["entities"].list.map(::fixtureEntity))
            val legend = c["legend"].list.map { LegendLine(it.strings[0], it.strings[1]) }
            val pass = c["pass"].bool
            try {
                val sealed = if (c["toolResult"].bool) gate.sealToolResult(c["text"].str, map)
                else gate.seal(SealDraft(c["text"].str, legend, emptyList(), map, emptyList(), c["revealed"].strings.toSet(), c["kept"].strings.map { FoldedSearch.fold(it) }.toSet()))
                assertTrue(pass, "[$name] should have been blocked")
                assertEquals(c["text"].str, sealed.value)
                assertEquals(GateCheckId.entries.toList(), sealed.gateReport.checksPassed)
                assertFalse(sealed.gateReport.bypassed)
            } catch (e: GateBlocked) {
                assertFalse(pass, "[$name] false block: ${e.checks}")
                for (must in c["mustInclude"].strings) assertTrue(GateCheckId.valueOf(must) in e.checks, "[$name] expected $must")
            }
        }
    }

    @Test fun gateErrorCarriesNoValues() {
        val gate = EgressGate(patterns, listOf(VaultEntry("v", "Maya Chen", emptyList(), PrivacyCategory.PERSON, isUser = false)))
        val e = assertFailsWith<GateBlocked> {
            gate.seal(SealDraft("From Maya Chen, maya@example.com", emptyList(), emptyList(), EntityMap(), emptyList(), emptySet(), emptySet()))
        }
        val dump = e.toString() + e.message + e.hits.toString()
        assertFalse(Regex("Maya|example\\.com").containsMatchIn(dump))
        assertEquals(setOf(GateCheckId.G1, GateCheckId.G3), e.checks)
    }

    @Test fun hashesAndDebugBypass() {
        val e = Entity.make("PERSON_1", PrivacyCategory.PERSON, "Raj Patel", setOf(DetectorId.LLM), Confidence.HIGH)
        val draft = SealDraft("Hi [[PERSON_1]].", listOf(LegendLine("PERSON_1", "the user's landlord")), emptyList(), EntityMap(listOf(e)), emptyList(), emptySet(), emptySet())
        val sealed = EgressGate(patterns, emptyList()).seal(draft)
        assertEquals("[[PERSON_1]] — the user's landlord", sealed.renderedLegend())
        assertEquals(1, sealed.gateReport.counts["person"])
        assertEquals(sha256Hex("Hi [[PERSON_1]].\n\n[[PERSON_1]] — the user's landlord"), sealed.gateReport.outboundSha256)
        val err = assertFailsWith<IllegalStateException> { EgressGate(patterns, emptyList()).sealBypassingChecks(draft) }
        assertTrue(err.message!!.contains("disabled"))
        val bypassed = EgressGate(patterns, emptyList(), allowDebugBypass = true).sealBypassingChecks(draft.copy(text = "card 4111 1111 1111 1111"))
        assertTrue(bypassed.gateReport.bypassed && bypassed.gateReport.checksPassed.isEmpty())
        assertFalse(Action.Keep.mustNotEgress)
        assertNull(Placeholders.parse("PERSON_ME")?.index)
    }
}
