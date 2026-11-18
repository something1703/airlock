package app.airlock.android.session

import app.airlock.android.AppConfig
import app.airlock.android.engines.DemoEngines
import app.airlock.android.engines.DemoSealedEngine
import app.airlock.android.engines.DownloadEvent
import app.airlock.android.store.AirlockStores
import app.airlock.android.store.EncryptedStore
import app.airlock.android.store.SoftwareKeyProvider
import app.airlock.core.AnswerPreference
import app.airlock.core.AnswerQuality
import app.airlock.core.ChainVerification
import app.airlock.core.DialPreset
import app.airlock.core.EngineProvider
import app.airlock.core.MockPhoneEngine
import app.airlock.core.PatternDetector
import app.airlock.core.PhoneAvailability
import app.airlock.core.PhoneOnlyEngine
import app.airlock.core.PrivacyCategory
import app.airlock.core.PromptLibrary
import app.airlock.core.ReviewReason
import app.airlock.core.Route
import app.airlock.core.SealedEngine
import app.airlock.core.TaskKind
import app.airlock.core.VaultEntry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SAMPLE = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. " +
    "You can reach me on 312-555-0147. Thanks, Maya Chen"
private val RAW = listOf("Raj", "Maya", "Elm", "312-555", "Mercy")

/** Demo engines whose sealed side records exactly what would have left the phone. */
private class Recording(override val phone: PhoneOnlyEngine) : EngineProvider {
    val engines = Route.entries.associateWith { DemoSealedEngine(it, pace = false) }
    override fun sealed(route: Route, quality: AnswerQuality): SealedEngine = engines.getValue(route)
    val sent: List<String> get() = engines.values.flatMap { e -> e.received.map { it.outbound() } }
}

/** Port of web/tests/session.test.ts: the whole Ask → Review → Seal & send → answer flow on mock engines. */
class SessionTest {
    private fun services(phone: PhoneOnlyEngine = DemoEngines.phone(pace = false), stores: AirlockStores = AirlockStores(EncryptedStore(Files.createTempDirectory("airlock").toFile(), SoftwareKeyProvider()))): Pair<Services, Recording> {
        val engines = Recording(phone)
        val config = AppConfig()
        return Services(
            config, PromptLibrary(), PatternDetector(), engines, stores, MemoryPrefsStore(Prefs(DialPreset.BALANCED, AnswerPreference.BEST, onboarded = true)),
            AppMode.DEMO, DemoReason.REQUESTED, availability = { phone.availability() },
        ) to engines
    }

    private suspend fun session(svc: Services, scope: CoroutineScope, vault: Boolean = true): AirlockSession {
        val s = AirlockSession(svc, scope)
        s.load()
        if (vault && s.current.vault.isEmpty()) {
            s.saveVault(
                listOf(
                    VaultEntry("me", "Maya Chen", listOf("Maya"), PrivacyCategory.PERSON, "me", true),
                    VaultEntry("raj", "Raj Patel", listOf("Raj"), PrivacyCategory.PERSON, "my landlord", false),
                ),
            )
        }
        return s
    }

    @Test fun askReviewSendAnswerAndNothingRawLeaves() = runTest {
        val (svc, rec) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        val draft = s.current.review!!.result!!.draft.text
        for (raw in RAW) assertFalse(draft.contains(raw), "draft hides $raw")

        assertTrue(s.send())
        val st = s.current
        assertEquals(Screen.THREAD, st.screen)
        val answer = st.threads.single().turns.last() as Turn.Assistant
        assertEquals(Turn.Status.DONE, answer.status)
        assertTrue(answer.text.contains("Raj") && answer.text.contains("14 Elm St"), "names restored on device")
        assertNotNull(answer.outcome?.receipt)

        val outbound = s.ledger.receipts.joinToString("\n") { it.outboundText ?: "" } + "\n" + rec.sent.joinToString("\n")
        assertTrue(outbound.isNotBlank())
        for (raw in RAW) assertFalse(outbound.contains(raw), "INV-1: $raw never reaches the sealed engine or a receipt")
        assertTrue(s.verifyChain() is ChainVerification.Valid)
        assertEquals("Heater repair request", st.threads.single().title.let { s.current.threads.single().title })
    }

