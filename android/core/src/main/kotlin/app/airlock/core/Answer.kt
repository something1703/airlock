package app.airlock.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** What the user asked for. Each kind has a prompt `task.<kind>.v1`. */
sealed interface TaskKind {
    val kind: String

    data object Help : TaskKind { override val kind = "help" }
    data object Explain : TaskKind { override val kind = "explain" }
    data object Questions : TaskKind { override val kind = "questions" }
    data object Summary : TaskKind { override val kind = "summary" }
    data object Actions : TaskKind { override val kind = "actions" }
    data class Reply(val tone: String) : TaskKind { override val kind = "reply" }
    data class Rewrite(val tone: String) : TaskKind { override val kind = "rewrite" }
    data object Custom : TaskKind { override val kind = "custom" }

    val promptId: String get() = "task.$kind.v1"
    /** Quick tasks run phone-first; deep ones cloud-first (docs/02-ARCHITECTURE.md §5). */
    val isQuick: Boolean get() = this is Summary || this is Actions || this is Rewrite || this is Explain
    val writesAsUser: Boolean get() = this is Reply || this is Rewrite
}

/** The user's answer preference (Settings). */
enum class AnswerPreference(val wire: String) { AUTO("auto"), PHONE_ONLY("phoneOnly"), BEST("best") }

/** Result of a finished answer. `modelText` is the only answer text that may ever sync (INV-7); `restored` is local only. */
data class AnswerOutcome(
    val modelText: String,
    val restored: RestoreResult,
    val fidelity: FidelityReport,
    val route: Route,
    val modelVersion: String,
    val ranOnDevice: Boolean,
    val fellBackToPhone: Boolean,
    val latencyMs: Double,
    val receipt: Receipt?,
) {
    override fun toString(): String = "AnswerOutcome(${route.wire}, $modelVersion)"
}

/** Events of one answer: started → partial* → finished. */
sealed interface AnswerEvent {
    data class Started(val route: Route) : AnswerEvent
    data class Partial(val text: String, val segments: List<RestoredSegment>) : AnswerEvent
    data class Finished(val outcome: AnswerOutcome) : AnswerEvent
}

/** Inputs for [Answers.answer]. Only SealedText reaches an engine; restore happens on device. */
data class AnswerRequest(
    val engines: EngineProvider,
    val prompts: PromptLibrary,
    val ledger: ReceiptLedger,
    val sealed: SealedText,
    val task: TaskKind,
    /** Required for custom tasks; must itself be sealed. */
    val question: SealedText? = null,
    val history: SealedHistory? = null,
    val restore: RestoreContext,
    val preference: AnswerPreference = AnswerPreference.AUTO,
    val threadId: String,
    val sealMs: Double = 0.0,
    val armorExpected: Boolean = false,
)

/** Routing and answering (port of answer.ts / AnswerService.swift). */
object Answers {
    /** Sealed text above this (UTF-16) goes cloud-only: too big for the on-device window with instructions and output. */
    const val ON_DEVICE_LIMIT = 16_000

    fun route(task: TaskKind, sealed: SealedText, preference: AnswerPreference): Pair<Route, AnswerQuality> {
        if (preference == AnswerPreference.PHONE_ONLY) return Route.PHONE_ONLY to AnswerQuality.AUTO
        val size = sealed.value.length + sealed.renderedLegend().length
        val quality = if (preference == AnswerPreference.BEST && !task.isQuick) AnswerQuality.BEST else AnswerQuality.AUTO
        if (size > ON_DEVICE_LIMIT) return Route.CLOUD_ONLY to quality
        return (if (task.isQuick) Route.PHONE_FIRST else Route.CLOUD_FIRST) to quality
    }

    /** Renders `task.*.v1`; `question` (required for custom) must itself be sealed. */
    fun taskSpec(prompts: PromptLibrary, t: TaskKind, question: SealedText? = null): TaskSpec {
        val id = t.promptId
        val instruction = when (t) {
            is TaskKind.Reply -> prompts.render(id, mapOf("tone" to t.tone))
            is TaskKind.Rewrite -> prompts.render(id, mapOf("tone" to t.tone))
            TaskKind.Custom -> prompts.render(id, mapOf("user_question" to (question?.value ?: "Help me with this.")))
            else -> prompts.render(id)
        }
        return TaskSpec(id, instruction, if (t.isQuick) 600 else 1500)
    }

    private fun now(): Double = System.nanoTime() / 1e6

    /**
     * Answers a sealed request: route → engine → streaming restore → receipt. A receipt is written whenever the request
     * may have left the device (including a Model Armor block), but not for a phone-first answer that ran on device.
     */
    fun answer(a: AnswerRequest): Flow<AnswerEvent> = flow {
        val (r, quality) = route(a.task, a.sealed, a.preference)
        val spec = taskSpec(a.prompts, a.task, a.question)
        emit(AnswerEvent.Started(r))

        val ctx = a.restore.copy(writingAsUser = a.task.writesAsUser)
        val restorer = StreamingRestorer(ctx)
        var modelText = ""
        var modelVersion = ""
        var ranOnDevice = false
        val t0 = now()
        try {
            a.engines.sealed(r, quality).stream(a.sealed, spec, a.history).collect { chunk ->
                modelText = chunk.cumulativeText
                chunk.modelVersion?.let { if (it.isNotEmpty()) modelVersion = it }
                chunk.ranOnDevice?.let { ranOnDevice = it }
                restorer.update(modelText)
                emit(AnswerEvent.Partial(restorer.text, restorer.segments))
            }
        } catch (e: EngineError) {
            if (e.code == EngineErrorCode.ARMOR_BLOCKED) {
                a.ledger.append(a.sealed, a.threadId, r, "blocked", ArmorStatus.BLOCKED, a.sealMs, now() - t0)
            }
            throw e
        }
        restorer.finish()
        emit(AnswerEvent.Partial(restorer.text, restorer.segments))
        val latencyMs = now() - t0
        if (modelVersion == ON_DEVICE_MODEL) ranOnDevice = true
        val leftDevice = r != Route.PHONE_ONLY && !(r == Route.PHONE_FIRST && ranOnDevice)
        val receipt = if (leftDevice) {
            a.ledger.append(a.sealed, a.threadId, r, modelVersion, if (a.armorExpected) ArmorStatus.PASS else ArmorStatus.NOT_CONFIGURED, a.sealMs, latencyMs)
        } else {
            a.ledger.recordOnDeviceAnswer()
            null
        }
        emit(
            AnswerEvent.Finished(
                AnswerOutcome(
                    modelText = modelText, restored = Restorer.resultFrom(restorer), fidelity = Restorer.fidelityCheck(modelText, ctx), route = r,
                    modelVersion = modelVersion, ranOnDevice = ranOnDevice,
                    fellBackToPhone = ranOnDevice && (r == Route.CLOUD_FIRST || r == Route.CLOUD_ONLY), latencyMs = latencyMs, receipt = receipt,
                ),
            ),
        )
    }
}
