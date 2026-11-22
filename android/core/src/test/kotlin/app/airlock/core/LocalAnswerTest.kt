package app.airlock.core

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** FX-02: quick tasks answered on the device from the raw message — no seal, no Review. */
class LocalAnswerTest {
    private val prompts = PromptLibrary()
    private val avail = PhoneAvailability.AVAILABLE

    @Test fun quickTasksWithTheModelAvailableUnlessBestAnswer() {
        for (task in listOf(TaskKind.Summary, TaskKind.Explain, TaskKind.Actions, TaskKind.Rewrite("firm"))) {
            assertTrue(LocalAnswer.runsOnDevice(task, AnswerPreference.AUTO, avail, 500), task.toString())
            assertFalse(LocalAnswer.runsOnDevice(task, AnswerPreference.BEST, avail, 500), task.toString())
        }
    }

    @Test fun deepTasksOnlyWhenThisDeviceOnly() {
        for (task in listOf(TaskKind.Help, TaskKind.Questions, TaskKind.Reply("firm"), TaskKind.Custom)) {
            assertFalse(LocalAnswer.runsOnDevice(task, AnswerPreference.AUTO, avail, 500), task.toString())
            assertTrue(LocalAnswer.runsOnDevice(task, AnswerPreference.PHONE_ONLY, avail, 500), task.toString())
            assertFalse(LocalAnswer.runsOnDevice(task, AnswerPreference.BEST, avail, 500), task.toString())
        }
    }

    @Test fun neverWithoutTheModelOrForAMessageTooBigForItsWindow() {
        for (a in listOf(null, PhoneAvailability.UNAVAILABLE, PhoneAvailability.DOWNLOADABLE, PhoneAvailability.DOWNLOADING, PhoneAvailability.UNKNOWN)) {
            assertFalse(LocalAnswer.runsOnDevice(TaskKind.Summary, AnswerPreference.PHONE_ONLY, a, 500), "$a")
        }
        assertTrue(LocalAnswer.runsOnDevice(TaskKind.Summary, AnswerPreference.AUTO, avail, Answers.ON_DEVICE_LIMIT))
        assertFalse(LocalAnswer.runsOnDevice(TaskKind.Summary, AnswerPreference.AUTO, avail, Answers.ON_DEVICE_LIMIT + 1))
    }

    @Test fun sendsTheRawMessageAndTheTaskToThePhoneOnlyEngineOnly() = runTest {
        val phone = MockPhoneEngine.answering("  - Raj is late.\n- Ask for a date.  ")
        val r = LocalAnswer.run(phone, prompts, TaskKind.Summary, "Raj Patel said the heater is fixed on Friday.")
        assertEquals(listOf("phone-local.v1"), phone.calledPromptIds)
        val sent = phone.calls.first().text
        assertTrue(sent.contains("Raj Patel said the heater is fixed on Friday."))
        assertTrue(sent.contains("Summarise this in 5 bullet points."))
        assertEquals("- Raj is late.\n- Ask for a date.", r.text)
    }

    @Test fun earlierExchangesGoInFrontNewestKeptFirst() = runTest {
        val phone = MockPhoneEngine.answering("ok")
        val big = "x".repeat(4_000)
        LocalAnswer.run(phone, prompts, TaskKind.Summary, "now", listOf(LocalAnswer.Exchange("oldest", big), LocalAnswer.Exchange("recent", "short")))
        val sent = phone.calls.first().text
        assertTrue(sent.contains("Earlier in this conversation:") && sent.contains("recent") && !sent.contains("oldest"))
        assertTrue(sent.indexOf("recent") < sent.indexOf("now"))
    }

    @Test fun anEmptyAnswerOrAnUnavailableModelIsAnErrorSoTheCallerFallsBack() = runTest {
        assertFailsWith<EngineError> { LocalAnswer.run(MockPhoneEngine.answering(" \n "), prompts, TaskKind.Summary, "hi") }
        assertFailsWith<EngineError> { LocalAnswer.run(MockPhoneEngine.answering("x", PhoneAvailability.UNAVAILABLE), prompts, TaskKind.Summary, "hi") }
    }
}
