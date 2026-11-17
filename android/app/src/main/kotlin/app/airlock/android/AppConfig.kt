// Every tunable (port of web/src/core/appConfig.ts and AirlockCore/AppConfig.swift). The ONLY Android file that may
// spell a model name (lint-enforced). Must equal firebase/remoteconfig.template.json (AppConfigTest).
package app.airlock.android

import app.airlock.core.DialPreset
import app.airlock.core.DialPreset.BALANCED
import app.airlock.core.JsJson
import app.airlock.core.JsonSyntaxError

/** One default value, typed like the Remote Config template. */
sealed interface ConfigValue {
    /** Remote Config's string form. */
    val remote: String

    data class Str(val value: String, val json: Boolean = false) : ConfigValue { override val remote get() = value }
    data class Num(val value: Double) : ConfigValue {
        override val remote get() = if (value == Math.rint(value)) value.toLong().toString() else value.toString()
    }
    data class Bool(val value: Boolean) : ConfigValue { override val remote get() = value.toString() }
}

/**
 * Typed configuration: bundled defaults overlaid with Remote Config. Unknown or mistyped remote values fall back to
 * the defaults, so a bad console edit can never break sealing.
 */
class AppConfig(remote: Map<String, String> = emptyMap()) {
    private val values: Map<String, ConfigValue>

    init {
        val v = LinkedHashMap(DEFAULTS)
        for ((key, raw) in remote) {
            when (val def = DEFAULTS[key] ?: continue) {
                is ConfigValue.Str -> v[key] = ConfigValue.Str(raw, def.json)
                is ConfigValue.Bool -> if (raw == "true" || raw == "false") v[key] = ConfigValue.Bool(raw == "true")
                is ConfigValue.Num -> raw.trim().toDoubleOrNull()?.takeIf { it.isFinite() }?.let { v[key] = ConfigValue.Num(it) }
            }
        }
        values = v
    }

    fun string(key: String): String = (values[key] as? ConfigValue.Str)?.value ?: ""
    fun bool(key: String): Boolean = (values[key] as? ConfigValue.Bool)?.value ?: false
    fun int(key: String): Int = (values[key] as? ConfigValue.Num)?.value?.toInt() ?: 0

    val aiBackend: String get() = string("ai_backend")
    val aiLocation: String get() = string("ai_location").ifEmpty { "global" }
    val modelCloudDeep: String get() = string("model_cloud_deep")
    val modelCloudQuick: String get() = string("model_cloud_quick")
    val modelCloudMax: String get() = string("model_cloud_max")
    /** Used when the planned cloud model stalls or is overloaded (503/429) before answering. */
    val modelCloudFallback: String get() = string("model_cloud_fallback")
    val dialDefault: DialPreset get() = DialPreset.entries.firstOrNull { it.wire == string("dial_default") } ?: BALANCED
    /** Gemini Nano on Android has a ~4,000-token window, so chunks are smaller than on iOS or the web. */
    val detectChunkTokens: Int get() = maxOf(200, int("detect_chunk_tokens_android"))
    val redTeamEnabled: Boolean get() = bool("redteam_enabled")
    val redTeamRounds: Int get() = int("redteam_rounds").coerceIn(0, 2)
    val rawPurgeDays: Int get() = maxOf(0, int("raw_purge_days"))
    val armorExpected: Boolean get() = bool("armor_expected")
    /** No first streamed chunk within this → skip to the next model in the chain. */
    val cloudFirstChunkMs: Long get() = maxOf(1000, int("cloud_first_chunk_ms")).toLong()
    /** Hard limit for one cloud answer. */
    val cloudTimeoutMs: Long get() = maxOf(5000, int("cloud_timeout_ms")).toLong()
    val promptOverridesJson: String get() = string("prompt_overrides_json")
    val disabledPatternPacks: Set<String>
        get() = try {
            (JsJson.parse(string("pattern_packs_disabled")) as? List<*>)?.filterIsInstance<String>()?.toSet() ?: emptySet()
        } catch (_: JsonSyntaxError) {
            emptySet()
        }

    companion object {
        /** Bundled defaults — identical to `firebase/remoteconfig.template.json` (AppConfigTest enforces it). */
        val DEFAULTS: Map<String, ConfigValue> = linkedMapOf(
            "ai_backend" to ConfigValue.Str("googleAI"),
            "ai_location" to ConfigValue.Str("global"),
            "model_cloud_deep" to ConfigValue.Str("gemini-3.8-flash"),
            "model_cloud_quick" to ConfigValue.Str("gemini-3.5-flash-lite"),
            "model_cloud_max" to ConfigValue.Str("gemini-4-hydrogen"),
            "model_cloud_proof" to ConfigValue.Str("gemini-3.8-flash"),
            "model_cloud_fallback" to ConfigValue.Str("gemini-3.5-flash-lite"),
            "dial_default" to ConfigValue.Str("balanced"),
            "detect_chunk_tokens" to ConfigValue.Num(1400.0),
            "detect_chunk_tokens_web" to ConfigValue.Num(3000.0),
            "detect_chunk_tokens_android" to ConfigValue.Num(700.0),
            "redteam_enabled" to ConfigValue.Bool(true),
            "redteam_rounds" to ConfigValue.Num(2.0),
            "nltagger_enabled" to ConfigValue.Bool(true),
            "vision_ocr_enabled" to ConfigValue.Bool(true),
            "llm_structured_output" to ConfigValue.Bool(false),
            "pattern_packs_disabled" to ConfigValue.Str("[]", json = true),
            "prompt_overrides_json" to ConfigValue.Str("{}", json = true),
            "feature_tools_calendar" to ConfigValue.Bool(true),
            "feature_proof" to ConfigValue.Bool(true),
            "feature_infer_card" to ConfigValue.Bool(true),
            "feature_sync" to ConfigValue.Bool(true),
            "evidence_json" to ConfigValue.Str("{}", json = true),
            "min_supported_build" to ConfigValue.Num(1.0),
            "raw_purge_days" to ConfigValue.Num(30.0),
            "armor_expected" to ConfigValue.Bool(false),
            "armor_force_unary" to ConfigValue.Bool(false),
            "cloud_first_chunk_ms" to ConfigValue.Num(15000.0),
            "cloud_timeout_ms" to ConfigValue.Num(90000.0),
        )

        /** Defaults as Remote Config strings (for `setDefaultsAsync`). */
        val REMOTE_DEFAULTS: Map<String, Any> get() = DEFAULTS.mapValues { (_, v) -> v.remote }
    }
}
