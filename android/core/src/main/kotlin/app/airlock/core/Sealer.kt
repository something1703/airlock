package app.airlock.core

import java.time.Instant

/** What kind of change the sealer (or red team) made. */
enum class ReplacementKind(val wire: String) { PLACEHOLDER("placeholder"), GENERALISED("generalised"), BLOCKED("blocked"), BUCKETED("bucketed"), REDTEAM("redteam") }

/** One change the sealer made. */
data class Replacement(
    /** Where the original text was, in the normalised input. */
    val normalisedSpan: TextSpan,
    /** Where the replacement sits in the draft. */
    val sealedSpan: TextSpan,
    val entityId: PlaceholderId?,
    val kind: ReplacementKind,
)

/** A sealed draft, before the egress gate. Lives only on device; never sent as-is (only [EgressGate.seal] output leaves). */
data class SealDraft(
    val text: String,
    val legend: List<LegendLine>,
    val replacements: List<Replacement>,
    /** Entities with their final actions and generalised phrases. */
    val entities: EntityMap,
    /** Secrets that were removed — the UI warns "Never share these". */
    val secretWarnings: List<PlaceholderId>,
    /** Vault entries the user chose to reveal this time (gate check G1 skips these). */
    val revealedVaultIds: Set<String>,
    /** Folded values the user explicitly chose to keep (gate check G3 allows these). */
    val keptValues: Set<String>,
) {
    override fun toString(): String = "SealDraft(${text.length} chars, ${legend.size} legend lines)"
}

/**
 * Stage 6 — build the sealed draft and its legend (port of sealer.ts / Sealer.swift).
 * Every mention whose entity isn't `keep` is replaced (placeholder/block → `[[ID]]`, generalise → a validated
 * phrase); Strict also buckets money. The legend has one line per placeholder present, sorted by id; `PERSON_ME`
 * is "the user"; legend lines never contain surface forms or pattern hits.
 */
class Sealer(val policy: PolicyEngine, val patterns: PatternDetector, val today: Instant = Instant.now()) {
    private class Edit(val span: TextSpan, val replacement: String, val id: PlaceholderId?, val kind: ReplacementKind)

    fun draft(
        text: NormalisedText,
        mergeResult: MergeResult,
        overrides: Map<PlaceholderId, UserOverride> = emptyMap(),
        rewrites: Map<PlaceholderId, String> = emptyMap(),
    ): SealDraft {
        val map = mergeResult.entities.clone()
        val present = mergeResult.mentions.mapTo(LinkedHashSet()) { it.entityId }
        val revealed = LinkedHashSet<String>()
        val kept = LinkedHashSet<String>()

        for (id in present) {
            var e = map[id] ?: continue
            val override = overrides[id]
            e = e.copy(action = policy.action(e, override))
            // The TypeScript mutates the entity inside the map, so validation below already sees the new action.
            map.upsert(e)
            val action = e.action
            if (action is Action.Generalise) {
                val r = rewrites[id]
                e = e.copy(generalisedText = if (r != null && Generaliser.validateRewrite(r, e.canonical, map, patterns)) r else Generaliser.ladderDefault(e, action.level, today))
            }
            if (e.action == Action.Keep && override != null) {
                for (f in e.surfaceForms) kept.add(FoldedSearch.fold(f))
                e.vaultEntryId?.let { if (override.revealThisTime) revealed.add(it) }
            }
            map.upsert(e)
        }

        val edits = ArrayList<Edit>()
        for (m in mergeResult.mentions) {
            val e = map[m.entityId] ?: continue
            when (e.action) {
                Action.Keep -> {}
                Action.Placeholder -> edits.add(Edit(m.span, Placeholders.token(e.id), e.id, ReplacementKind.PLACEHOLDER))
                Action.Block -> edits.add(Edit(m.span, Placeholders.token(e.id), e.id, ReplacementKind.BLOCKED))
                is Action.Generalise -> edits.add(Edit(m.span, e.generalisedText ?: "something", e.id, ReplacementKind.GENERALISED))
            }
        }
        if (policy.bucketsMoney) {
            for (hit in Money.findMoney(text.text)) {
                if (edits.none { it.span.overlaps(hit.span) }) edits.add(Edit(hit.span, hit.bucket, null, ReplacementKind.BUCKETED))
            }
        }
        edits.sortWith { a, b -> if (a.span.start != b.span.start) a.span.start - b.span.start else a.span.end - b.span.end }

        val out = StringBuilder(text.text.length)
        var cursor = 0
        val replacements = ArrayList<Replacement>()
        for (edit in edits) {
            if (edit.span.start < cursor) continue
            out.append(text.text, cursor, edit.span.start)
            val start = out.length
            out.append(edit.replacement)
            replacements.add(Replacement(edit.span, TextSpan(start, out.length), edit.id, edit.kind))
            cursor = edit.span.end
        }
        out.append(text.text, cursor, text.text.length)

        val placeholderIds = replacements
            .filter { (it.kind == ReplacementKind.PLACEHOLDER || it.kind == ReplacementKind.BLOCKED) && !it.entityId.isNullOrEmpty() }
            .mapNotNullTo(LinkedHashSet()) { it.entityId }
            .sortedWith(Placeholders.ORDER)
        val legend = ArrayList<LegendLine>()
        for (id in placeholderIds) {
            val e = map[id] ?: continue
            legend.add(LegendLine(id, legendDescription(e, map)))
        }
        val secretWarnings = placeholderIds.filter { map[it]?.action == Action.Block }
        return SealDraft(out.toString(), legend, replacements, map, secretWarnings, revealed, kept)
    }

