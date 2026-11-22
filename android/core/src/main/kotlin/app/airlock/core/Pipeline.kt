package app.airlock.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/** Settings for one seal (defaults = AppConfig defaults on Android). */
data class SealSettings(
    val dial: DialPreset = DialPreset.BALANCED,
    val policy: PolicySettings = PolicySettings.DEFAULT,
    /** Remote Config `detect_chunk_tokens_android`. */
    val chunkTokens: Int = 700,
    val maxRewrites: Int = 6,
    val taskSummary: String = "getting help with this message",
    val today: Instant = Instant.now(),
    val redTeamEnabled: Boolean = true,
    val redTeamRounds: Int = 2,
    /** `detect.v1` (JSON) or `detect.v2` (one line per detail, model-written "general" phrases, rule hits masked). */
    val detectPromptId: String = LLMDetector.DETECT_V1,
)

/** Why Review is shown. */
sealed interface ReviewReason {
    data class PhoneUnavailable(val availability: PhoneAvailability) : ReviewReason
    data class LlmFailed(val chunks: List<Int>) : ReviewReason
    data class Refused(val chunks: List<Int>) : ReviewReason
    data object LowConfidence : ReviewReason
    data object Ambiguous : ReviewReason
    data object SecretsFound : ReviewReason
    data class Risks(val count: Int) : ReviewReason
    data object RedTeamUnavailable : ReviewReason
}

/** Progress of a seal, for the UI. */
sealed interface SealProgress {
    /** FX-02: Vault and rule hits, before any model call (local only). */
    data class RulesReady(val preview: RulesPreview) : SealProgress
    data class Detecting(val section: Int, val of: Int) : SealProgress
    data object Generalising : SealProgress
    data object CheckingRisks : SealProgress
    data object Done : SealProgress
}

/** Everything the seal produced. On device only; the draft must still pass [EgressGate.seal]. */
data class SealResult(
    val normalised: NormalisedText,
    val merge: MergeResult,
    val draft: SealDraft,
    val reasons: List<ReviewReason>,
    val requiresReview: Boolean,
    val detection: LLMDetectionReport,
    val rewrites: Map<PlaceholderId, String>,
    val sealMs: Double,
    val risks: List<Risk>,
    val acceptedRisks: List<Risk>,
    val redTeamUnavailable: Boolean,
    /** Staged mode: the red-team check is still running; sending must wait. Null outside staged mode. */
    val redTeamPending: Boolean? = null,
    /** Every detection before merging (kept so the user can add their own and re-merge — "Protect this"). */
    val candidates: List<Candidate> = emptyList(),
    /** Where the seal's time went (FX-02); numbers only. */
    val timings: SealTimings = SealTimings(),
) {
    /** Risks not yet accepted. */
    val pendingRisks: List<Risk> get() {
        val accepted = acceptedRisks.mapTo(HashSet()) { it.id }
        return risks.filter { it.id !in accepted }
    }

    override fun toString(): String = "SealResult(${draft.text.length} chars, review=$requiresReview)"
}

/** `runStaged` output: the result now, and (Balanced only) the full result with risk cards later. */
data class StagedSeal(val result: SealResult, val later: Deferred<SealResult>?)

/**
 * Stages 1–7: raw text → sealed draft, entirely on the device (port of pipeline.ts / SealPipeline.swift).
 * Holds only a [PhoneOnlyEngine], so there is no cloud engine to call (INV-1, INV-3). INV-9: if the on-device model
 * is unavailable or fails, detection falls back to Vault + patterns and Review is forced.
 */
