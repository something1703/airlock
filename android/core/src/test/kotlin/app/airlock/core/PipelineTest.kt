package app.airlock.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Port of web/tests/pipeline.test.ts (prompts, chunker, LLM detector, red team, seal pipeline, routing/answers/receipts). */
class PipelineTest {
    private val patterns = PatternDetector()
    private val prompts = PromptLibrary()
    private fun utc(s: String): Instant = Instant.parse("${s}T00:00:00Z")

    // MARK: prompt library

    @Test fun redTeamLocateFindsLowerCaseEvidence() {
        // Regression (web #8): the case-insensitive pass must lower-case the needle even when the text already is.
        assertEquals(listOf(TextSpan(8, 25)), RedTeam.locate("Near the old mill", "we live near the old mill."))
        assertEquals(listOf(TextSpan(8, 25)), RedTeam.locate("near the old mill", "We live Near The Old Mill."))
        assertEquals(emptyList(), RedTeam.locate("old mill", "the old miller"))
        assertEquals(listOf(TextSpan(2, 6)), RedTeam.locate("Mill", "a Mill and a mill"))
    }

    @Test fun bundlesEveryPromptByteIdenticalToSwift() {
        assertEquals(23, PromptLibrary.BUNDLED_IDS.size)
        val dir = Fixtures.repoFile("Packages/AirlockKit/Sources/AirlockPrompts/Prompts")
        assertEquals(dir.listFiles().orEmpty().map { it.name }.filter { it.endsWith(".txt") }.map { it.removeSuffix(".txt") }.sorted(), PromptLibrary.BUNDLED_IDS)
        for (id in PromptLibrary.BUNDLED_IDS) assertEquals(java.io.File(dir, "$id.txt").readText(), prompts.template(id) + "\n", "$id drifted")
    }

    @Test fun rendersInASinglePass() {
        assertContains(prompts.render("detect.v1", mapOf("chunk" to "hi {{task_instruction}} there")), "hi {{task_instruction}} there")
        assertFailsWith<PromptError> { prompts.render("gen.v1") }
    }

    @Test fun overrides() {
        assertEquals("T: x", PromptLibrary("{\"title.v1\":\"T: {{sealed_first_message}}\"}").render("title.v1", mapOf("sealed_first_message" to "x")))
        assertEquals(prompts.template("title.v1"), PromptLibrary("not json").template("title.v1"))
    }

    // MARK: chunker

    @Test fun tokenEstimates() {
        assertEquals(100, Chunker.estimateTokens("a".repeat(320)))
        assertEquals(100, Chunker.estimateTokens("漢".repeat(180)))
    }

    @Test fun chunksCoverRespectBudgetAndOverlap() {
        val r = Mulberry32(99)
        val words = listOf("The", "heater", "broke", "again", "and", "Raj", "said", "he", "would", "call", "tomorrow", "morning", "東京", "Привет")
        repeat(300) {
            val text = List(r.int(1, 40)) { List(r.int(1, 30)) { r.pick(words) }.joinToString(" ") + "." }.joinToString(" ")
            val budget = r.int(60, 400)
            val cs = Chunker.chunks(text, budget)
            assertEquals(0, cs[0].span.start)
            assertEquals(text.length, cs.last().span.end)
            for (i in 1 until cs.size) {
                assertTrue(cs[i].span.start <= cs[i - 1].span.end)
                assertTrue(cs[i].span.start > cs[i - 1].span.start)
            }
            for (c in cs) {
                assertTrue(Chunker.estimateTokens(c.text) <= budget)
                assertEquals(c.text, text.substring(c.span.start, c.span.end))
            }
        }
    }