    @Test fun togglingAChipSendsItAsWrittenAndBack() = runTest {
        val (svc, _) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        val loc = s.current.review!!.result!!.draft.entities.sorted().first { it.category == PrivacyCategory.LOCATION }
        s.toggleEntity(loc.id)
        assertTrue(s.current.review!!.result!!.draft.text.contains("14 Elm St"))
        s.toggleEntity(loc.id)
        assertFalse(s.current.review!!.result!!.draft.text.contains("14 Elm St"))
    }

    @Test fun aRiskCardSuggestionIsAppliedOnlyWhenAccepted() = runTest {
        val (svc, rec) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        val risk = s.pendingRisks().single()
        assertEquals("I work night shifts", risk.suggestion)
        assertTrue(s.current.review!!.result!!.reasons.any { it is ReviewReason.Risks })
        assertFalse(s.current.review!!.result!!.draft.text.contains("night shifts"), "suggestions never change the draft by themselves")
        s.acceptRisk(risk)
        assertTrue(s.current.review!!.result!!.draft.text.contains("I work night shifts"))
        assertTrue(s.pendingRisks().isEmpty())
        assertTrue(s.send())
        assertTrue(rec.sent.single().contains("I work night shifts"))
    }

    @Test fun aFollowUpReusesTheThreadsPlaceholders() = runTest {
        val (svc, rec) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        s.send()
        val id = s.current.currentThreadId!!
        s.startReview("What if Raj ignores me again?", TaskKind.Help, id)
        assertTrue(s.current.review!!.result!!.draft.text.contains("[[PERSON_1]]"))
        s.send()
        assertEquals(1, s.current.threads.size)
        assertEquals(4, s.current.threads.single().turns.size)
        for (raw in RAW) assertFalse(rec.sent.joinToString().contains(raw))
    }

    @Test fun conversationsSurviveAReloadAndSealedTurnsAreReGated() = runTest {
        val (svc, _) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Reply("firm but polite"))
        s.send()
        val id = s.current.currentThreadId!!

        val again = session(svc, backgroundScope)
        val t = again.current.threads.first { it.id == id }
        assertEquals(2, t.turns.size)
        val user = t.turns[0] as Turn.User
        val answer = t.turns[1] as Turn.Assistant
        assertNotNull(user.sealed, "re-sealed by the gate on load")
        assertEquals(user.display, user.sealed!!.value)
        assertTrue(answer.text.contains("Raj"))
        assertEquals(s.ledger.receipts.last().id, answer.outcome?.receipt?.id)

