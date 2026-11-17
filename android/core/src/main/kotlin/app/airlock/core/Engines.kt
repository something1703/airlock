// Engine contracts (port of engines.ts / AirlockCore/Engines.swift). No Firebase here: the app module implements
// these with Firebase AI Logic; Mocks.kt implements them for tests, previews and demo mode.
package app.airlock.core

import kotlinx.coroutines.flow.Flow

/** On-device model state. */
enum class PhoneAvailability(val wire: String) {
    AVAILABLE("available"), DOWNLOADABLE("downloadable"), DOWNLOADING("downloading"), UNAVAILABLE("unavailable"), UNKNOWN("unknown"),
}

/** Why an engine call failed (mirrors `EngineErrorCode`). */
enum class EngineErrorCode(val wire: String) {
    UNAVAILABLE("unavailable"), CONTEXT_TOO_LONG("contextTooLong"), REFUSED("refused"), UNSUPPORTED_LANGUAGE("unsupportedLanguage"),
    BUSY("busy"), PARSE("parse"), ARMOR_BLOCKED("armorBlocked"), CLOUD_BLOCKED("cloudBlocked"), QUOTA("quota"),
    SERVICE_UNAVAILABLE("serviceUnavailable"), OFFLINE("offline"), APP_CHECK("appCheck"), CANCELLED("cancelled"),
    NEEDS_USER_GESTURE("needsUserGesture"), OTHER("other"),
}

/** Engine failure. Carries a code (and an optional non-content detail) only — never prompt or answer text (INV-8). */
class EngineError(val code: EngineErrorCode, val detail: String = "") :
    Exception("Engine error: ${code.wire}${if (detail.isNotEmpty()) " ($detail)" else ""}") {
    val isTransientCloud: Boolean get() = code == EngineErrorCode.QUOTA || code == EngineErrorCode.SERVICE_UNAVAILABLE
}

/** A prompt for the on-device model only. May contain raw text — it never leaves the device (INV-3). */
data class PhonePrompt(
    /** Prompt id for logs and metrics (never content). */
    val promptId: String,
    val text: String,
    val instructions: String? = null,
) {
    override fun toString(): String = "PhonePrompt($promptId)"
}

/** Sampling options for the on-device model. `greedy` = deterministic (temperature 0, topK 1). */
data class PhoneOptions(val greedy: Boolean, val temperature: Double? = null)

/** Deterministic options for every analysis prompt (detect, gen, attack). */
val ANALYSIS_OPTIONS = PhoneOptions(greedy = true)

/** The model that answered (`ranOnDevice` comes from the SDK's inference source, never assumed). */
data class EngineResult(val text: String, val modelVersion: String, val ranOnDevice: Boolean, val latencyMs: Double)

/** Stand-in "model version" for the on-device model (the Android SDK reports only the inference source). */
const val ON_DEVICE_MODEL = "gemini-nano-on-device"

/** A rendered task instruction for the cloud model (sealed text only). */
data class TaskSpec(val id: String, val instruction: String, val maxOutputTokens: Int? = null)

/** One earlier turn of a sealed thread: user turns are SealedText; assistant turns are the model's own placeholder text. */
sealed interface SealedTurn {
    data class User(val sealed: SealedText) : SealedTurn
    data class Assistant(val modelText: String) : SealedTurn
}

/** Earlier turns of a sealed thread, oldest first. */
data class SealedHistory(val turns: List<SealedTurn>)

/** One streamed update. Cumulative. */
data class EngineChunk(val cumulativeText: String, val modelVersion: String?, val ranOnDevice: Boolean?)

/** `best` may pick a larger cloud model for deep tasks. */
enum class AnswerQuality(val wire: String) { AUTO("auto"), BEST("best") }

/** The only engine that accepts a PhonePrompt (and thus raw text). Phone-only; never attached to a cloud model (INV-3). */
interface PhoneOnlyEngine {
    suspend fun availability(): PhoneAvailability
    suspend fun respond(prompt: PhonePrompt, options: PhoneOptions): EngineResult
}

/** Cloud-capable engine. Accepts only a SealedText — never raw text (INV-1). */
interface SealedEngine {
    val route: Route
    suspend fun respond(sealed: SealedText, task: TaskSpec, history: SealedHistory? = null): EngineResult
    fun stream(sealed: SealedText, task: TaskSpec, history: SealedHistory? = null): Flow<EngineChunk>
}

/** Supplies the phone engine and a sealed engine per route. */
interface EngineProvider {
    val phone: PhoneOnlyEngine
    fun sealed(route: Route, quality: AnswerQuality): SealedEngine
}