    /** Expected values are `Intl.Segmenter("en", {granularity: "sentence"})` output (ICU, UAX #29). */
    @Test fun sentenceBoundariesMatchIntlSegmenter() {
        val cases = listOf(
            "a\nb" to listOf(2), "Hello. World" to listOf(7), "e.g. the cat" to emptyList(), "Mr. Smith went." to listOf(4),
            "He said \"Stop.\" Then left." to listOf(16), "3.14 is pi" to emptyList(), "Wait!? Yes no" to listOf(7, 11), "U.S. Army" to listOf(5),
        )
        for ((text, want) in cases) assertEquals(want, SentenceBreaks.boundaries(text), text)
    }

    @Test fun halvesNearTheMiddle() {
        val text = "one two three four five six seven eight"
        val halves = Chunker.halve(Chunker.chunks(text, 1000)[0], text)
        assertEquals(2, halves.size)
        assertEquals(text, halves.joinToString("") { it.text })
    }

    // MARK: LLM detector

    private val detText = "Hi Raj, I work at Mercy General Hospital near the old mill."

    private suspend fun detect(t: String, budget: Int = 1400, handler: suspend (String, String) -> String): Pair<LLMDetectionReport, MockPhoneEngine> {
        val phone = MockPhoneEngine(handler = handler)
        return LLMDetector(phone, prompts, budget).detect(t) to phone
    }

    @Test fun validJson() = runTest {
        val (r, phone) = detect(detText) { _, _ -> "{\"items\":[{\"text\":\"Raj\",\"type\":\"PERSON\",\"role\":\"the writer's landlord\",\"confidence\":\"high\"},{\"text\":\"Mercy General Hospital\",\"type\":\"ORG\",\"confidence\":\"high\"}]}" }
        assertEquals(listOf("Raj", "Mercy General Hospital"), r.candidates.map { it.text })
        assertEquals(listOf("detect.v1"), phone.calledPromptIds)
        assertContains(phone.calls[0].text, "Mercy General Hospital")
    }

    @Test fun fencedJsonAndHallucinations() = runTest {
        val (r, _) = detect(detText) { _, _ -> "Sure!\n```json\n{\"items\":[{\"text\":\"Raj\",\"type\":\"PERSON\"},{\"text\":\"Priya Shah\",\"type\":\"PERSON\"}]}\n```\nbye {x}" }
        assertEquals(listOf("Raj"), r.candidates.map { it.text })
        assertEquals(1, r.hallucinatedDropped)
    }

    @Test fun repairThenFail() = runTest {
        val (a, phone) = detect(detText) { id, _ -> if (id == "detect.v1") "{\"items\":[{\"text\":\"Raj\"" else "{\"items\":[{\"text\":\"Raj\",\"type\":\"PERSON\"}]}" }
        assertEquals(listOf("detect.v1", "detect-repair.v1"), phone.calledPromptIds)
        assertEquals(listOf("Raj"), a.candidates.map { it.text })
        assertEquals(listOf(0), detect(detText) { _, _ -> "no json" }.first.failedChunks)
    }

    @Test fun refusalContextTooLongAndUnavailable() = runTest {
        assertEquals(listOf(0), detect(detText) { _, _ -> throw EngineError(EngineErrorCode.REFUSED) }.first.refusedChunks)
        var calls = 0
        val (r, _) = detect(detText) { _, p ->
            if (calls++ == 0) throw EngineError(EngineErrorCode.CONTEXT_TOO_LONG)
            if (p.contains("Raj")) "{\"items\":[{\"text\":\"Raj\",\"type\":\"PERSON\"}]}" else "{\"items\":[]}"
        }
        assertEquals(listOf("Raj"), r.candidates.map { it.text })
        assertEquals(3, calls)
        val phone = MockPhoneEngine.answering("{}", PhoneAvailability.DOWNLOADABLE)
        val u = LLMDetector(phone, prompts, 1400).detect(detText)
        assertEquals(PhoneAvailability.DOWNLOADABLE, u.unavailable)
        assertEquals(0, phone.calls.size)
    }

