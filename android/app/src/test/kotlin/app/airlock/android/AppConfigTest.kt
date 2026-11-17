package app.airlock.android

import app.airlock.core.DialPreset
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

val repoRoot: File get() = File(requireNotNull(System.getProperty("airlock.repoRoot")) { "airlock.repoRoot not set (run via Gradle)" })

/** AGENTS.md §5.4 / §10: the bundled defaults are exactly the Remote Config template. */
class AppConfigTest {
    @Test fun defaultsEqualTheRemoteConfigTemplate() {
        val template = Json.parseToJsonElement(File(repoRoot, "firebase/remoteconfig.template.json").readText()).jsonObject["parameters"]!!.jsonObject
        val expected = template.mapValues { (_, v) ->
            val o = v.jsonObject
            o["valueType"]!!.jsonPrimitive.content to o["defaultValue"]!!.jsonObject["value"]!!.jsonPrimitive.content
        }
        val actual = AppConfig.DEFAULTS.mapValues { (_, v) ->
            when (v) {
                is ConfigValue.Str -> (if (v.json) "JSON" else "STRING") to v.remote
                is ConfigValue.Num -> "NUMBER" to v.remote
                is ConfigValue.Bool -> "BOOLEAN" to v.remote
            }
        }
        assertEquals(expected.toSortedMap(), actual.toSortedMap())
    }

    @Test fun typedGettersUseAndroidValues() {
        val c = AppConfig()
        assertEquals(700, c.detectChunkTokens)
        assertEquals(DialPreset.BALANCED, c.dialDefault)
        assertEquals(15_000L, c.cloudFirstChunkMs)
        assertEquals(90_000L, c.cloudTimeoutMs)
        assertEquals(emptySet(), c.disabledPatternPacks)
    }

    @Test fun remoteValuesOverrideOnlyWhenWellTyped() {
        val c = AppConfig(
            mapOf(
                "model_cloud_deep" to "remote-deep", "redteam_rounds" to "7", "redteam_enabled" to "yes", "detect_chunk_tokens_android" to "abc",
                "pattern_packs_disabled" to "[\"national\"]", "unknown_key" to "x", "dial_default" to "strict",
            ),
        )
        assertEquals("remote-deep", c.modelCloudDeep)
        assertEquals(2, c.redTeamRounds) // clamped
        assertTrue(c.redTeamEnabled) // "yes" is not a boolean → default
        assertEquals(700, c.detectChunkTokens) // not a number → default
        assertEquals(setOf("national"), c.disabledPatternPacks)
        assertEquals(DialPreset.STRICT, c.dialDefault)
    }

    @Test fun modelNamesOnlyAppearInAppConfig() {
        val main = File(repoRoot, "android/app/src/main/kotlin")
        val offenders = main.walkTopDown().filter { it.isFile && it.extension == "kt" && it.name != "AppConfig.kt" }
            .filter { Regex("gemini-[0-9]").containsMatchIn(it.readText()) }.map { it.name }.toList()
        assertEquals(emptyList(), offenders)
    }
}
