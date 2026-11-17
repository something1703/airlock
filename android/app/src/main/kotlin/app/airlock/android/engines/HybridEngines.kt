package app.airlock.android.engines

import app.airlock.android.AppConfig
import app.airlock.core.AnswerQuality
import app.airlock.core.EngineChunk
import app.airlock.core.EngineError
import app.airlock.core.EngineErrorCode
import app.airlock.core.EngineProvider
import app.airlock.core.EngineResult
import app.airlock.core.ON_DEVICE_MODEL
import app.airlock.core.PhoneAvailability
import app.airlock.core.PhoneOnlyEngine
import app.airlock.core.PhoneOptions
import app.airlock.core.PhonePrompt
import app.airlock.core.PromptLibrary
import app.airlock.core.Route
import app.airlock.core.SealedEngine
import app.airlock.core.SealedHistory
import app.airlock.core.SealedText
import app.airlock.core.TaskSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout

/** One piece of model output: delta text plus where it ran (from the SDK's `inferenceSource`). */
data class Piece(val text: String, val onDevice: Boolean)

/**
 * The thin seam over Firebase AI Logic. [FirebaseModelCaller] is the only implementation that talks to the SDK;
 * tests script this interface to exercise routing, the fallback chain and the stream guards without a network.
 */
interface ModelCaller {
    /** On-device model state (`OnDeviceExtension.checkStatus`). */
    suspend fun status(): PhoneAvailability

    /** ONLY_ON_DEVICE generation for raw text (INV-3). Must never construct a cloud provider. */
    suspend fun onDevice(text: String, options: PhoneOptions): Piece