    @Test fun multiChunkOffsetsAreGlobal() = runTest {
        val long = List(60) { "Sentence $it mentions nobody at all here." }.joinToString(" ") + " Finally Lena Okafor called."
        val (r, _) = detect(long, 120) { _, p -> if (p.contains("Lena Okafor")) "{\"items\":[{\"text\":\"Lena Okafor\",\"type\":\"PERSON\"}]}" else "{\"items\":[]}" }
        assertTrue(r.chunkCount > 3)
        assertEquals(1, r.candidates.size)
        assertEquals("Lena Okafor", long.substring(r.candidates[0].span.start, r.candidates[0].span.end))
    }

    // MARK: red team

    private val raj = Entity.make("PERSON_1", PrivacyCategory.PERSON, "Raj Patel", setOf(DetectorId.VAULT), Confidence.HIGH, surfaceForms = setOf("Raj Patel", "Raj"))
    private val org = Entity.make("ORG_1", PrivacyCategory.ORG, "Harbor View Clinic", setOf(DetectorId.LLM), Confidence.HIGH, surfaceForms = setOf("Harbor View Clinic"), action = Action.Generalise(2), generalisedText = "a clinic")
    private fun draftOf(text: String) = SealDraft(text, listOf(LegendLine("PERSON_1", "the user's landlord")), emptyList(), EntityMap(listOf(raj, org)), emptyList(), emptySet(), emptySet())
    private fun guesses(vararg items: Triple<String, String, String>): String =
        "{\"guesses\":[" + items.joinToString(",") { (a, e, c) -> "{\"attribute\":${Js.quote(a)},\"guess\":\"g\",\"evidence\":${Js.quote(e)},\"confidence\":${Js.quote(c)}}" } + "]}"
    private fun rewriteJson(r: String) = "{\"rewrite\":${Js.quote(r)}}"

    private val rtText = "I'm the only night nurse at a clinic near the old mill, and [[PERSON_1]] keeps calling."

    private fun team(attack: (Int) -> String, rewrite: (String) -> String): Pair<RedTeam, MockPhoneEngine> {
        var n = 0
        val phone = MockPhoneEngine { id, p ->
            if (id == "attack.v1") attack(n++)
            else rewriteJson(rewrite(p.split("Phrase to rewrite: ").getOrNull(1)?.split("\n")?.get(0) ?: ""))
        }
        return RedTeam(phone, prompts, patterns) to phone
    }

    @Test fun filtersGuessesAndCaps() = runTest {
        val (rt, _) = team({
            guesses(
                Triple("location", "near the old mill", "medium"), Triple("occupation", "night nurse", "low"), Triple("location", "the lighthouse", "high"),
                Triple("hobby", "keeps calling", "high"), Triple("identity", "[[PERSON_1]]", "high"),
            )
        }, { "in the area" })
        val r = rt.run(draftOf(rtText), RedTeamMode.SUGGEST, 2, "help")
        assertEquals(listOf("near the old mill"), r.risks.map { it.evidence })
        assertEquals("in the area", r.risks[0].suggestion)
        assertEquals(rtText, r.draft.text)
    }

    @Test fun rejectsLeakyOrPlaceholderChangingSuggestions() {
        val map = EntityMap(listOf(raj, org))
        assertTrue(RedTeam.isValidSuggestion("[[PERSON_1]]'s office", "[[PERSON_1]]'s office at the old mill", map, patterns))
        assertFalse(RedTeam.isValidSuggestion("[[PERSON_2]]'s office", "[[PERSON_1]]'s office at the old mill", map, patterns))
        assertFalse(RedTeam.isValidSuggestion("an office near Harbor View", "the office at the old mill", map, patterns))
    }

