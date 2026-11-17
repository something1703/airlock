// The ONLY Android code that calls Firebase AI Logic (hybrid inference: Gemini Nano on device via ML Kit / AICore,
// Gemini in the cloud). APIs used are the ones recorded in docs/API-NOTES.md §6c (firebase-ai 18.2.0,
// firebase-ai-ondevice 16.0.0-beta08).
package app.airlock.android.engines

import app.airlock.android.AppConfig
import app.airlock.core.PhoneAvailability
import app.airlock.core.PhoneOptions
import app.airlock.core.PromptLibrary
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.GenerativeModel
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.InferenceSource
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.OnDeviceModelStatus
import com.google.firebase.ai.DownloadStatus
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerateContentResponse
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.content
import com.google.firebase.ai.type.generationConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** Download progress: 0…1, or null when the size is unknown. Ends when the model is ready or the download fails. */
sealed interface DownloadEvent {
    data class Progress(val fraction: Float?) : DownloadEvent
    data object Done : DownloadEvent
    data object Failed : DownloadEvent
}

/**
 * [ModelCaller] over Firebase AI Logic. Every call builds a new `GenerativeModel` (INV-4). Raw text only ever goes to
 * an ONLY_ON_DEVICE model, for which the SDK builds no cloud provider at all (`GenerativeModel.Builder.getModelProvider`)
 * and throws rather than fall back (INV-3).
 */
@OptIn(PublicPreviewAPI::class)
class FirebaseModelCaller(app: FirebaseApp, private val config: AppConfig) : ModelCaller {
    private val ai: FirebaseAI = Firebase.ai(
        app = app,
        backend = if (config.aiBackend == "agentPlatform") GenerativeBackend.agentPlatform(config.aiLocation) else GenerativeBackend.googleAI(),
    )

    private fun sdkMode(mode: EngineMode): InferenceMode = when (mode) {
        EngineMode.ONLY_ON_DEVICE -> InferenceMode.ONLY_ON_DEVICE
        EngineMode.PREFER_ON_DEVICE -> InferenceMode.PREFER_ON_DEVICE
        EngineMode.PREFER_IN_CLOUD -> InferenceMode.PREFER_IN_CLOUD
        EngineMode.ONLY_IN_CLOUD -> InferenceMode.ONLY_IN_CLOUD
    }

    /** A phone-only model for raw text: deterministic sampling for analysis prompts (Android exposes temperature/topK). */
    private fun phoneModel(options: PhoneOptions = PhoneOptions(greedy = true)): GenerativeModel = ai.generativeModel(
        // The name is never used: ONLY_ON_DEVICE builds no cloud provider. AppConfig is the only place names live.
        modelName = config.modelCloudQuick,
        onDeviceConfig = OnDeviceConfig(
            mode = InferenceMode.ONLY_ON_DEVICE,
            temperature = if (options.greedy) 0f else options.temperature?.toFloat(),
            topK = if (options.greedy) 1 else null,
            seed = if (options.greedy) 0 else null,
        ),
    )

    private fun model(mode: EngineMode, cloudModel: String, system: String?, maxOutputTokens: Int?): GenerativeModel = ai.generativeModel(
        modelName = cloudModel,
        generationConfig = maxOutputTokens?.let { n -> generationConfig { this.maxOutputTokens = n } },
        systemInstruction = system?.let { s -> content { text(s) } },
        requestOptions = RequestOptions(timeoutInMillis = config.cloudTimeoutMs),
        onDeviceConfig = OnDeviceConfig(mode = sdkMode(mode), maxOutputTokens = maxOutputTokens),
    )

    private fun GenerateContentResponse.piece() = Piece(text ?: "", inferenceSource == InferenceSource.ON_DEVICE)

    override suspend fun status(): PhoneAvailability = when (phoneModel().onDeviceExtension?.checkStatus()) {
        OnDeviceModelStatus.AVAILABLE -> PhoneAvailability.AVAILABLE
        OnDeviceModelStatus.DOWNLOADABLE -> PhoneAvailability.DOWNLOADABLE
        OnDeviceModelStatus.DOWNLOADING -> PhoneAvailability.DOWNLOADING
        else -> PhoneAvailability.UNAVAILABLE
    }

    override suspend fun onDevice(text: String, options: PhoneOptions): Piece = phoneModel(options).generateContent(text).piece()

    override suspend fun once(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Piece =
        model(mode, model, system, maxOutputTokens).generateContent(text).piece()

    override fun stream(mode: EngineMode, model: String, text: String, system: String?, maxOutputTokens: Int?): Flow<Piece> =
        model(mode, model, system, maxOutputTokens).generateContentStream(text).map { it.piece() }

    /** Starts (or joins) the Gemini Nano download. Must follow a user action (the button in Onboarding/Settings). */
    fun download(): Flow<DownloadEvent> {
        var total = 0L
        val ext = phoneModel().onDeviceExtension ?: return kotlinx.coroutines.flow.flowOf(DownloadEvent.Failed)
        return ext.download().map { s ->
            when (s) {
                is DownloadStatus.DownloadStarted -> {
                    total = s.bytesToDownload
                    DownloadEvent.Progress(if (total > 0) 0f else null)
                }
                is DownloadStatus.DownloadInProgress -> DownloadEvent.Progress(if (total > 0) (s.totalBytesDownloaded.toFloat() / total).coerceIn(0f, 1f) else null)
                is DownloadStatus.DownloadFailed -> DownloadEvent.Failed
                else -> DownloadEvent.Done
            }
        }
    }

    /** Loads Gemini Nano ahead of the first seal; no prompt, so no user text is involved. Errors are ignored. */
    suspend fun warmUp() {
        try {
            phoneModel().onDeviceExtension?.warmUp()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // Warm-up is an optimisation only.
        }
    }
}

/** Firebase AI Logic implementation of every engine (the app's live [app.airlock.core.EngineProvider]). */
class FirebaseEngines private constructor(val caller: FirebaseModelCaller, config: AppConfig, prompts: PromptLibrary, online: () -> Boolean) :
    app.airlock.core.EngineProvider by HybridEngines(caller, config, prompts, online) {
    constructor(app: FirebaseApp, config: AppConfig, prompts: PromptLibrary, online: () -> Boolean) :
        this(FirebaseModelCaller(app, config), config, prompts, online)
}
