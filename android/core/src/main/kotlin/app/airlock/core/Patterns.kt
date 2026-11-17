package app.airlock.core

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/** Context words that must (or may) appear near a pattern hit. Mirrors the pack JSON schema. */
@Serializable
data class PatternContext(
    val words: List<String>,
    val before: Int,
    val after: Int,
    val required: Boolean,
    val subtype: String? = null,
    val confidence: String? = null,
)

/** One regex rule from a pattern pack. `regex` is JavaScript/ICU syntax, compiled with [Js.pattern]. */
@Serializable
data class PatternRule(
    val id: String,
    val category: String,
    val subtype: String,
    val confidence: String,
    val regex: String,
    val caseInsensitive: Boolean = false,
    val group: Int? = null,
    val validator: String? = null,
    val shrink: Boolean = false,
    val context: PatternContext? = null,
)

/** A named set of rules (core, national). Packs are the same files the Swift package ships. */
@Serializable
data class PatternPack(val id: String, val description: String, val rules: List<PatternRule>)

object PatternPacks {
    private val json = Json { ignoreUnknownKeys = true }

    /** Loads `airlock/packs/<name>.json` from the classpath (copied from the Swift package at build time). */
    fun load(name: String): PatternPack {
        val stream = requireNotNull(PatternPacks::class.java.getResourceAsStream("/airlock/packs/$name.json")) { "pattern pack $name missing" }
        return json.decodeFromString(PatternPack.serializer(), stream.use { it.readBytes().toString(Charsets.UTF_8) })
    }

    /** The bundled packs, in order: core, national. */
    val BUNDLED: List<PatternPack> by lazy { listOf(load("core"), load("national")) }
}

/**
 * D2 — deterministic pattern detectors (port of patterns.ts / PatternDetector.swift). Pure regex rules, so
 * results match the Swift and web engines. Returned candidates never overlap and are sorted by span.
 */
class PatternDetector(packs: List<PatternPack> = PatternPacks.BUNDLED, disabled: Set<String> = emptySet()) {
    private class Compiled(
        val rule: PatternRule,
        val category: PrivacyCategory,
        val confidence: Confidence,
        val regex: Pattern,
        val validator: Validator?,
        val contextConfidence: Confidence?,
    )

    private val rules: List<Compiled>

    init {
        val out = ArrayList<Compiled>()
        for (pack in packs) {
            if (pack.id in disabled) continue
            for (rule in pack.rules) {
                val regex = try {
                    Js.pattern(rule.regex, rule.caseInsensitive)
                } catch (e: PatternSyntaxException) {
                    throw IllegalArgumentException("bad regex in rule ${rule.id}")
                } catch (e: IllegalArgumentException) {
                    throw IllegalArgumentException("bad regex in rule ${rule.id}")
                }
                val validator = rule.validator?.let { Validators.named(it) ?: throw IllegalArgumentException("unknown validator $it in rule ${rule.id}") }
                val category = requireNotNull(PrivacyCategory.fromWire(rule.category)) { "unknown category in rule ${rule.id}" }
                val confidence = requireNotNull(Confidence.fromWire(rule.confidence)) { "unknown confidence in rule ${rule.id}" }
                out.add(Compiled(rule, category, confidence, regex, validator, rule.context?.confidence?.let { Confidence.fromWire(it) }))
            }
        }
        rules = out
    }

    fun detect(text: String): List<Candidate> {
        val hits = ArrayList<Candidate>()
        for (c in rules) {
            val rule = c.rule
            val m = c.regex.matcher(text)
            while (m.find()) {
                val g = rule.group ?: 0
                if (g > m.groupCount()) continue
                val start = m.start(g)
                var end = m.end(g)
                if (start < 0) continue
                if (end <= start) continue
                var value = text.substring(start, end)
                if (c.validator != null && !c.validator.invoke(value)) {
                    val shrunk = if (rule.shrink) shrinkToValid(value, c.validator) else null
                    if (shrunk == null) continue
                    value = shrunk
                    end = start + shrunk.length
                }
                var subtype = rule.subtype
                var confidence = c.confidence
                val ctx = rule.context
                if (ctx != null) {
                    val present = contextPresent(ctx, start, end, text)
                    if (ctx.required && !present) continue
                    if (present) {
                        if (ctx.subtype != null) subtype = ctx.subtype
                        if (c.contextConfidence != null) confidence = c.contextConfidence
                    }
                }
                hits.add(Candidate(TextSpan(start, end), value, c.category, subtype, DetectorId.PATTERN, confidence))
            }
        }
        return resolveOverlaps(hits)
    }

    companion object {
        /** Longest span first, then category priority, then confidence, then position; keep non-overlapping. */
        fun resolveOverlaps(hits: List<Candidate>): List<Candidate> {
            val ordered = hits.sortedWith { a, b ->
                when {
                    a.span.length != b.span.length -> b.span.length - a.span.length
                    a.category.priority != b.category.priority -> a.category.priority - b.category.priority
                    a.confidence != b.confidence -> b.confidence.rank - a.confidence.rank
                    else -> a.span.compareTo(b.span)
                }
            }
            val kept = ArrayList<Candidate>()
            for (h in ordered) if (kept.none { it.span.overlaps(h.span) }) kept.add(h)
            return kept.sortedWith { a, b -> a.span.compareTo(b.span) }
        }

        /** Characters trimmed from token edges before context matching (punctuation + symbols, but not '#'). */
        private fun trimEdges(s: String): String = Js.trimWhere(s) { it != '#'.code && (Js.isP(it) || Js.isS(it)) }

        fun contextTokens(s: String): List<String> = Js.splitWhitespace(s.lowercase()).map(::trimEdges).filter { it.isNotEmpty() }

        private fun shrinkToValid(value: String, validator: Validator): String? {
            val parts = value.split(" ").toMutableList()
            while (parts.size > 1) {
                parts.removeAt(parts.size - 1)
                val candidate = parts.joinToString(" ")
                if (validator(candidate)) return candidate
            }
            return null
        }

        private fun contextPresent(ctx: PatternContext, start: Int, end: Int, text: String): Boolean {
            val window = 160
            val beforeText = text.substring(maxOf(0, start - window), start)
            val afterText = text.substring(end, minOf(text.length, end + window))
            val beforeAll = contextTokens(beforeText)
            val before = if (ctx.before == 0) beforeAll else beforeAll.takeLast(minOf(ctx.before, beforeAll.size))
            val after = if (ctx.after > 0) contextTokens(afterText).take(ctx.after) else emptyList()
            val joined = " " + ((if (ctx.before > 0) before else emptyList()) + after).joinToString(" ") + " "
            return ctx.words.any { joined.contains(" $it ") }
        }
    }
}