    @Test fun strictAutoAppliesOverTwoRounds() = runTest {
        val (rt, phone) = team(
            { n -> if (n == 0) guesses(Triple("location", "near the old mill", "high")) else guesses(Triple("occupation", "the only night nurse", "high")) },
            { p -> if (p.contains("mill")) "in the area" else "a nurse" },
        )
        val r = rt.run(draftOf(rtText), RedTeamMode.AUTO_APPLY, 2, "help")
        assertEquals("I'm a nurse at a clinic in the area, and [[PERSON_1]] keeps calling.", r.draft.text)
        assertEquals(setOf("attack.v1", "gen.v1"), phone.calledPromptIds.toSet())
        assertEquals(2, EgressGate(patterns, emptyList()).seal(r.draft).gateReport.counts["redteamApplied"])
    }

    @Test fun offFailuresAndIdempotentApply() = runTest {
        val (rt, phone) = team({ "" }, { "" })
        assertEquals(emptyList(), rt.run(draftOf(rtText), RedTeamMode.OFF, 2, "h").risks)
        assertEquals(0, phone.calls.size)
        assertTrue(RedTeam(MockPhoneEngine.answering("nope"), prompts, patterns).run(draftOf(rtText), RedTeamMode.SUGGEST, 2, "h").unavailable)
        val risks = listOf(Risk(1, RiskAttribute.LOCATION, "", "near the old mill", Confidence.HIGH, "in the area"))
        val once = RedTeam.applyRisks(risks, draftOf(rtText))
        assertEquals(once.text, RedTeam.applyRisks(risks, once).text)
    }

    // MARK: seal pipeline

    private val raw = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. Thanks, Maya Chen"
    private val vault = listOf(
        VaultEntry("v-me", "Maya Chen", listOf("Maya"), PrivacyCategory.PERSON, "me", true),
        VaultEntry("v-raj", "Raj Patel", listOf("Raj"), PrivacyCategory.PERSON, "my landlord", false),
    )
    private val detectAnswer = "{\"items\":[{\"text\":\"Mercy General Hospital\",\"type\":\"ORG\",\"role\":\"the writer's employer\",\"confidence\":\"high\"}]}"
    private fun phone(rewrite: String = "a large hospital", attack: String = "{\"guesses\":[]}") =
        MockPhoneEngine { id, _ -> if (id == "gen.v1") rewriteJson(rewrite) else if (id == "attack.v1") attack else detectAnswer }
    private fun settings(dial: DialPreset) = SealSettings(dial = dial, chunkTokens = 3000, today = utc("2026-11-21"))
    private fun pipe(p: PhoneOnlyEngine, dial: DialPreset = DialPreset.BALANCED) = SealPipeline(p, patterns, vault, prompts, settings(dial))

    @Test fun happyPath() = runTest {
        val p = phone()
        val r = pipe(p).run(raw)
        assertEquals("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken since Oct 28. I work nights at a large hospital. Thanks, [[PERSON_ME]]", r.draft.text)
        assertEquals(listOf("detect.v1", "gen.v1", "attack.v1"), p.calledPromptIds)
        assertFalse(r.requiresReview)
        EgressGate(patterns, vault).seal(r.draft)
    }

    @Test fun timingsCountCallsPerStage() = runTest {
        val r = pipe(phone()).run(raw)
        val t = r.timings
        assertEquals(listOf(1, 0, 1, 1), listOf(t.detectCalls, t.repairCalls, t.generaliseCalls, t.redTeamCalls))
        assertTrue(t.firstModelOutputMs != null)
        assertTrue(t.rulesMs + t.detectMs + t.generaliseMs + t.redTeamMs <= t.totalMs + 1)
        assertEquals(r.sealMs, t.totalMs)
        val off = pipe(MockPhoneEngine.answering(detectAnswer, PhoneAvailability.UNAVAILABLE), DialPreset.OPEN).run(raw)
        assertEquals(0, off.timings.detectCalls + off.timings.generaliseCalls + off.timings.redTeamCalls)
        assertEquals(null, off.timings.firstModelOutputMs)
    }

