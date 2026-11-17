package app.airlock.android.engines

import app.airlock.core.EngineError
import app.airlock.core.EngineErrorCode
import com.google.firebase.ai.type.APINotConfiguredException
import com.google.firebase.ai.type.ContentBlockedException
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.FirebaseAIOnDeviceInvalidRequestException
import com.google.firebase.ai.type.FirebaseAIOnDeviceNotAvailableException
import com.google.firebase.ai.type.FirebaseAIOnDeviceUnknownException
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.PublicPreviewAPI
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.ServiceDisabledException
import com.google.firebase.ai.type.UnknownException
import com.google.firebase.ai.type.UnsupportedUserLocationException
import java.io.IOException

/**
 * Maps any Firebase AI Logic / network error to an [EngineError] carrying a code and a fixed, content-free detail —
 * never the SDK's message, which can echo prompt or answer text (INV-8). The SDK's `ServerException` has no status
 * code (firebase-ai 18.2.0 `APIController.validateResponse`), so its message is *read* to classify it, never kept.
 */
@OptIn(PublicPreviewAPI::class)
object ErrorMapper {
    fun map(e: Throwable, online: () -> Boolean = { true }, depth: Int = 0): EngineError = when (e) {
        is EngineError -> e
        is QuotaExceededException -> EngineError(EngineErrorCode.QUOTA)
        is PromptBlockedException ->
            if (e.response?.promptFeedback?.blockReason?.name == "MODEL_ARMOR") EngineError(EngineErrorCode.ARMOR_BLOCKED) else EngineError(EngineErrorCode.CLOUD_BLOCKED)
        is ContentBlockedException -> EngineError(EngineErrorCode.CLOUD_BLOCKED)
        is ResponseStoppedException -> when (e.response.candidates.firstOrNull()?.finishReason) {
            FinishReason.MAX_TOKENS -> EngineError(EngineErrorCode.OTHER, "maxTokens")
            FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII, FinishReason.BLOCKLIST ->
                EngineError(EngineErrorCode.CLOUD_BLOCKED)
            else -> EngineError(EngineErrorCode.OTHER, "stopped")
        }
        is RequestTimeoutException -> EngineError(EngineErrorCode.SERVICE_UNAVAILABLE, "timeout")
        is ServerException -> server(e.message.orEmpty())
        is InvalidAPIKeyException -> EngineError(EngineErrorCode.OTHER, "apiKey")
        is ServiceDisabledException, is APINotConfiguredException -> EngineError(EngineErrorCode.OTHER, "api-not-enabled")
        is UnsupportedUserLocationException -> EngineError(EngineErrorCode.OTHER, "location")
        is FirebaseAIOnDeviceNotAvailableException -> EngineError(EngineErrorCode.UNAVAILABLE)
        // ML Kit REQUEST_TOO_LARGE / TOO_SMALL: the detector halves the chunk on contextTooLong.
        is FirebaseAIOnDeviceInvalidRequestException -> EngineError(EngineErrorCode.CONTEXT_TOO_LONG)
        is FirebaseAIOnDeviceUnknownException -> EngineError(EngineErrorCode.OTHER, "ondevice")
        is SerializationException -> EngineError(EngineErrorCode.PARSE)
        is IOException -> if (online()) EngineError(EngineErrorCode.SERVICE_UNAVAILABLE, "network") else EngineError(EngineErrorCode.OFFLINE)
        is UnknownException -> e.cause?.takeIf { depth < 4 }?.let { map(it, online, depth + 1) } ?: EngineError(EngineErrorCode.OTHER, "unknown")
        else -> e.cause?.takeIf { depth < 4 && it !== e }?.let { map(it, online, depth + 1) }
            ?: if (!online()) EngineError(EngineErrorCode.OFFLINE) else EngineError(EngineErrorCode.OTHER, "unknown")
    }

    private fun server(message: String): EngineError {
        val m = message.lowercase()
        return when {
            "app check" in m || "appcheck" in m || "unauthenticated" in m -> EngineError(EngineErrorCode.APP_CHECK)
            "not found" in m || "not_found" in m || "no longer available" in m -> EngineError(EngineErrorCode.OTHER, "http.404")
            "invalid_argument" in m || "invalid argument" in m -> EngineError(EngineErrorCode.OTHER, "http.400")
            "permission" in m -> EngineError(EngineErrorCode.APP_CHECK, "http.403")
            // 500/503 "overloaded", "UNAVAILABLE", unexpected bodies: transient, so the model fallback chain runs.
            else -> EngineError(EngineErrorCode.SERVICE_UNAVAILABLE, "server")
        }
    }
}
