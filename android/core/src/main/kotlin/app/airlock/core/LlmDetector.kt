package app.airlock.core

import kotlin.coroutines.cancellation.CancellationException

/** What the on-device LLM detector found and what went wrong; failures are reported, never hidden. */
data class LLMDetectionReport(
    val candidates: List<Candidate> = emptyList(),
    val failedChunks: List<Int> = emptyList(),
    val refusedChunks: List<Int> = emptyList(),
    val hallucinatedDropped: Int = 0,
    val repairsUsed: Int = 0,
    val unavailable: PhoneAvailability? = null,
    val chunkCount: Int = 0,
) {
    val isComplete: Boolean get() = failedChunks.isEmpty() && refusedChunks.isEmpty() && unavailable == null
}

/** Lenient JSON helpers shared by the LLM-facing stages. */
object ModelJson {
    /** First balanced `{…}` (code fences and prose around it are ignored). */
    fun firstJsonObject(s: String): String? {
        val start = s.indexOf('{')
        if (start < 0) return null
        var depth = 0
        var inString = false
        var escaped = false
        for (i in start until s.length) {
            val c = s[i]
            if (inString) {
                if (escaped) escaped = false
                else if (c == '\\') escaped = true
                else if (c == '"') inString = false
                continue
            }
            if (c == '"') inString = true
            else if (c == '{') depth++
            else if (c == '}') {
                depth--
                if (depth == 0) return s.substring(start, i + 1)
            }
        }
        return null
    }

    /** `JSON.parse(firstJsonObject(s))` as an object, or null. */
    fun firstObject(s: String): Map<*, *>? {
        val json = firstJsonObject(s) ?: return null
        return try {
            JsJson.parse(json) as? Map<*, *>
        } catch (_: JsonSyntaxError) {
            null
        }
    }
}

/**
 * D4 — on-device LLM detection (port of llmDetector.ts / LLMDetector.swift; prompt `detect.v1`). Phone-only (INV-3).
 * Every returned candidate is an exact substring of the input; invented items are dropped. Broken JSON gets one
 * `detect-repair.v1` attempt; `contextTooLong` halves the chunk (≤ 2 times); refusals and failures are reported.
 */
class LLMDetector(val engine: PhoneOnlyEngine, val prompts: PromptLibrary, val budgetTokens: Int) {
    private class Item(val text: String, val type: String, val role: String?, val sameAs: String?, val confidence: Confidence)

    private class Acc {
        val candidates = ArrayList<Candidate>()
        val failed = ArrayList<Int>()
        val refused = ArrayList<Int>()
        var hallucinated = 0
        var repairs = 0
        var unavailable: PhoneAvailability? = null
        var chunkCount = 0
        fun report() = LLMDetectionReport(candidates.toList(), failed.toList(), refused.toList(), hallucinated, repairs, unavailable, chunkCount)
    }

    private sealed interface Outcome {
        data class Found(val candidates: List<Candidate>) : Outcome
        data object Stop : Outcome
    }

    suspend fun detect(text: String, progress: (section: Int, of: Int) -> Unit = { _, _ -> }): LLMDetectionReport {
        val acc = Acc()
        val availability = engine.availability()
        if (availability != PhoneAvailability.AVAILABLE) {
            acc.unavailable = availability
            return acc.report()
        }
        val cs = Chunker.chunks(text, budgetTokens)
        acc.chunkCount = cs.size
        val seen = HashSet<String>()
        for (chunk in cs) {
            progress(chunk.index + 1, cs.size)
            val outcome = run(chunk, text, 0, acc)
            if (outcome !is Outcome.Found) break
            for (c in outcome.candidates) {
                if (seen.add("${c.span.start}:${c.span.end}:${c.category.wire}")) acc.candidates.add(c)
            }
        }
        acc.candidates.sortWith { a, b -> if (a.span.start != b.span.start) a.span.start - b.span.start else a.span.end - b.span.end }
        return acc.report()
    }

    private suspend fun ask(promptId: String, vars: Map<String, String>): String =
        engine.respond(PhonePrompt(promptId, prompts.render(promptId, vars)), ANALYSIS_OPTIONS).text

    private suspend fun run(chunk: Chunk, fullText: String, depth: Int, acc: Acc): Outcome {
        val output = try {
            ask("detect.v1", mapOf("chunk" to chunk.text))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return handle(e, chunk, fullText, depth, acc)
        }
        parseItems(output)?.let { return Outcome.Found(locate(it, chunk, acc)) }

        acc.repairs++
        val repaired = try {
            ask("detect-repair.v1", mapOf("broken" to output))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return handle(e, chunk, fullText, depth, acc)
        }
        parseItems(repaired)?.let { return Outcome.Found(locate(it, chunk, acc)) }
        acc.failed.add(chunk.index)
        return Outcome.Found(emptyList())
    }