    @Test fun leakyRewriteFallsBack() = runTest {
        val r = pipe(phone("the Mercy General campus")).run(raw)
        assertContains(r.draft.text, "I work nights at an organisation.")
        assertFalse(r.draft.text.contains("Mercy"))
    }

    @Test fun inv9NoOnDeviceModel() = runTest {
        val p = MockPhoneEngine.answering(detectAnswer, PhoneAvailability.UNAVAILABLE)
        val r = pipe(p, DialPreset.OPEN).run(raw)
        assertEquals(0, p.calls.size)
        assertTrue(r.requiresReview)
        assertContains(r.reasons, ReviewReason.PhoneUnavailable(PhoneAvailability.UNAVAILABLE))
        assertContains(r.draft.text, "[[PERSON_1]]")
        EgressGate(patterns, vault).seal(r.draft)
    }

    private val townRaw = "Hi Raj, I work nights at Mercy General Hospital near the old mill. Thanks, Maya Chen"
    private fun townPhone() = MockPhoneEngine { id, prompt ->
        when (id) {
            "attack.v1" -> guesses(Triple("location", "near the old mill", "medium"))
            "gen.v1" -> rewriteJson(if (prompt.contains("Phrase to rewrite: Mercy General Hospital")) "a large hospital" else "in the area")
            else -> detectAnswer
        }
    }

    @Test fun stagedBalancedShowsDraftEarlyStrictWaits() = runTest {
        val release = CompletableDeferred<Unit>()
        val p = townPhone()
        val slow = object : PhoneOnlyEngine {
            override suspend fun availability() = p.availability()
            override suspend fun respond(prompt: PhonePrompt, options: PhoneOptions): EngineResult {
                if (prompt.promptId == "attack.v1") release.await()
                return p.respond(prompt, options)
            }
        }
        val staged = SealPipeline(slow, patterns, vault, prompts, settings(DialPreset.BALANCED)).runStaged(this, townRaw)
        assertEquals(true, staged.result.redTeamPending)
        assertEquals(emptyList(), staged.result.risks)
        assertContains(staged.result.draft.text, "a large hospital")
        val later = assertNotNull(staged.later)
        assertFalse(later.isCompleted)
        release.complete(Unit)
        val full = later.await()
        assertEquals(false, full.redTeamPending)
        assertEquals(1, full.risks.size)
        assertEquals(staged.result.draft.text, full.draft.text)
        assertContains(full.reasons, ReviewReason.Risks(1))

        val strict = pipe(townPhone(), DialPreset.STRICT).runStaged(this, townRaw)
        assertNull(strict.later)
        assertNull(strict.result.redTeamPending)
    }

    @Test fun balancedRiskCardsAndReseal() = runTest {
        val p = townPhone()
        val pl = pipe(p)
        val r = pl.run(townRaw)
        assertEquals(1, r.risks.size)
        assertTrue(r.requiresReview)
        val calls = p.calls.size
        val accepted = pl.reseal(r, emptyMap(), r.risks)
        assertContains(accepted.draft.text, "at a large hospital in the area.")
        assertEquals(emptyList(), accepted.pendingRisks)
        assertEquals(calls, p.calls.size)
    }

    @Test fun vaultRevealAndSecrets() = runTest {
        val pl = pipe(phone())
        val r = pl.run("Ask Raj about it.")
        val rajId = r.merge.entities.sorted().first { it.vaultEntryId == "v-raj" }.id
        assertEquals("Ask Raj about it.", pl.reseal(r, mapOf(rajId to UserOverride(Action.Keep, true))).draft.text)
        val s = pipe(MockPhoneEngine.answering("{\"items\":[]}"), DialPreset.OPEN).run("Your verification code is 482913.")
        assertEquals("Your verification code is [[SECRET_1]].", s.draft.text)
        assertContains(s.reasons, ReviewReason.SecretsFound)
    }