class SealPipeline(
    private val phone: PhoneOnlyEngine,
    private val patterns: PatternDetector,
    private val vault: List<VaultEntry>,
    private val prompts: PromptLibrary,
    private val settings: SealSettings,
) {
    private fun now(): Double = System.nanoTime() / 1e6

    private suspend fun prepare(
        raw: String,
        existing: EntityMap,
        overrides: Map<PlaceholderId, UserOverride>,
        progress: (SealProgress) -> Unit,
        staged: CoroutineScope?,
    ): StagedSeal {
        val t0 = now()
        val meter = CallMeter(phone, t0, ::now)
        var timings = SealTimings()
        val normalised = Normaliser.normalise(raw.substring(0, minOf(raw.length, Normaliser.MAX_INPUT_UTF16)))
        val text = normalised.text
        val candidates = ArrayList<Candidate>()
        candidates.addAll(VaultMatcher(vault).detect(text))
        candidates.addAll(patterns.detect(text))
        val tRules = now()
        timings = timings.copy(rulesMs = tRules - t0)
        progress(SealProgress.RulesReady(RulesPreview.of(text, candidates)))
        val report = LLMDetector(meter, prompts, settings.chunkTokens, settings.detectPromptId, candidates.toList()).detect(text) { section, of -> progress(SealProgress.Detecting(section, of)) }
        timings = timings.copy(detectMs = now() - tRules, detectCalls = meter.calls("detect"), repairCalls = meter.calls("detect-repair"))
        candidates.addAll(report.candidates)

        val m = Merger.merge(candidates, text, existing, vault)
        val policy = PolicyEngine(settings.dial, settings.policy)

        val rewrites = LinkedHashMap<PlaceholderId, String>()
        if (report.unavailable == null) {
            val ids = m.mentions.mapTo(LinkedHashSet()) { it.entityId }.sortedWith(Placeholders.ORDER)
            val targets = ids.mapNotNull { m.entities[it] }.filter { policy.action(it, overrides[it.id]) is Action.Generalise }.take(settings.maxRewrites)
            if (targets.isNotEmpty()) progress(SealProgress.Generalising)
            val tGen = now()
            val callsBefore = meter.calls()
            for (e in targets) {
                val action = policy.action(e, overrides[e.id])
                val mention = m.mentions.firstOrNull { it.entityId == e.id }
                if (action !is Action.Generalise || mention == null) continue
                // detect.v2 already asked the model for a short phrase: use it if it fits the sentence, else the Sealer falls back
                // to the fixed phrase. gen.v1 is only for details the model gave none for (Vault and rule hits, or a v1 reply).
                val given = modelGeneral(report, e)
                if (given != null) {
                    if (Generaliser.plausibleGeneral(given, mention.text)) rewrites[e.id] = Js.trim(given)
                    continue
                }
                val r = rewrite(meter, e, mention, action.level, text)
                if (!r.isNullOrEmpty()) rewrites[e.id] = r
            }
            timings = timings.copy(generaliseMs = now() - tGen, generaliseCalls = meter.calls() - callsBefore)
        }

        var draft = Sealer(policy, patterns, settings.today).draft(normalised, m, overrides, rewrites)
        var risks: List<Risk> = emptyList()
        var accepted: List<Risk> = emptyList()
        var redTeamUnavailable = false
        val allCandidates: List<Candidate> = candidates.toList()
        fun base(): SealResult {
            val sealMs = now() - t0
            return SealResult(
                normalised, m, draft, emptyList(), false, report, rewrites, sealMs, risks, accepted, redTeamUnavailable, candidates = allCandidates,
                timings = timings.copy(firstModelOutputMs = meter.firstModelOutputMs, totalMs = sealMs),
            )
        }
        if (settings.redTeamEnabled && policy.redTeamMode != RedTeamMode.OFF) {
            if (report.unavailable != null) redTeamUnavailable = true
            else if (staged != null && policy.redTeamMode == RedTeamMode.SUGGEST) {
                // Suggestions don't change the draft, so the user can start reviewing now; risk cards arrive later.
                val early = base().copy(redTeamPending = true)
                progress(SealProgress.CheckingRisks)
                val tRed = now()
                val callsBefore = meter.calls()
                val later = staged.async {
                    val rt = RedTeam(meter, prompts, patterns).run(draft, RedTeamMode.SUGGEST, settings.redTeamRounds, settings.taskSummary)
                    finalise(
                        early.copy(
                            redTeamPending = false, risks = rt.risks, redTeamUnavailable = rt.unavailable, sealMs = now() - t0,
                            timings = early.timings.copy(redTeamMs = now() - tRed, redTeamCalls = meter.calls() - callsBefore),
                        ),
                        policy.reviewMode,
                    )
                }
                return StagedSeal(finalise(early, policy.reviewMode), later)
            } else {
                progress(SealProgress.CheckingRisks)
                val tRed = now()
                val callsBefore = meter.calls()
                val rt = RedTeam(meter, prompts, patterns).run(draft, policy.redTeamMode, settings.redTeamRounds, settings.taskSummary)
                timings = timings.copy(redTeamMs = now() - tRed, redTeamCalls = meter.calls() - callsBefore)
                risks = rt.risks
                accepted = rt.applied
                draft = rt.draft
                redTeamUnavailable = rt.unavailable
            }
        }
        val result = finalise(base(), policy.reviewMode)
        progress(SealProgress.Done)
        return StagedSeal(result, null)
    }

    /** The model's own general phrase for this entity (any of its surface forms), or null if it gave none. */
    private fun modelGeneral(report: LLMDetectionReport, e: Entity): String? {
        for (form in listOf(e.canonical) + e.surfaceForms) report.generals[LLMDetector.generalKey(e.category, form)]?.let { return it }
        return null
    }

    suspend fun run(
        raw: String,
        existing: EntityMap = EntityMap(),
        overrides: Map<PlaceholderId, UserOverride> = emptyMap(),
        progress: (SealProgress) -> Unit = {},
    ): SealResult = prepare(raw, existing, overrides, progress, null).result

    /**
     * Like [run], but when the red team only *suggests* (Balanced), returns the draft as soon as it is sealed
     * (`redTeamPending = true`) and the full result — with risk cards — via `later`, launched in `scope`. Strict
     * still waits, because there the red team rewrites the draft itself. Nothing may be sent while
     * `redTeamPending` is true.
     */
    suspend fun runStaged(
        scope: CoroutineScope,
        raw: String,
        existing: EntityMap = EntityMap(),
        overrides: Map<PlaceholderId, UserOverride> = emptyMap(),
        progress: (SealProgress) -> Unit = {},
    ): StagedSeal = prepare(raw, existing, overrides, progress, scope)

    /** [protect] output: the resealed result and the overrides that now include the user's marks. */
    data class Protected(val result: SealResult, val overrides: Map<PlaceholderId, UserOverride>)

    /**
     * "Protect this": the user marks a phrase the detectors missed (essential when the on-device model is
     * unavailable — INV-9). Every word-bounded occurrence becomes a `user` detection (highest merge priority),
     * then we re-merge with the current entities as `existing`, so every placeholder keeps its number and the
     * user's earlier toggles still point at the same details. No model call. Returns the same [result] instance
     * (and [overrides]) when the phrase is blank or not in the text. [PrivacyCategory.QUASI] is not markable.
     */
    fun protect(
        result: SealResult,
        phrase: String,
        category: PrivacyCategory,
        overrides: Map<PlaceholderId, UserOverride>,
        acceptedRisks: List<Risk> = result.acceptedRisks,
    ): Protected {
        require(category != PrivacyCategory.QUASI) { "quasi is not a markable category" }
        val text = result.normalised.text
        val needle = Js.trim(phrase)
        val spans = if (needle.isNotEmpty()) FoldedSearch.ranges(needle, text) else emptyList()
        if (spans.isEmpty()) return Protected(result, overrides)
        val added = spans.map { Candidate(it, text.substring(it.start, it.end), category, detector = DetectorId.USER, confidence = Confidence.HIGH) }
        val candidates = result.candidates + added
        val m = Merger.merge(candidates, text, result.merge.entities.clone(), vault)
        // What the user marked becomes a placeholder (restorable in the answer), not a generalisation.
        val next = LinkedHashMap(overrides)
        for (mention in m.mentions) {
            if (added.any { it.span.start == mention.span.start && it.span.end == mention.span.end } && !next.containsKey(mention.entityId)) {
                next[mention.entityId] = UserOverride(Action.Placeholder, revealThisTime = false)
            }
        }
        return Protected(reseal(result.copy(merge = m, candidates = candidates), next, acceptedRisks), next)
    }

    /** Re-applies Review edits without calling the model (chip toggles and "Use suggestion" are instant). */
    fun reseal(result: SealResult, overrides: Map<PlaceholderId, UserOverride>, acceptedRisks: List<Risk> = result.acceptedRisks): SealResult {
        val policy = PolicyEngine(settings.dial, settings.policy)
        val base = Sealer(policy, patterns, settings.today).draft(result.normalised, result.merge, overrides, result.rewrites)
        return finalise(result.copy(draft = RedTeam.applyRisks(acceptedRisks, base), acceptedRisks = acceptedRisks), policy.reviewMode)
    }

    private suspend fun rewrite(phone: PhoneOnlyEngine, e: Entity, mention: Mention, level: Int, text: String): String? {
        val sentence = text.substring(maxOf(0, mention.span.start - 120), minOf(text.length, mention.span.end + 120))
        val hint = when (level) {
            1 -> "slightly less specific"
            2 -> "a general kind, no name (e.g. \"a large hospital\")"
            else -> "very general (e.g. \"a healthcare employer\")"
        }
        return try {
            val prompt = prompts.render("gen.v1", mapOf("task_summary" to settings.taskSummary, "sentence" to sentence, "phrase" to mention.text, "type" to e.category.wire, "level_hint" to hint))
            val out = phone.respond(PhonePrompt("gen.v1", prompt), ANALYSIS_OPTIONS).text
            val json = ModelJson.firstJsonObject(out)
            val r = if (json != null) (JsJson.parse(json) as? Map<*, *>)?.get("rewrite") else null
            (r as? String)?.let(Js::trim)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    companion object {
        internal fun finalise(r: SealResult, mode: ReviewMode): SealResult {
            val reasons = ArrayList<ReviewReason>()
            r.detection.unavailable?.let { reasons.add(ReviewReason.PhoneUnavailable(it)) }
            if (r.detection.failedChunks.isNotEmpty()) reasons.add(ReviewReason.LlmFailed(r.detection.failedChunks))
            if (r.detection.refusedChunks.isNotEmpty()) reasons.add(ReviewReason.Refused(r.detection.refusedChunks))
            val present = r.merge.mentions.mapTo(LinkedHashSet()) { it.entityId }
            val lowConfidenceSealed = present.any { id ->
                val e = r.draft.entities[id]
                e != null && e.action != Action.Keep && e.confidence.rank < Confidence.HIGH.rank
            }
            if (lowConfidenceSealed) reasons.add(ReviewReason.LowConfidence)
            if (r.merge.ambiguous.isNotEmpty()) reasons.add(ReviewReason.Ambiguous)
            if (r.draft.secretWarnings.isNotEmpty()) reasons.add(ReviewReason.SecretsFound)
            val pending = r.pendingRisks
            if (pending.isNotEmpty()) reasons.add(ReviewReason.Risks(pending.size))
            if (r.redTeamUnavailable && r.detection.unavailable == null) reasons.add(ReviewReason.RedTeamUnavailable)
            val forced = reasons.any { it != ReviewReason.LowConfidence }
            val requiresReview = when (mode) {
                ReviewMode.ALWAYS -> true
                ReviewMode.IF_LOW_CONFIDENCE_OR_RISK -> forced || reasons.any { it == ReviewReason.LowConfidence }
                ReviewMode.ONLY_IF_RISK -> forced
            }
            return r.copy(reasons = reasons, requiresReview = requiresReview)
        }
    }
}
