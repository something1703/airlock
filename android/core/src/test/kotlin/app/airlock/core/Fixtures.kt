package app.airlock.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File

/** Loads `spec/fixtures/<name>` — the cross-platform conformance suite shared with Swift and the web. */
object Fixtures {
    val repoRoot: File = File(requireNotNull(System.getProperty("airlock.repoRoot")) { "airlock.repoRoot not set (run via Gradle)" })
    val json = Json { ignoreUnknownKeys = true }

    fun element(name: String): JsonElement = json.parseToJsonElement(File(repoRoot, "spec/fixtures/$name").readText())
    inline fun <reified T> load(name: String): T = json.decodeFromString(File(repoRoot, "spec/fixtures/$name").readText())
    fun repoFile(path: String): File = File(repoRoot, path)
}

/** Deterministic RNG (mulberry32, identical to web/tests/support.ts) so property-test failures reproduce. */
class Mulberry32(seed: Int) {
    private var a: Int = seed
    fun next(): Double {
        a += 0x6d2b79f5
        var t = a
        t = (t xor (t ushr 15)) * (t or 1)
        t = t xor (t + (t xor (t ushr 7)) * (t or 61))
        return ((t xor (t ushr 14)).toUInt().toDouble()) / 4294967296.0
    }
    fun <T> pick(xs: List<T>): T = xs[(next() * xs.size).toInt()]
    fun int(lo: Int, hi: Int): Int = lo + (next() * (hi - lo + 1)).toInt()
}