    private suspend fun handle(e: Exception, chunk: Chunk, fullText: String, depth: Int, acc: Acc): Outcome {
        val code = (e as? EngineError)?.code ?: EngineErrorCode.OTHER
        if (code == EngineErrorCode.CONTEXT_TOO_LONG && depth < 2) {
            val found = ArrayList<Candidate>()
            for (half in Chunker.halve(chunk, fullText)) {
                if (half.span == chunk.span) continue
                val o = run(half, fullText, depth + 1, acc)
                if (o !is Outcome.Found) return o
                found.addAll(o.candidates)
            }
            return Outcome.Found(found)
        }
        return when (code) {
            EngineErrorCode.REFUSED -> { acc.refused.add(chunk.index); Outcome.Found(emptyList()) }
            EngineErrorCode.UNAVAILABLE -> { acc.unavailable = PhoneAvailability.UNAVAILABLE; Outcome.Stop }
            EngineErrorCode.CANCELLED -> Outcome.Stop
            else -> { acc.failed.add(chunk.index); Outcome.Found(emptyList()) }
        }
    }

    private fun parseItems(output: String): List<Item>? {
        val obj = ModelJson.firstObject(output) ?: return null
        val items = obj["items"] as? List<*> ?: return null
        val out = ArrayList<Item>()
        for (raw in items) {
            val d = raw as? Map<*, *> ?: continue
            val text = d["text"] as? String ?: continue
            val type = d["type"] as? String ?: continue
            if (Js.trim(text).isEmpty()) continue
            val conf = (d["confidence"] as? String)?.lowercase() ?: ""
            out.add(Item(text, type.uppercase(), d["role"] as? String, d["same_as"] as? String, Confidence.entries.firstOrNull { it.wire == conf } ?: Confidence.MEDIUM))
        }
        return out
    }

    private fun locate(items: List<Item>, chunk: Chunk, acc: Acc): List<Candidate> {
        val out = ArrayList<Candidate>()
        for (item in items) {
            val category = CATEGORY[item.type] ?: continue
            val ranges = occurrences(item.text, chunk.text)
            if (ranges.isEmpty()) {
                acc.hallucinated++
                continue
            }
            val subtype = when (category) {
                PrivacyCategory.LOCATION -> if (Js.any(item.text, Js::isN)) "address" else "place"
                PrivacyCategory.DATE -> "dob"
                else -> null
            }
            for (r in ranges) {
                out.add(
                    Candidate(
                        span = TextSpan(chunk.span.start + r.start, chunk.span.start + r.end), text = chunk.text.substring(r.start, r.end),
                        category = category, subtype = subtype, detector = DetectorId.LLM, confidence = item.confidence,
                        roleHint = item.role, sameAs = item.sameAs,
                    ),
                )
            }
        }
        return out
    }

    companion object {
        private val CATEGORY = mapOf(
            "PERSON" to PrivacyCategory.PERSON, "NAME" to PrivacyCategory.PERSON, "ORG" to PrivacyCategory.ORG, "ORGANIZATION" to PrivacyCategory.ORG,
            "ORGANISATION" to PrivacyCategory.ORG, "COMPANY" to PrivacyCategory.ORG, "LOCATION" to PrivacyCategory.LOCATION, "LOC" to PrivacyCategory.LOCATION,
            "PLACE" to PrivacyCategory.LOCATION, "ADDRESS" to PrivacyCategory.LOCATION, "CONTACT" to PrivacyCategory.CONTACT, "EMAIL" to PrivacyCategory.CONTACT,
            "PHONE" to PrivacyCategory.CONTACT, "ID" to PrivacyCategory.ID, "NUMBER" to PrivacyCategory.ID, "DATE" to PrivacyCategory.DATE, "DOB" to PrivacyCategory.DATE,
            "HEALTH" to PrivacyCategory.HEALTH, "MEDICAL" to PrivacyCategory.HEALTH, "SECRET" to PrivacyCategory.SECRET, "PASSWORD" to PrivacyCategory.SECRET,
        )

        /** Word-bounded occurrences: exact case first, then case-insensitive (boundaries judged on the original text). */
        fun occurrences(needle: String, hay: String): List<TextSpan> {
            fun scan(h: String, n: String): List<TextSpan> {
                val out = ArrayList<TextSpan>()
                var from = 0
                while (from < h.length) {
                    val i = h.indexOf(n, from)
                    if (i < 0) break
                    if (FoldedSearch.isBoundary(hay, i - 1) && FoldedSearch.isBoundary(hay, i + n.length)) out.add(TextSpan(i, i + n.length))
                    from = i + maxOf(1, n.length)
                }
                return out
            }
            val exact = scan(hay, needle)
            if (exact.isNotEmpty()) return exact
            val lower = hay.lowercase()
            return if (lower.length == hay.length) scan(lower, needle.lowercase()) else emptyList()
        }
    }
}
