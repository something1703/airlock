package app.airlock.core

import kotlin.coroutines.cancellation.CancellationException

/** What a re-identification guess is about. */
enum class RiskAttribute(val wire: String) {
    IDENTITY("identity"), LOCATION("location"), EMPLOYER("employer"), OCCUPATION("occupation"), AGE("age"), RELATIONSHIP("relationship"), EVENT("event");

    companion object {
        fun fromWire(s: String): RiskAttribute? = entries.firstOrNull { it.wire == s }
    }
}

/** One Risk card: "A reader could still guess …, because of …". `evidence` is exact draft text (on device only). */
data class Risk(
    val id: Int,
    val attribute: RiskAttribute,
    val guess: String,
    /** The exact draft text that gives it away. */
    val evidence: String,
    val confidence: Confidence,
    /** A validated rewrite, or null (the card offers Keep / Edit only). */
    val suggestion: String?,
)

/** Outcome of the red-team loop. `unavailable` = the check couldn't run (unavailable / refused / unparseable) — forces review. */
data class RedTeamResult(val risks: List<Risk>, val applied: List<Risk>, val draft: SealDraft, val rounds: Int, val unavailable: Boolean)

/** A parsed attacker guess, before filtering. */
data class Guess(val attribute: RiskAttribute, val guess: String, val evidence: String, val confidence: Confidence)

/**
 * Stage 7 — the on-device red-team loop (port of redTeam.ts / RedTeam.swift). Phone-only; a guess is used only if
 * its evidence is in the draft; a suggestion is offered only if it passes validation and keeps exactly the
 * evidence's placeholders. ≤ 6 risks per round, ≤ 2 rounds.
 */
class RedTeam(val phone: PhoneOnlyEngine, val prompts: PromptLibrary, val patterns: PatternDetector) {
    suspend fun run(draft: SealDraft, mode: RedTeamMode, maxRounds: Int, taskSummary: String): RedTeamResult {
        if (mode == RedTeamMode.OFF || maxRounds <= 0) return RedTeamResult(emptyList(), emptyList(), draft, 0, false)
        var current = draft
        val all = ArrayList<Risk>()
        val applied = ArrayList<Risk>()
        var rounds = 0
        for (round in 1..minOf(maxRounds, 2)) {
            rounds = round
            val guesses = attack(current) ?: return RedTeamResult(all.toList(), applied.toList(), current, rounds, true)
            val risky = filterGuesses(guesses, current.text)
            if (risky.isEmpty()) break
            val risks = ArrayList<Risk>()
            for ((i, g) in risky.withIndex()) {
                risks.add(Risk(round * 100 + i, g.attribute, g.guess, g.evidence, g.confidence, suggest(g, current, taskSummary)))
            }
            all.addAll(risks)
            if (mode != RedTeamMode.AUTO_APPLY) break
            val good = risks.filter { it.suggestion != null }
            if (good.isEmpty()) break
            current = applyRisks(good, current)
            applied.addAll(good)
        }
        return RedTeamResult(all.toList(), applied.toList(), current, rounds, false)
    }