        again.startReview("What if Raj ignores me again?", TaskKind.Help, id)
        again.send()
        assertEquals(4, again.current.threads.first { it.id == id }.turns.size)
    }

    @Test fun aSavedTurnThatNoLongerPassesTheGateIsKeptOutOfHistory() = runTest {
        val (svc, _) = services()
        val s = session(svc, backgroundScope)
        s.startReview("The heater is broken at Willowbrook Court.", TaskKind.Help)
        s.current.review!!.result!!.draft.entities.sorted().firstOrNull { it.canonical.contains("Willowbrook") }?.let { s.toggleEntity(it.id) }
        s.send()
        s.saveVault(s.current.vault + VaultEntry("w", "Willowbrook Court", listOf("Willowbrook"), PrivacyCategory.LOCATION, null, false))
        val again = session(svc, backgroundScope)
        val user = again.current.threads.single().turns[0] as Turn.User
        assertNull(user.sealed)
        assertTrue(user.display.contains("Willowbrook"))
        assertTrue(AirlockSession.historyOf(again.current.threads.single()).turns.isEmpty(), "neither the turn nor its answer is replayed")
    }

    @Test fun deletingAConversationKeepsTheReceiptChain() = runTest {
        val (svc, _) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        s.send()
        val id = s.current.currentThreadId!!
        val receipts = s.ledger.receipts.size
        s.deleteThread(id)
        assertTrue(s.current.threads.isEmpty())
        assertEquals(Screen.ASK, s.current.screen)
        val again = session(svc, backgroundScope)
        assertTrue(again.current.threads.isEmpty())
        assertEquals(receipts, again.ledger.receipts.size)
        assertTrue(again.verifyChain() is ChainVerification.Valid)
    }

    @Test fun deleteEverythingReturnsToOnboarding() = runTest {
        val (svc, _) = services()
        val s = session(svc, backgroundScope)
        s.startReview(SAMPLE, TaskKind.Help)
        s.send()
        s.deleteEverything()
        assertEquals(Screen.ONBOARDING, s.current.screen)
        assertTrue(s.current.vault.isEmpty() && s.current.threads.isEmpty() && s.ledger.receipts.isEmpty())
        val again = AirlockSession(svc, backgroundScope).also { it.load() }
        assertTrue(again.current.vault.isEmpty() && again.ledger.receipts.isEmpty())
    }

    @Test fun sendingIsImpossibleWhileTheRedTeamIsPending() = runTest {
        val gate = CompletableDeferred<Unit>()
        val demo = DemoEngines.phone(pace = false)
        val phone = MockPhoneEngine { id, text ->
            if (id == "attack.v1") gate.await()
            demo.respond(app.airlock.core.PhonePrompt(id, text), app.airlock.core.ANALYSIS_OPTIONS).text
        }
        val (svc, rec) = services(phone)
        val s = session(svc, backgroundScope)
        val job = launch { s.startReview(SAMPLE, TaskKind.Help) }
        s.state.first { it.review?.result?.redTeamPending == true }
        assertFalse(s.send())
        assertEquals(Screen.REVIEW, s.current.screen)
        assertTrue(s.ledger.receipts.isEmpty() && rec.sent.isEmpty())
        gate.complete(Unit)
        job.join()
        assertEquals(false, s.current.review!!.result!!.redTeamPending)
        assertTrue(s.send())
    }

    @Test fun withoutTheOnDeviceModelSealingFallsBackToRulesAndForcesReview() = runTest {
        val phone = MockPhoneEngine.answering("{}", PhoneAvailability.UNAVAILABLE)
        val (svc, rec) = services(phone)
        val s = session(svc, backgroundScope)
        s.refreshAvailability()
        s.startReview(SAMPLE, TaskKind.Help)
        val result = s.current.review!!.result!!
        assertTrue(result.requiresReview)
        assertTrue(result.reasons.any { it is ReviewReason.PhoneUnavailable })
        for (raw in listOf("Raj", "Maya", "312-555")) assertFalse(result.draft.text.contains(raw), "Vault + patterns still seal $raw")
        assertTrue(s.send())
        for (raw in listOf("Raj", "Maya", "312-555")) assertFalse(rec.sent.joinToString().contains(raw))
        assertTrue(phone.calls.isEmpty(), "INV-9: no on-device call, and nothing raw went anywhere else")
    }

    @Test fun protectThisSealsAMissedPhraseEverywhereSurvivesTogglesAndNeverLeaves() = runTest {
        val (svc, rec) = services()
        val s = session(svc, backgroundScope)
        s.startReview("The leak at Willowbrook Court got worse. Willowbrook Court management won't answer, Raj.", TaskKind.Help)
        assertTrue(s.current.review!!.result!!.draft.text.contains("Willowbrook"))
        assertTrue(s.protect("willowbrook court", PrivacyCategory.LOCATION))
        assertFalse(s.current.review!!.result!!.draft.text.contains("Willowbrook"))
        val raj = s.current.review!!.result!!.draft.entities.sorted().first { it.canonical == "Raj Patel" }
        s.toggleEntity(raj.id) // a later toggle must not undo the user's mark
        assertFalse(s.current.review!!.result!!.draft.text.contains("Willowbrook"))
        assertFalse(s.protect("Nowhere Clinic", PrivacyCategory.ORG))
        assertFalse(s.protect("   ", PrivacyCategory.ORG))
        assertTrue(s.send())
        assertFalse(s.ledger.receipts.last().outboundText!!.contains("Willowbrook"))
        assertFalse(rec.sent.joinToString().contains("Willowbrook"))
        val answer = s.current.threads.first().turns.last() as Turn.Assistant
        assertEquals(Turn.Status.DONE, answer.status)
    }

    @Test fun protectThisMadeWhileTheRedTeamIsPendingSurvivesItsResult() = runTest {
        val gate = CompletableDeferred<Unit>()
        val demo = DemoEngines.phone(pace = false)
        val phone = MockPhoneEngine { id, text ->
            if (id == "attack.v1") gate.await()
            demo.respond(app.airlock.core.PhonePrompt(id, text), app.airlock.core.ANALYSIS_OPTIONS).text
        }
        val (svc, rec) = services(phone)
        val s = session(svc, backgroundScope)
        val job = launch { s.startReview("The leak at Willowbrook Court got worse, Raj.", TaskKind.Help) }
        s.state.first { it.review?.result?.redTeamPending == true }
        assertTrue(s.protect("Willowbrook Court", PrivacyCategory.LOCATION))
        gate.complete(Unit)
        job.join()
        val result = s.current.review!!.result!!
        assertEquals(false, result.redTeamPending)
        assertFalse(result.draft.text.contains("Willowbrook"), "the late red-team result keeps the user's mark")
        assertTrue(s.send())
        assertFalse(rec.sent.joinToString().contains("Willowbrook"))
    }

    @Test fun aFailedModelDownloadOffersRetryAndASuccessfulOneClearsIt() = runTest {
        var avail = PhoneAvailability.DOWNLOADABLE
        var fail = true
        var seen: Float? = null
        lateinit var s: AirlockSession
        val base = services().first
        val svc = Services(
            base.config, base.prompts, base.patterns, base.engines, base.stores, base.prefs, AppMode.LIVE,
            availability = { avail },
            download = {
                flow {
                    emit(DownloadEvent.Progress(0f))
                    emit(DownloadEvent.Progress(0.5f))
                    seen = s.current.downloadProgress
                    if (fail) emit(DownloadEvent.Failed) else { avail = PhoneAvailability.AVAILABLE; emit(DownloadEvent.Done) }
                }
            },
        )
        s = session(svc, backgroundScope)
        s.enableOnDevice()
        assertEquals(0.5f, seen, "progress is reported")
        assertFalse(s.current.downloading)
        assertTrue(s.current.downloadFailed)
        assertEquals(PhoneAvailability.DOWNLOADABLE, s.current.availability)

        fail = false
        s.enableOnDevice()
        assertFalse(s.current.downloadFailed)
        assertEquals(PhoneAvailability.AVAILABLE, s.current.availability)
    }

    @Test fun titlesAreCleanAndPlaceholderFree() {
        assertEquals("Broken heater, landlord unresponsive", AirlockSession.cleanTitle("\"Broken heater, landlord unresponsive.\"\n"))
        assertEquals("Rent increase question", AirlockSession.cleanTitle("Title: rent increase question"))
        for (bad in listOf("", "{}", "Heater for [[PERSON_1]]", "Heater for PERSON_1", "a ".repeat(40), "one two three four five six seven eight")) {
            assertNull(AirlockSession.cleanTitle(bad), bad)
        }
        assertEquals("Hi someone the heater at a place", AirlockSession.titleFrom("Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken"))
        assertEquals("Me", AirlockSession.titleFrom("[[PERSON_ME]]"))
        assertEquals("A code", AirlockSession.titleFrom("[[SECRET_1]] !!"))
    }
}
