package app.airlock.core

/** Max UTF-16 length of text + legend (matches the Firestore `looksSealed` rule). */
data class GateLimits(val maxUtf16: Int = 40_000) {
    companion object {
        val DEFAULT = GateLimits()
    }
}

/** Where to highlight. Carries **no** matched values (INV-8). */
data class GateHit(
    val check: GateCheckId,
    val category: PrivacyCategory?,
    /** Span in the draft text, or in the legend line's description when `legendIndex` is set. */
    val span: TextSpan?,
    val legendIndex: Int?,
)

/** Thrown when any check fails. The message names checks only — never content. */
class GateBlocked(val hits: List<GateHit>) : Exception("Egress gate blocked: ${hits.map { it.check }.toSortedSet().joinToString(", ")}") {
    val checks: Set<GateCheckId> get() = hits.mapTo(LinkedHashSet()) { it.check }
}

/** SHA-256 as lowercase hex over the string's UTF-8 bytes (lone surrogates → U+FFFD, like `TextEncoder`). */
fun sha256Hex(s: String): String =
    java.security.MessageDigest.getInstance("SHA-256").digest(Js.utf8(s)).joinToString("") { String.format("%02x", it.toInt() and 0xff) }

/**
 * Stage 9 — the egress gate (port of gate.ts / EgressGate.swift). **The only creator of [GateToken] and
 * [SealedText]** (INV-2; `SealedTextConstructionTest` enforces it). Deterministic; all of G1–G7 must pass or
 * nothing is produced: G6 normal form + no mixed-script words · G1 no Vault name/alias (unless revealed) ·
 * G2 no entity surface form, partial name or distinctive word · G3 no contact/ID/secret/address pattern (unless
 * kept) · G4 every placeholder canonical and explained · G5 legend lines clean · G7 size. G1/G2/G5 also run on
 * the homoglyph skeleton. The same checks run on tool results (INV-5).
 */