    private suspend fun attack(draft: SealDraft): List<Guess>? {
        val output = try {
            phone.respond(PhonePrompt("attack.v1", prompts.render("attack.v1", mapOf("draft" to draft.text))), ANALYSIS_OPTIONS).text
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        val obj = ModelJson.firstObject(output) ?: return null
        val list = obj["guesses"] as? List<*> ?: return null
        val out = ArrayList<Guess>()
        for (raw in list) {
            val d = raw as? Map<*, *> ?: continue
            val attribute = (d["attribute"] as? String)?.lowercase()?.let(RiskAttribute::fromWire) ?: continue
            val evidence = d["evidence"] as? String ?: continue
            val conf = (d["confidence"] as? String)?.lowercase() ?: "low"
            val confidence = if (conf == "high") Confidence.HIGH else if (conf == "medium") Confidence.MEDIUM else Confidence.LOW
            out.add(Guess(attribute, d["guess"] as? String ?: "", evidence, confidence))
        }
        return out
    }

    private suspend fun suggest(g: Guess, draft: SealDraft, taskSummary: String): String? {
        val span = locate(g.evidence, draft.text).firstOrNull() ?: return null
        val sentence = draft.text.substring(maxOf(0, span.start - 120), minOf(draft.text.length, span.end + 120))
        return try {
            val text = prompts.render(
                "gen.v1",
                mapOf("task_summary" to taskSummary, "sentence" to sentence, "phrase" to g.evidence, "type" to g.attribute.wire, "level_hint" to "general, not unique to one person or place"),
            )
            val output = phone.respond(PhonePrompt("gen.v1", text), ANALYSIS_OPTIONS).text
            val json = ModelJson.firstJsonObject(output) ?: return null
            val r = (JsJson.parse(json) as? Map<*, *>)?.get("rewrite") as? String ?: return null
            val rewrite = Js.trim(r)
            if (isValidSuggestion(rewrite, g.evidence, draft.entities, patterns)) rewrite else null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        const val MAX_RISKS_PER_ROUND = 6
        private val TOKEN = Regex("\\[\\[[A-Z]+_(?:[0-9]+|ME)\\]\\]")

        private fun placeholderSpans(text: String): List<TextSpan> = TOKEN.findAll(text).map { TextSpan(it.range.first, it.range.last + 1) }.toList()
        private fun tokensIn(text: String): List<String> = TOKEN.findAll(text).map { it.value }.toList().sorted()
        private fun maskTokens(text: String): String = Js.words(TOKEN.replace(text, " ")).joinToString(" ")
        private fun isWordChar(c: Char?): Boolean = c != null && (Js.isL(c.code) || Js.isN(c.code))

        /** Word-bounded occurrences: exact case first, then case-insensitive. */
        fun locate(needle: String, text: String): List<TextSpan> {
            val n = Js.trim(needle)
            if (n.isEmpty()) return emptyList()
            val lowerText = text.lowercase()
            for (hay in listOf(text, lowerText)) {
                if (hay.length != text.length) continue
                val nn = if (hay == text) n else n.lowercase()
                val found = ArrayList<TextSpan>()
                var from = 0
                while (from < hay.length) {
                    val i = hay.indexOf(nn, from)
                    if (i < 0) break
                    val okStart = FoldedSearch.isBoundary(text, i - 1) || !isWordChar(n.firstOrNull())
                    val okEnd = FoldedSearch.isBoundary(text, i + nn.length) || !isWordChar(n.lastOrNull())
                    if (okStart && okEnd) found.add(TextSpan(i, i + nn.length))
                    from = i + nn.length
                }
                if (found.isNotEmpty()) return found
            }
            return emptyList()
        }

        /** Generaliser rules on the non-placeholder text, plus exact placeholder preservation. */
        fun isValidSuggestion(rewrite: String, evidence: String, entities: EntityMap, patterns: PatternDetector): Boolean {
            if (tokensIn(rewrite) != tokensIn(evidence)) return false
            val r = Js.trim(maskTokens(rewrite))
            if (r.isEmpty()) return false
            return Generaliser.validateRewrite(r, Js.trim(maskTokens(evidence)), entities, patterns)
        }

        /** Deterministic and idempotent; skips evidence it can't find (Review's "Use suggestion" calls it). */
        fun applyRisks(risks: List<Risk>, draft: SealDraft): SealDraft {
            var text = draft.text
            var replacements: List<Replacement> = draft.replacements.toList()
            val edits = ArrayList<Pair<TextSpan, String>>()
            for (risk in risks) {
                val suggestion = risk.suggestion ?: continue
                if (FoldedSearch.contains(FoldedSearch.fold(risk.evidence), FoldedSearch.fold(suggestion))) continue
                val tokenSpans = placeholderSpans(text)
                val candidate = locate(risk.evidence, text).firstOrNull { span ->
                    edits.none { it.first.overlaps(span) } && tokenSpans.none { it.overlaps(span) && !span.contains(it) }
                }
                if (candidate != null) edits.add(candidate to suggestion)
            }
            for ((span, editText) in edits.sortedWith { a, b -> b.first.start - a.first.start }) {
                text = text.substring(0, span.start) + editText + text.substring(span.end)
                val delta = editText.length - (span.end - span.start)
                val next = ArrayList<Replacement>()
                for (r in replacements) {
                    if (r.sealedSpan.end <= span.start) next.add(r)
                    else if (r.sealedSpan.start >= span.end) next.add(r.copy(sealedSpan = TextSpan(r.sealedSpan.start + delta, r.sealedSpan.end + delta)))
                }
                next.add(Replacement(TextSpan(0, 0), TextSpan(span.start, span.start + editText.length), null, ReplacementKind.REDTEAM))
                replacements = next
            }
            replacements = replacements.sortedWith { a, b ->
                if (a.sealedSpan.start != b.sealedSpan.start) a.sealedSpan.start - b.sealedSpan.start else a.sealedSpan.end - b.sealedSpan.end
            }
            return draft.copy(text = text, replacements = replacements)
        }

        /** Keeps medium+ guesses whose evidence really is in the draft (as written there), max 6. */
        fun filterGuesses(guesses: List<Guess>, text: String): List<Guess> {
            val seen = HashSet<String>()
            val kept = ArrayList<Guess>()
            for (g in guesses) {
                if (g.confidence.rank < Confidence.MEDIUM.rank) continue
                if (Js.codePoints(maskTokens(g.evidence)).all { it.length == 1 && Js.isWhitespace(it[0]) || Js.isP(it.codePointAt(0)) }) continue
                val span = locate(g.evidence, text).firstOrNull() ?: continue
                val asWritten = text.substring(span.start, span.end)
                if (!seen.add(asWritten)) continue
                kept.add(g.copy(evidence = asWritten))
            }
            return kept.sortedWith { a, b -> b.confidence.rank - a.confidence.rank }.take(MAX_RISKS_PER_ROUND)
        }
    }
}