    /** One unary call on sealed text. */
    suspend fun once(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Piece

    /** Streamed call on sealed text; each piece is a delta. */
    fun stream(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Flow<Piece>
}

/**
 * Engines over a [ModelCaller]: the phone engine accepts raw text and only ever runs ONLY_ON_DEVICE (INV-3); sealed
 * engines accept only [SealedText] (INV-1). A fresh model per call (INV-4) is the caller's job.
 */
class HybridEngines(
    private val caller: ModelCaller,
    private val config: AppConfig,
    private val prompts: PromptLibrary,
    private val online: () -> Boolean,
) : EngineProvider {
    override val phone: PhoneOnlyEngine = HybridPhoneEngine(caller, online)
    override fun sealed(route: Route, quality: AnswerQuality): SealedEngine = HybridSealedEngine(caller, config, prompts, Plans.planFor(route, config, quality), online)
}

private fun now(): Double = System.nanoTime() / 1e6

/** Phone-only: refuses unless the on-device model is ready, and rejects any answer that did not run on device. */
class HybridPhoneEngine(private val caller: ModelCaller, private val online: () -> Boolean) : PhoneOnlyEngine {
    override suspend fun availability(): PhoneAvailability = try {
        caller.status()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        PhoneAvailability.UNKNOWN
    }

    override suspend fun respond(prompt: PhonePrompt, options: PhoneOptions): EngineResult {
        val avail = availability()
        if (avail != PhoneAvailability.AVAILABLE) throw EngineError(EngineErrorCode.UNAVAILABLE, avail.wire)
        val t0 = now()
        val text = if (prompt.instructions != null) "${prompt.instructions}\n\n${prompt.text}" else prompt.text
        val piece = try {
            caller.onDevice(text, options)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ErrorMapper.map(e, online)
        }
        if (!piece.onDevice) throw EngineError(EngineErrorCode.OTHER, "not-on-device")
        return EngineResult(piece.text, ON_DEVICE_MODEL, true, now() - t0)
    }
}

/**
 * A sealed engine for one route. Streams with a fallback chain: planned model → `model_cloud_fallback` → one unary
 * call to the fallback. A model is skipped only if it fails *before its first chunk* with a stall
 * (`cloud_first_chunk_ms`) or a transient error (503/429); once text has streamed, errors surface (no silent
 * replays). `modelVersion` is whichever model actually answered, so the route badge and receipt stay truthful.
 * Note (API-NOTES §6c): Android PREFER_IN_CLOUD falls back on device only when offline, so this chain matters.
 */
class HybridSealedEngine(
    private val caller: ModelCaller,
    private val config: AppConfig,
    private val prompts: PromptLibrary,
    val plan: ModelPlan,
    private val online: () -> Boolean,
    private val retryDelayMs: Long = 500,
) : SealedEngine {
    override val route: Route get() = plan.route

    private data class Turn(val text: String, val system: String?)

    private fun turn(sealed: SealedText, task: TaskSpec, history: SealedHistory?): Turn {
        val userTurn = prompts.cloudUserTurn(sealed, task, history)
        val instructions = prompts.template(plan.instructionsId)
        // On-device-first routes: the on-device model may not see a cloud system instruction, so inline it.
        return if (plan.mode.startsOnDevice) Turn("$instructions\n\n$userTurn", null) else Turn(userTurn, instructions)
    }

    private fun models(): List<String> = Plans.modelChain(plan, config)

    private fun version(piece: Piece, model: String): String = if (piece.onDevice) ON_DEVICE_MODEL else model

    private fun map(e: Throwable): EngineError = ErrorMapper.map(e, online)

    override suspend fun respond(sealed: SealedText, task: TaskSpec, history: SealedHistory?): EngineResult {
        val t = turn(sealed, task, history)
        try {
            var last: EngineError? = null
            for (model in models()) {
                try {
                    return withRetry { once(plan.mode, model, t.text, t.system, task.maxOutputTokens) }
                } catch (e: EngineError) {
                    last = e
                    if (!e.isTransientCloud) throw e
                }
            }
            throw last ?: EngineError(EngineErrorCode.SERVICE_UNAVAILABLE)
        } catch (e: EngineError) {
            if (e.code == EngineErrorCode.OFFLINE && plan.manualOfflineFallback) {
                return once(EngineMode.ONLY_ON_DEVICE, plan.cloudModel, "${t.system ?: ""}\n\n${t.text}", null, task.maxOutputTokens)
            }
            throw e
        }
    }

    private suspend fun once(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): EngineResult {
        val t0 = now()
        val piece = try {
            caller.once(mode, model, text, system, maxOutputTokens)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw map(e)
        }
        return EngineResult(piece.text, version(piece, model), piece.onDevice, now() - t0)
    }

    override fun stream(sealed: SealedText, task: TaskSpec, history: SealedHistory?): Flow<EngineChunk> = channelFlow {
        val t = turn(sealed, task, history)
        try {
            val models = models()
            for (model in models) {
                if (streamOnce(plan.mode, model, t.text, t.system, task.maxOutputTokens)) return@channelFlow
            }
            val r = once(plan.mode, models.last(), t.text, t.system, task.maxOutputTokens)
            send(EngineChunk(r.text, r.modelVersion, r.ranOnDevice))
        } catch (e: EngineError) {
            if (e.code == EngineErrorCode.OFFLINE && plan.manualOfflineFallback) {
                val r = once(EngineMode.ONLY_ON_DEVICE, plan.cloudModel, "${t.system ?: ""}\n\n${t.text}", null, task.maxOutputTokens)
                send(EngineChunk(r.text, r.modelVersion, r.ranOnDevice))
                return@channelFlow
            }
            throw e
        }
    }

    /**
     * One streamed attempt. Returns true when done, false when the model produced nothing and either stalled or
     * failed transiently (so the next model is tried). Throws otherwise.
     */
    private suspend fun ProducerScope<EngineChunk>.streamOnce(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Boolean {
        var gotChunk = false
        var stalled = false
        var acc = ""
        try {
            withTimeout(config.cloudTimeoutMs) {
                supervisorScope {
                    val collector = async {
                        caller.stream(mode, model, text, system, maxOutputTokens).collect { p ->
                            gotChunk = true
                            acc += p.text
                            send(EngineChunk(acc, version(p, model), p.onDevice))
                        }
                    }
                    val guard = launch {
                        delay(config.cloudFirstChunkMs)
                        if (!gotChunk) {
                            stalled = true
                            collector.cancel()
                        }
                    }
                    try {
                        collector.await()
                    } finally {
                        guard.cancel()
                    }
                }
            }
            return true
        } catch (e: TimeoutCancellationException) {
            throw EngineError(EngineErrorCode.SERVICE_UNAVAILABLE, "timeout")
        } catch (e: CancellationException) {
            if (stalled && !gotChunk) return false
            throw e
        } catch (e: Exception) {
            val err = map(e)
            if (gotChunk) throw err
            if (err.isTransientCloud) return false
            throw err
        }
    }

    /** Exponential backoff ×3 (0.5 s, 1 s, 2 s) for 429/503. */
    private suspend fun <T> withRetry(op: suspend () -> T): T {
        var delayMs = retryDelayMs
        var attempt = 0
        while (true) {
            try {
                return op()
            } catch (e: EngineError) {
                if (!e.isTransientCloud || attempt >= 3) throw e
                delay(delayMs)
                delayMs *= 2
                attempt++
            }
        }
    }
}
