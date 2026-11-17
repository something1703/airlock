package app.airlock.android.engines

import app.airlock.android.AppConfig
import app.airlock.core.AnswerQuality
import app.airlock.core.Route

/** Firebase AI Logic `InferenceMode`, as a plain enum so routing is testable without the SDK. */
enum class EngineMode { ONLY_ON_DEVICE, PREFER_ON_DEVICE, PREFER_IN_CLOUD, ONLY_IN_CLOUD;

    val startsOnDevice: Boolean get() = this == ONLY_ON_DEVICE || this == PREFER_ON_DEVICE
}

/** How one sealed answer is produced (docs/02-ARCHITECTURE.md §4–5). */
data class ModelPlan(
    val route: Route,
    val mode: EngineMode,
    val cloudModel: String,
    val instructionsId: String,
    /** With Model Armor expected, cloud-first runs cloud-only and retries on device only when offline. */
    val manualOfflineFallback: Boolean,
)

/** Route → plan. Same table as the web (`planFor` in web/src/ai/firebaseEngines.ts). */
object Plans {
    fun modeFor(route: Route): EngineMode = when (route) {
        Route.PHONE_ONLY -> EngineMode.ONLY_ON_DEVICE
        Route.PHONE_FIRST -> EngineMode.PREFER_ON_DEVICE
        Route.CLOUD_FIRST -> EngineMode.PREFER_IN_CLOUD
        Route.CLOUD_ONLY -> EngineMode.ONLY_IN_CLOUD
    }

    fun planFor(route: Route, config: AppConfig, quality: AnswerQuality): ModelPlan {
        val deep = if (quality == AnswerQuality.BEST) config.modelCloudMax else config.modelCloudDeep
        return when (route) {
            Route.PHONE_ONLY -> ModelPlan(route, EngineMode.ONLY_ON_DEVICE, config.modelCloudQuick, "phone-system.v1", false)
            Route.PHONE_FIRST -> ModelPlan(route, EngineMode.PREFER_ON_DEVICE, config.modelCloudQuick, "phone-system.v1", false)
            Route.CLOUD_FIRST ->
                if (config.armorExpected) ModelPlan(route, EngineMode.ONLY_IN_CLOUD, deep, "cloud-system.v1", true)
                else ModelPlan(route, EngineMode.PREFER_IN_CLOUD, deep, "cloud-system.v1", false)
            Route.CLOUD_ONLY -> ModelPlan(route, EngineMode.ONLY_IN_CLOUD, deep, "cloud-system.v1", false)
        }
    }

    /** The planned model, then `model_cloud_fallback` if different. */
    fun modelChain(plan: ModelPlan, config: AppConfig): List<String> = listOf(plan.cloudModel, config.modelCloudFallback).distinct()
}
