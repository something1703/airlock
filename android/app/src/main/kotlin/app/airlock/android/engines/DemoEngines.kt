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

    const val REPLY = "Here's a firm, polite reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], the heater at [[LOC_1]] is still broken. " +
        "Please arrange a repair this week.\n\nThanks,\n[[PERSON_ME]]"
    const val SUMMARY = "- [[PERSON_1]] hasn't fixed the heater.\n- You've asked several times."

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
                "{\"rewrite\":\"a large hospital\"}"
            }
            "attack.v1" -> {
                if (pace) delay(1400)
                "{\"guesses\":[]}"
            }
            "title.v1" -> "Heater repair request"
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

    private fun answer(task: TaskSpec): String = if (task.id == "task.summary.v1") DemoEngines.SUMMARY else DemoEngines.REPLY

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
