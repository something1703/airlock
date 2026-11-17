package app.airlock.android.engines

import app.airlock.android.AppConfig
import app.airlock.core.AnswerQuality
import app.airlock.core.EgressGate
import app.airlock.core.EngineError
import app.airlock.core.EngineErrorCode
import app.airlock.core.EntityMap
import app.airlock.core.ON_DEVICE_MODEL
import app.airlock.core.PatternDetector
import app.airlock.core.PhoneAvailability
import app.airlock.core.PhoneOptions
import app.airlock.core.PhonePrompt
import app.airlock.core.PromptLibrary
import app.airlock.core.Route
import app.airlock.core.SealedText
import app.airlock.core.TaskSpec
import com.google.firebase.ai.type.FirebaseAIException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.UnknownException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import java.net.UnknownHostException
import java.util.Collections
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A scripted [ModelCaller]: records every call so tests can prove which mode/model/text reached the SDK seam. */
class FakeCaller(
    var status: PhoneAvailability = PhoneAvailability.AVAILABLE,
    val onDeviceAnswer: (String) -> Piece = { Piece("{\"items\":[]}", true) },
    val streams: (EngineMode, String) -> Flow<Piece> = { _, _ -> flow { emit(Piece("ok", false)) } },
    val unary: (EngineMode, String) -> Piece = { _, _ -> Piece("unary", false) },
) : ModelCaller {
    data class Call(val kind: String, val mode: EngineMode?, val model: String?, val text: String, val system: String?)

    val calls: MutableList<Call> = Collections.synchronizedList(ArrayList())

    override suspend fun status() = status
    override suspend fun onDevice(text: String, options: PhoneOptions): Piece {
        calls.add(Call("onDevice", EngineMode.ONLY_ON_DEVICE, null, text, null))
        return onDeviceAnswer(text)
    }

    override suspend fun once(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Piece {
        calls.add(Call("once", mode, model, text, system))
        return unary(mode, model)
    }

    override fun stream(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Flow<Piece> {
        calls.add(Call("stream", mode, model, text, system))
        return streams(mode, model)
    }
}

/** SDK exceptions have internal constructors (message, cause[, history]); build one by reflection. */
private inline fun <reified T : Throwable> sdkError(message: String = "secret prompt text: Maya Chen", cause: Throwable? = null): T {
    val ctor = T::class.java.declaredConstructors.filter { it.parameterTypes.firstOrNull() == String::class.java }.minBy { it.parameterCount }
    ctor.isAccessible = true
    val args = ctor.parameterTypes.mapIndexed { i, t ->
        when {
            i == 0 -> message
            Throwable::class.java.isAssignableFrom(t) -> cause
            List::class.java.isAssignableFrom(t) -> emptyList<Any>()
            else -> null
        }
    }
    return ctor.newInstance(*args.toTypedArray()) as T
}

class EnginesTest {
    private val config = AppConfig()
    private val prompts = PromptLibrary()
    private fun sealed(text: String = "Hi [[PERSON_1]]"): SealedText =
        EgressGate(PatternDetector(), emptyList()).sealToolResult(text, EntityMap(listOf(app.airlock.core.Entity.make("PERSON_1", app.airlock.core.PrivacyCategory.PERSON, "Raj", setOf(app.airlock.core.DetectorId.LLM), app.airlock.core.Confidence.HIGH))))
    private val task = TaskSpec("task.help.v1", "Help.", 100)

    // MARK: Routing

    @Test fun routeMapsToInferenceMode() {
        assertEquals(EngineMode.ONLY_ON_DEVICE, Plans.modeFor(Route.PHONE_ONLY))
        assertEquals(EngineMode.PREFER_ON_DEVICE, Plans.modeFor(Route.PHONE_FIRST))
        assertEquals(EngineMode.PREFER_IN_CLOUD, Plans.modeFor(Route.CLOUD_FIRST))
        assertEquals(EngineMode.ONLY_IN_CLOUD, Plans.modeFor(Route.CLOUD_ONLY))
        for (r in Route.entries) assertEquals(r.inferenceMode, Plans.planFor(r, config, AnswerQuality.AUTO).mode.name, "core Route and plan agree for $r")
    }

    @Test fun plansPickModelsFromConfig() {
        assertEquals(config.modelCloudQuick, Plans.planFor(Route.PHONE_FIRST, config, AnswerQuality.AUTO).cloudModel)
        assertEquals(config.modelCloudDeep, Plans.planFor(Route.CLOUD_FIRST, config, AnswerQuality.AUTO).cloudModel)
        assertEquals(config.modelCloudMax, Plans.planFor(Route.CLOUD_ONLY, config, AnswerQuality.BEST).cloudModel)
        val armor = AppConfig(mapOf("armor_expected" to "true"))
        val p = Plans.planFor(Route.CLOUD_FIRST, armor, AnswerQuality.AUTO)
        assertEquals(EngineMode.ONLY_IN_CLOUD, p.mode)
        assertTrue(p.manualOfflineFallback)
        assertEquals(listOf(config.modelCloudDeep, config.modelCloudFallback), Plans.modelChain(Plans.planFor(Route.CLOUD_FIRST, config, AnswerQuality.AUTO), config))
        assertEquals(listOf(config.modelCloudQuick), Plans.modelChain(Plans.planFor(Route.PHONE_FIRST, config, AnswerQuality.AUTO), config))
    }

    // MARK: Phone engine (INV-3, INV-9)

    @Test fun phoneEngineRunsOnlyOnDeviceAndRefusesWhenUnavailable() = runTest {
        val caller = FakeCaller(status = PhoneAvailability.UNAVAILABLE)
        val phone = HybridEngines(caller, config, prompts) { true }.phone
        val e = assertFailsWith<EngineError> { phone.respond(PhonePrompt("detect.v1", "Raw text with Maya Chen"), PhoneOptions(true)) }
        assertEquals(EngineErrorCode.UNAVAILABLE, e.code)
        assertTrue(caller.calls.isEmpty(), "nothing is generated when the model is unavailable")

        caller.status = PhoneAvailability.AVAILABLE
        val r = phone.respond(PhonePrompt("detect.v1", "Raw text with Maya Chen"), PhoneOptions(true))
        assertTrue(r.ranOnDevice)
        assertEquals(ON_DEVICE_MODEL, r.modelVersion)
        assertTrue(caller.calls.all { it.kind == "onDevice" && it.mode == EngineMode.ONLY_ON_DEVICE })
    }

    @Test fun phoneEngineRejectsAnAnswerThatDidNotRunOnDevice() = runTest {
        val caller = FakeCaller(onDeviceAnswer = { Piece("x", onDevice = false) })
        val e = assertFailsWith<EngineError> { HybridEngines(caller, config, prompts) { true }.phone.respond(PhonePrompt("detect.v1", "raw"), PhoneOptions(true)) }
        assertEquals("not-on-device", e.detail)
    }

    // MARK: Sealed engines

    @Test fun cloudRoutesSendInstructionsAsSystemAndDeviceRoutesInlineThem() = runTest {
        val caller = FakeCaller()
        val engines = HybridEngines(caller, config, prompts) { true }
        engines.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        engines.sealed(Route.PHONE_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        val (cloud, phone) = caller.calls
        assertEquals(EngineMode.PREFER_IN_CLOUD, cloud.mode)
        assertTrue(cloud.system!!.isNotEmpty())
        assertEquals(EngineMode.PREFER_ON_DEVICE, phone.mode)
        assertNull(phone.system)
        assertTrue(phone.text.startsWith(prompts.template("phone-system.v1")))
        for (c in caller.calls) assertTrue(c.text.contains("[[PERSON_1]]") && !c.text.contains("Raj"), "only sealed text reaches the model")
    }

    @Test fun streamingAccumulatesDeltasAndReportsWhereItRan() = runTest {
        val caller = FakeCaller(streams = { _, _ -> flow { emit(Piece("Hello ", true)); emit(Piece("[[PERSON_1]]", true)) } })
        val chunks = HybridEngines(caller, config, prompts) { true }.sealed(Route.PHONE_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        assertEquals("Hello [[PERSON_1]]", chunks.last().cumulativeText)
        assertEquals(ON_DEVICE_MODEL, chunks.last().modelVersion)
        assertEquals(true, chunks.last().ranOnDevice)
    }

    @Test fun aStalledModelIsSkippedForTheFallback() = runTest {
        val caller = FakeCaller(streams = { _, model -> if (model == config.modelCloudDeep) flow { awaitCancellation() } else flow { emit(Piece("from fallback", false)) } })
        val chunks = HybridEngines(caller, config, prompts) { true }.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        assertEquals("from fallback", chunks.last().cumulativeText)
        assertEquals(config.modelCloudFallback, chunks.last().modelVersion)
        assertEquals(listOf(config.modelCloudDeep, config.modelCloudFallback), caller.calls.map { it.model })
    }

    @Test fun aTransientErrorBeforeTheFirstChunkFallsBack() = runTest {
        val caller = FakeCaller(streams = { _, model -> if (model == config.modelCloudDeep) flow { throw sdkError<ServerException>("The model is overloaded (503)") } else flow { emit(Piece("ok", false)) } })
        val chunks = HybridEngines(caller, config, prompts) { true }.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        assertEquals(config.modelCloudFallback, chunks.last().modelVersion)
    }

    @Test fun allModelsFailingEndsWithOneUnaryCall() = runTest {
        val caller = FakeCaller(streams = { _, _ -> flow { throw sdkError<QuotaExceededException>() } })
        val chunks = HybridEngines(caller, config, prompts) { true }.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        assertEquals("unary", chunks.single().cumulativeText)
        assertEquals("once", caller.calls.last().kind)
    }

    @Test fun anErrorAfterTextHasStreamedSurfaces() = runTest {
        val caller = FakeCaller(streams = { _, _ -> flow { emit(Piece("partial", false)); throw sdkError<ServerException>("overloaded") } })
        val e = assertFailsWith<EngineError> { HybridEngines(caller, config, prompts) { true }.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList() }
        assertEquals(EngineErrorCode.SERVICE_UNAVAILABLE, e.code)
        assertEquals(1, caller.calls.size, "no silent replay on another model")
    }

    @Test fun offlineWithArmorExpectedAnswersOnDevice() = runTest {
        val armor = AppConfig(mapOf("armor_expected" to "true"))
        val caller = FakeCaller(
            streams = { _, _ -> flow { throw sdkError<UnknownException>("x", UnknownHostException("host")) } },
            unary = { mode, _ -> if (mode == EngineMode.ONLY_ON_DEVICE) Piece("offline answer", true) else throw sdkError<UnknownException>("x", UnknownHostException("h")) },
        )
        val chunks = HybridEngines(caller, armor, prompts) { false }.sealed(Route.CLOUD_FIRST, AnswerQuality.AUTO).stream(sealed(), task).toList()
        assertEquals("offline answer", chunks.last().cumulativeText)
        assertEquals(ON_DEVICE_MODEL, chunks.last().modelVersion)
    }

    // MARK: Error mapping (INV-8: codes only, never SDK messages)

    @Test fun sdkErrorsMapToCodesWithoutMessages() {
        val cases: List<Pair<FirebaseAIException, EngineErrorCode>> = listOf(
            sdkError<QuotaExceededException>() to EngineErrorCode.QUOTA,
            sdkError<ServerException>("The model is overloaded. Maya Chen") to EngineErrorCode.SERVICE_UNAVAILABLE,
            sdkError<ServerException>("Firebase App Check token is invalid.") to EngineErrorCode.APP_CHECK,
            sdkError<ServerException>("models/x is not found for API version v1beta") to EngineErrorCode.OTHER,
            sdkError<RequestTimeoutException>() to EngineErrorCode.SERVICE_UNAVAILABLE,
            sdkError<UnknownException>("Something unexpected happened.", UnknownHostException("firebasevertexai.googleapis.com")) to EngineErrorCode.OFFLINE,
        )
        for ((e, code) in cases) {
            val mapped = ErrorMapper.map(e) { false.takeIf { e is UnknownException } ?: true }
            assertEquals(code, mapped.code, e.javaClass.simpleName)
            assertFalse(mapped.message!!.contains("Maya") || mapped.message!!.contains("overloaded") || mapped.message!!.contains("googleapis"), "no SDK text in ${mapped.message}")
        }
        assertEquals(EngineErrorCode.SERVICE_UNAVAILABLE, ErrorMapper.map(java.io.IOException("reset")) { true }.code)
        assertEquals(EngineErrorCode.OFFLINE, ErrorMapper.map(java.io.IOException("reset")) { false }.code)
    }
}