    // MARK: Protect this (user-marked details)

    private val protectVault = listOf(VaultEntry("v-raj", "Raj Patel", listOf("Raj"), PrivacyCategory.PERSON, "my landlord", false))
    private val protectRaw = "Hi Raj, I work nights at Mercy General Hospital. Mercy General Hospital is far from 14 Elm St."
    // Rules only: the on-device model is unavailable, so the org name is missed (INV-9 path).
    private fun protectPipe() = SealPipeline(MockPhoneEngine.answering("", PhoneAvailability.UNAVAILABLE), PatternDetector(), protectVault, PromptLibrary(), SealSettings(dial = DialPreset.BALANCED))

    @Test fun protectMarksEveryOccurrenceKeepsNumbersAndTogglesAndPassesTheGate() = runTest {
        val p = protectPipe()
        val r = p.run(protectRaw)
        assertContains(r.draft.text, "Mercy General Hospital")
        val raj = r.draft.entities.sorted().first { it.canonical == "Raj Patel" }
        val overrides = mapOf(raj.id to UserOverride(Action.Keep, revealThisTime = true))
        val kept = p.reseal(r, overrides)
        assertContains(kept.draft.text, "Raj")

        val (protectedR, after) = p.protect(kept, "mercy general hospital", PrivacyCategory.ORG, overrides)
        assertEquals(Action.Placeholder, after["ORG_1"]?.action)
        assertEquals(Action.Keep, after[raj.id]?.action)
        assertFalse(protectedR.draft.text.contains("Mercy"))
        assertEquals(2, Regex("\\[\\[ORG_1]]").findAll(protectedR.draft.text).count())
        assertEquals("Raj Patel", protectedR.draft.entities[raj.id]?.canonical)
        assertContains(protectedR.draft.text, "Raj")
        assertTrue(protectedR.draft.entities["ORG_1"]?.sources?.contains(DetectorId.USER) == true)
        EgressGate(PatternDetector(), protectVault).seal(protectedR.draft)
    }

    @Test fun protectIsANoOpForMissingOrBlankText() = runTest {
        val p = protectPipe()
        val r = p.run(protectRaw)
        assertSame(r, p.protect(r, "Nowhere Clinic", PrivacyCategory.ORG, emptyMap()).result)
        assertSame(r, p.protect(r, "   ", PrivacyCategory.ORG, emptyMap()).result)
        assertFailsWith<IllegalArgumentException> { p.protect(r, "Raj", PrivacyCategory.QUASI, emptyMap()) }
    }

    @Test fun protectUserMarkInsideAnExistingDetectionWins() = runTest {
        // user > vault > pattern > llm
        val p = protectPipe()
        val r = p.run("Visit 14 Elm St tomorrow")
        assertFalse(p.protect(r, "Elm", PrivacyCategory.LOCATION, emptyMap()).result.draft.text.contains("Elm"))
    }

    // MARK: routing, answers and receipts

    private val me = Entity.make(Placeholders.ME, PrivacyCategory.PERSON, "Maya Chen", setOf(DetectorId.VAULT), Confidence.HIGH, surfaceForms = setOf("Maya"))
    private fun sealedMsg(text: String = "Hi [[PERSON_1]], the heater is still broken. — [[PERSON_ME]]"): SealedText {
        val legend = listOf(LegendLine("PERSON_ME", "the user"), LegendLine("PERSON_1", "the user's landlord")).filter { text.contains("[[${it.placeholder}]]") }
        return EgressGate(patterns, emptyList()).seal(SealDraft(text, legend, emptyList(), EntityMap(listOf(raj, me)), emptyList(), emptySet(), emptySet()))
    }
    private val restoreCtx = RestoreContext(EntityMap(listOf(raj, me)), userFirstName = "Maya")

