package app.airlock.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.util.Collections

/** Scriptable on-device engine (tests, previews, demo mode). Records every call so tests can prove what reached which engine. */
class MockPhoneEngine(
    private val avail: PhoneAvailability = PhoneAvailability.AVAILABLE,
    private val handler: suspend (promptId: String, text: String) -> String,
) : PhoneOnlyEngine {
    /** One recorded call. */
    data class Call(val promptId: String, val text: String)

    val calls: MutableList<Call> = Collections.synchronizedList(ArrayList())

    override suspend fun availability(): PhoneAvailability = avail

    override suspend fun respond(prompt: PhonePrompt, options: PhoneOptions): EngineResult {
        calls.add(Call(prompt.promptId, prompt.text))
        if (avail != PhoneAvailability.AVAILABLE) throw EngineError(EngineErrorCode.UNAVAILABLE, avail.wire)
        val text = handler(prompt.promptId, prompt.text)
        return EngineResult(text, ON_DEVICE_MODEL, true, 0.0)
    }

    val calledPromptIds: List<String> get() = synchronized(calls) { calls.map { it.promptId } }

    companion object {
        fun answering(text: String, avail: PhoneAvailability = PhoneAvailability.AVAILABLE) = MockPhoneEngine(avail) { _, _ -> text }
    }
}

/** Scriptable sealed engine; records every SealedText it receives; streams cumulative snapshots. */
class MockSealedEngine(
    override val route: Route,
    private val modelVersion: String = "mock-gemini",
    private val handler: suspend (sealed: SealedText, task: TaskSpec) -> String,
) : SealedEngine {
    val received: MutableList<SealedText> = Collections.synchronizedList(ArrayList())

    override suspend fun respond(sealed: SealedText, task: TaskSpec, history: SealedHistory?): EngineResult {
        received.add(sealed)
        val text = handler(sealed, task)
        return EngineResult(text, modelVersion, modelVersion == ON_DEVICE_MODEL, 1.0)
    }

    override fun stream(sealed: SealedText, task: TaskSpec, history: SealedHistory?): Flow<EngineChunk> = flow {
        val r = respond(sealed, task, history)
        val acc = StringBuilder()
        for (ch in Js.codePoints(r.text)) {
            acc.append(ch)
            if (acc.length % 12 == 0) emit(EngineChunk(acc.toString(), r.modelVersion, r.ranOnDevice))
        }
        emit(EngineChunk(acc.toString(), r.modelVersion, r.ranOnDevice))
    }
}

/** Engine provider over mocks; routes without a scripted engine get a canned reply. */
class MockEngines(
    override val phone: PhoneOnlyEngine = MockPhoneEngine.answering("{\"items\":[]}"),
    private val sealedEngines: Map<Route, SealedEngine> = emptyMap(),
) : EngineProvider {
    override fun sealed(route: Route, quality: AnswerQuality): SealedEngine =
        sealedEngines[route] ?: MockSealedEngine(route) { _, _ -> "Here's a reply for [[PERSON_1]]." }
}
