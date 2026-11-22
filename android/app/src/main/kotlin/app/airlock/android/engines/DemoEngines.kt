package app.airlock.android.engines

import app.airlock.core.AnswerQuality
import app.airlock.core.EngineChunk
import app.airlock.core.EngineProvider
import app.airlock.core.EngineResult
import app.airlock.core.MockPhoneEngine
import app.airlock.core.ON_DEVICE_MODEL
import app.airlock.core.PhoneOnlyEngine
import app.airlock.core.Route
import app.airlock.core.SealedEngine
import app.airlock.core.SealedHistory
import app.airlock.core.SealedText
import app.airlock.core.TaskSpec
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.util.Collections

/**
 * Demo mode (launcher shortcut "Try the demo", intent extra `demo=true`, or a build without Firebase): scripted
 * engines, clearly labelled in the UI, so anyone can walk the whole flow without Firebase or Gemini Nano. Port of
 * `demoEngines()` in web/src/app/services.ts. The scripted phone engine still only ever sees prompts; the scripted
 * sealed engine still only accepts gate-checked [SealedText].
 */
object DemoEngines {
    private val ORG = Regex("\\bMercy General Hospital\\b")
    private val PERSON = Regex("\\bRaj Patel\\b|\\bRaj\\b")
    private const val RISKY = "I work nights at a large hospital"

    const val REPLY = "Here's a firm, polite reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], the heater at [[LOC_1]] is still broken. " +
        "Please arrange a repair this week.\n\nThanks,\n[[PERSON_ME]]"
    const val SUMMARY = "- [[PERSON_1]] hasn't fixed the heater.\n- You've asked several times."
    const val HELP = "Here's a calm way to handle it:\n\n1. Write to [[PERSON_1]] today. Say the heater at [[LOC_1]] has been broken since Oct 28 " +
        "and ask for a repair date this week.\n2. Keep a note of every message and when you sent it.\n3. If nothing changes, ask what your lease " +
        "says about repair times. A local tenants' group can explain what usually applies where you live."

    /** `pace` = false for tests (no artificial delays). */
    fun phone(pace: Boolean = true): MockPhoneEngine = MockPhoneEngine { id, text ->
        when (id) {
            "detect.v1" -> {
                if (pace) delay(900)
                val items = ArrayList<String>()
                ORG.find(text)?.let { items.add("{\"text\":\"${it.value}\",\"type\":\"ORG\",\"role\":\"the writer's employer\"}") }
                PERSON.find(text)?.let { items.add("{\"text\":\"${it.value}\",\"type\":\"PERSON\",\"role\":\"the writer's landlord\"}") }
                "{\"items\":[${items.joinToString(",")}]}"
            }
            "gen.v1" -> {
                if (pace) delay(350)
                if (text.contains("Phrase to rewrite: $RISKY")) "{\"rewrite\":\"I work night shifts\"}" else "{\"rewrite\":\"a large hospital\"}"
            }
            "attack.v1" -> {
                if (pace) delay(1400)
                // One scripted re-identification risk, so the demo shows a risk card with a suggestion.
                if (text.contains(RISKY)) "{\"guesses\":[{\"attribute\":\"occupation\",\"guess\":\"a night-shift hospital worker living at LOC_1\",\"evidence\":\"$RISKY\",\"confidence\":\"medium\"}]}"
                else "{\"guesses\":[]}"
            }
            "title.v1" -> "Heater repair request"
            // A quick task answered on the device from the raw message (FX-02): plain text, no placeholders.
            "phone-local.v1" -> "- Your landlord hasn't fixed the heater yet.\n- You have already asked several times.\n- The next step is a firm, polite written request."
            else -> "{}"
        }
    }

    fun provider(pace: Boolean = true): EngineProvider = Provider(phone(pace), pace)

    private class Provider(override val phone: PhoneOnlyEngine, private val pace: Boolean) : EngineProvider {
        val engines = Route.entries.associateWith { DemoSealedEngine(it, pace) }
        override fun sealed(route: Route, quality: AnswerQuality): SealedEngine = engines.getValue(route)
    }
}

/** Scripted sealed engine that streams word by word, so the restore animation is visible in demo mode. */
class DemoSealedEngine(override val route: Route, private val pace: Boolean = true) : SealedEngine {
    val received: MutableList<SealedText> = Collections.synchronizedList(ArrayList())
    private val modelVersion = if (route == Route.PHONE_FIRST || route == Route.PHONE_ONLY) ON_DEVICE_MODEL else "gemini-demo"

    private fun answer(task: TaskSpec): String = when (task.id) {
        "task.summary.v1", "task.actions.v1" -> DemoEngines.SUMMARY
        "task.reply.v1", "task.rewrite.v1" -> DemoEngines.REPLY
        else -> DemoEngines.HELP
    }

    override suspend fun respond(sealed: SealedText, task: TaskSpec, history: SealedHistory?): EngineResult {
        received.add(sealed)
        return EngineResult(answer(task), modelVersion, modelVersion == ON_DEVICE_MODEL, 1.0)
    }

    override fun stream(sealed: SealedText, task: TaskSpec, history: SealedHistory?): Flow<EngineChunk> = flow {
        received.add(sealed)
        if (pace) delay(700)
        val text = answer(task)
        val onDevice = modelVersion == ON_DEVICE_MODEL
        var i = 0
        while (i < text.length) {
            var j = text.indexOf(' ', i + 1)
            j = if (j < 0) text.length else j
            i = j
            emit(EngineChunk(text.substring(0, i), modelVersion, onDevice))
            if (pace) delay(45)
        }
    }
}