    private suspend fun run(req: AnswerRequest): Pair<List<AnswerEvent>, AnswerOutcome> {
        val events = Answers.answer(req).toList()
        val f = events.filterIsInstance<AnswerEvent.Finished>().single()
        return events to f.outcome
    }

    @Test fun routeTable() {
        val s = sealedMsg()
        for ((t, r) in listOf(TaskKind.Summary to Route.PHONE_FIRST, TaskKind.Help to Route.CLOUD_FIRST, TaskKind.Reply("firm") to Route.CLOUD_FIRST, TaskKind.Explain to Route.PHONE_FIRST)) {
            assertEquals(r, Answers.route(t, s, AnswerPreference.AUTO).first)
            assertEquals(Route.PHONE_ONLY, Answers.route(t, s, AnswerPreference.PHONE_ONLY).first)
        }
        assertEquals(Route.CLOUD_ONLY, Answers.route(TaskKind.Summary, sealedMsg("x ".repeat(9000)), AnswerPreference.AUTO).first)
        assertEquals("Draft a reply I can send. Tone: firm but polite. Write it as me. Use placeholders for names.", Answers.taskSpec(prompts, TaskKind.Reply("firm but polite")).instruction)
    }

    @Test fun deepAnswerStreamsRestoresAndWritesAReceipt() = runTest {
        val reply = "Here's a reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], please fix the heater this week.\n\nThanks,\n[[PERSON_ME]]"
        val cloud = MockSealedEngine(Route.CLOUD_FIRST, "gemini-3.8-flash") { _, _ -> reply }
        val ledger = ReceiptLedger()
        val s = sealedMsg()
        val (events, outcome) = run(AnswerRequest(MockEngines(sealedEngines = mapOf(Route.CLOUD_FIRST to cloud)), prompts, ledger, s, TaskKind.Reply("firm"), restore = restoreCtx, threadId = "thr_1"))
        assertEquals("Here's a reply you can send to Raj Patel:\n\nHi Raj, please fix the heater this week.\n\nThanks,\nMaya", outcome.restored.text)
        assertEquals(listOf(s), cloud.received.toList())
        val partials = events.filterIsInstance<AnswerEvent.Partial>().map { it.text }
        for (i in 1 until partials.size) assertTrue(partials[i].startsWith(partials[i - 1]))
        assertEquals(outcome.restored.text, partials.last())
        assertEquals(Route.CLOUD_FIRST, outcome.receipt?.route)
        assertFalse(outcome.receipt?.outboundText.orEmpty().contains("Raj"))
        assertEquals(ChainVerification.Valid(1), ledger.verify())
    }

    @Test fun onDeviceQuickAnswerNoReceiptArmorBlockReceipt() = runTest {
        val ledger = ReceiptLedger()
        val quick = MockSealedEngine(Route.PHONE_FIRST, ON_DEVICE_MODEL) { _, _ -> "- [[PERSON_1]] hasn't fixed it." }
        val (_, outcome) = run(AnswerRequest(MockEngines(sealedEngines = mapOf(Route.PHONE_FIRST to quick)), prompts, ledger, sealedMsg(), TaskKind.Summary, restore = restoreCtx, threadId = "t"))
        assertTrue(outcome.ranOnDevice && outcome.receipt == null)
        assertEquals(1, ledger.stats(Instant.EPOCH).onDeviceAnswers)
        val blocked = MockSealedEngine(Route.CLOUD_FIRST) { _, _ -> throw EngineError(EngineErrorCode.ARMOR_BLOCKED) }
        val e = assertFailsWith<EngineError> {
            run(AnswerRequest(MockEngines(sealedEngines = mapOf(Route.CLOUD_FIRST to blocked)), prompts, ledger, sealedMsg(), TaskKind.Help, restore = restoreCtx, threadId = "t"))
        }
        assertContains(e.message.orEmpty(), "armorBlocked")
        assertEquals(listOf(ArmorStatus.BLOCKED), ledger.receipts.map { it.armor })
    }
}