class EgressGate(
    val patterns: PatternDetector,
    val vault: List<VaultEntry>,
    val limits: GateLimits = GateLimits.DEFAULT,
    /** Lets a DEBUG build skip checks to demo Model Armor. Never true in production. */
    val allowDebugBypass: Boolean = false,
) {
    fun seal(draft: SealDraft): SealedText {
        val hits = runChecks(draft.text, draft.legend, draft.entities, draft.revealedVaultIds, draft.keptValues, true)
        if (hits.isNotEmpty()) throw GateBlocked(hits)
        return make(draft.text, draft.legend, draft.replacements, false)
    }

    /** Seals a tool result before it goes back to the cloud model (INV-5). Placeholders must belong to the thread. */
    fun sealToolResult(text: String, entities: EntityMap): SealedText {
        val hits = runChecks(text, emptyList(), entities, emptySet(), emptySet(), false)
        if (hits.isNotEmpty()) throw GateBlocked(hits)
        return make(text, emptyList(), emptyList(), false)
    }

    /** DEBUG only: skips every check; the report says `bypassed = true` and the UI shows a red banner. */
    fun sealBypassingChecks(draft: SealDraft): SealedText {
        check(allowDebugBypass) { "gate bypass is disabled outside DEBUG builds" }
        return make(draft.text, draft.legend, draft.replacements, true)
    }

    private fun runChecks(text: String, legend: List<LegendLine>, entities: EntityMap, revealed: Set<String>, kept: Set<String>, requireLegend: Boolean): List<GateHit> {
        val hits = ArrayList<GateHit>()
        val descriptions = legend.map { it.description }
        fun hit(check: GateCheckId, category: PrivacyCategory?, span: TextSpan?, legendIndex: Int?) {
            hits.add(GateHit(check, category, span, legendIndex))
        }

        // G6 — normal form and mixed scripts.
        if (!Normaliser.isNormalised(text)) hit(GateCheckId.G6, null, null, null)
        for (w in Homoglyphs.mixedScriptWords(text)) hit(GateCheckId.G6, null, w, null)
        descriptions.forEachIndexed { i, d ->
            if (!Normaliser.isNormalised(d) || Homoglyphs.mixedScriptWords(d).isNotEmpty()) hit(GateCheckId.G6, null, null, i)
        }

        val terms = protectedTerms(entities, revealed)
        val masked = maskPlaceholders(text)

        // G1 / G2 — on the text and its homoglyph skeleton.
        hits.addAll(termHits(masked, terms, null))

        // G3 — patterns.
        for (p in patterns.detect(masked)) {
            if (blocksPattern(p) && FoldedSearch.fold(p.text) !in kept) hit(GateCheckId.G3, p.category, p.span, null)
        }

        // G4 — placeholders canonical and explained.
        val legendIds = legend.mapTo(LinkedHashSet()) { it.placeholder }
        val known = LinkedHashSet(legendIds).apply { addAll(entities.keys()) }
        val tokens = PlaceholderParser(known).tokens(text)
        for (t in tokens) {
            val explained = if (requireLegend) t.id in legendIds else entities.has(t.id)
            if (!t.isCanonical || !explained) hit(GateCheckId.G4, null, t.span, null)
        }
        if (requireLegend) {
            val used = tokens.mapTo(HashSet()) { it.id }
            legend.forEachIndexed { i, l -> if (l.placeholder !in used) hit(GateCheckId.G4, null, null, i) }
        }

        // G5 — legend lines.
        descriptions.forEachIndexed { i, d ->
            for (h in termHits(d, terms, i)) hit(GateCheckId.G5, h.category, h.span, i)
            if (d.contains("[[") || patterns.detect(d).any { it.category != PrivacyCategory.DATE }) hit(GateCheckId.G5, null, null, i)
        }

        // G7 — size.
        if (outboundOf(text, legend).length > limits.maxUtf16) hit(GateCheckId.G7, null, null, null)
        return hits
    }

    private fun protectedTerms(entities: EntityMap, revealed: Set<String>): List<Term> {
        val terms = ArrayList<Term>()
        for (entry in vault) {
            if (entry.id in revealed) continue
            for (t in entry.allTerms()) if (t.length >= 2) terms.add(Term(t, TermCheck.G1, entry.category, false))
        }
        for (e in entities.sorted()) {
            if (!e.action.mustNotEgress) continue
            if (e.vaultEntryId != null && e.vaultEntryId in revealed) continue
            terms.addAll(Terms.entityTerms(e))
        }
        return terms
    }

    private fun make(text: String, legend: List<LegendLine>, replacements: List<Replacement>, bypassed: Boolean): SealedText {
        val counts = LinkedHashMap<String, Int>()
        for (l in legend) {
            val cat = categoryOfId(l.placeholder)
            counts[cat] = (counts[cat] ?: 0) + 1
        }
        counts["generalised"] = replacements.filter { it.kind == ReplacementKind.GENERALISED && !it.entityId.isNullOrEmpty() }.mapTo(HashSet()) { it.entityId }.size
        counts["bucketed"] = replacements.count { it.kind == ReplacementKind.BUCKETED }
        counts["redteamApplied"] = replacements.count { it.kind == ReplacementKind.REDTEAM }
        val frozenLegend = java.util.Collections.unmodifiableList(ArrayList(legend))
        val report = GateReport(
            checksPassed = if (bypassed) emptyList() else GateCheckId.entries.toList(),
            counts = java.util.Collections.unmodifiableMap(counts),
            outboundSha256 = sha256Hex(outboundOf(text, legend)),
            bypassed = bypassed,
        )
        return SealedText(GateToken(), text, frozenLegend, report)
    }

    companion object {
        private val CANONICAL_TOKEN = Regex("\\[\\[[A-Z]+_(?:[0-9]+|ME)\\]\\]")

        private fun outboundOf(text: String, legend: List<LegendLine>): String =
            if (legend.isEmpty()) text else text + "\n\n" + legend.joinToString("\n") { it.rendered() }

        /** Canonical placeholder tokens replaced by spaces of equal length, so term/pattern searches never match inside our own tokens. */
        private fun maskPlaceholders(text: String): String = CANONICAL_TOKEN.replace(text) { " ".repeat(it.value.length) }

        private fun blocksPattern(c: Candidate): Boolean = when (c.category) {
            PrivacyCategory.CONTACT, PrivacyCategory.ID, PrivacyCategory.SECRET -> true
            PrivacyCategory.LOCATION -> c.subtype != null && c.subtype in PolicyEngine.ADDRESS_SUBTYPES
            else -> false
        }

        private fun categoryOfId(id: String): String = when (id.split("_")[0]) {
            "PERSON" -> "person"; "ORG" -> "org"; "LOC" -> "location"; "CONTACT" -> "contact"; "ID" -> "id"
            "DATE" -> "date"; "HEALTH" -> "health"; "SECRET" -> "secret"
            else -> "person"
        }

        /** Hits of every term on the text and (if different) its homoglyph skeleton; a span is reported once. */
        private fun termHits(text: String, terms: List<Term>, legendIndex: Int?): List<GateHit> {
            val sk = Homoglyphs.skeleton(text)
            val haystacks = (if (sk == text) listOf(text) else listOf(text, sk)).map { FoldedSearch.Haystack(it) }
            val hits = ArrayList<GateHit>()
            val seen = HashSet<TextSpan>()
            for (term in terms) {
                for (hay in haystacks) {
                    for (span in FoldedSearch.ranges(term.text, hay, term.caseSensitive)) {
                        if (!seen.add(span)) continue
                        hits.add(GateHit(if (term.check == TermCheck.G1) GateCheckId.G1 else GateCheckId.G2, term.category, span, legendIndex))
                    }
                }
            }
            return hits
        }
    }
}