    fun legendDescription(e: Entity, map: EntityMap): String {
        if (Placeholders.isMe(e.id)) return "the user"
        if (e.category == PrivacyCategory.SECRET) return "a secret the user should not share"
        if (!e.roleHint.isNullOrEmpty()) {
            val hint = rewriteRole(e.roleHint)
            if (passesMiniGate(hint, map)) return hint
        }
        return GENERIC.getValue(e.category)
    }

    /** A role hint is only used if it names nobody and matches no pattern. */
    fun passesMiniGate(hint: String, map: EntityMap): Boolean {
        if (hint.isEmpty() || Js.splitWhitespace(hint).size > 12 || hint.contains("[[")) return false
        for (e in map.sorted()) {
            for (form in e.surfaceForms) if (form.length >= 2 && FoldedSearch.contains(form, hint)) return false
        }
        return patterns.detect(hint).none { it.category != PrivacyCategory.DATE }
    }

    companion object {
        private val GENERIC = mapOf(
            PrivacyCategory.PERSON to "a person mentioned in the message",
            PrivacyCategory.ORG to "an organisation mentioned in the message",
            PrivacyCategory.LOCATION to "a place mentioned in the message",
            PrivacyCategory.CONTACT to "contact details",
            PrivacyCategory.ID to "an ID or reference number",
            PrivacyCategory.DATE to "a date",
            PrivacyCategory.HEALTH to "a health detail",
            PrivacyCategory.SECRET to "a secret the user should not share",
            PrivacyCategory.QUASI to "a detail",
        )

        private val THE_WRITER = Regex("the writer", RegexOption.IGNORE_CASE)

        /** "the writer's landlord" → "the user's landlord"; "my landlord" → "the user's landlord"; "me" → "the user". */
        fun rewriteRole(raw: String): String {
            var s = Js.trimWhere(raw) { Js.isWhitespace(it) || it == '.'.code }
            val lower = s.lowercase()
            if (lower in setOf("me", "myself", "self", "the writer", "writer", "i", "the user")) return "the user"
            for ((prefix, replacement) in listOf("the writer's " to "the user's ", "the writer’s " to "the user's ", "writer's " to "the user's ", "my " to "the user's ")) {
                if (lower.startsWith(prefix)) return replacement + s.substring(minOf(prefix.length, s.length))
            }
            s = THE_WRITER.replace(s, "the user")
            val articles = listOf("the ", "a ", "an ", "someone", "their ")
            if (articles.none { s.lowercase().startsWith(it) }) s = "the user's $s"
            return s
        }
    }
}
