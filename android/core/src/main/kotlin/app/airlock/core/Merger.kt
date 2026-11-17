package app.airlock.core

/** One occurrence of an entity in the normalised text. */
data class Mention(val span: TextSpan, val entityId: PlaceholderId, val text: String)

/** Two entities the merger couldn't tell apart ("Sam" vs "Sam Lee" / "Sam Ortiz"). */
data class Ambiguity(val entity: PlaceholderId, val possiblySameAs: PlaceholderId)

/** Output of [Merger.merge]: the thread's entity map (existing entities kept), sorted mentions, ambiguities. */
data class MergeResult(val entities: EntityMap, val mentions: List<Mention>, val ambiguous: List<Ambiguity>)

/**
 * Stage 4 — merge overlapping detections and cluster mentions into entities (port of merger.ts / Merger.swift).
 * Higher-priority detector wins an overlap (user > vault > pattern > llm > nl), then the longer span, then the
 * category order. A losing span that contains a single same-category winner makes the winner grow (so "Raj"
 * inside "Raj Patel" seals the whole name); every loser's text becomes a surface form.
 */
object Merger {
    private class Accepted(
        var span: TextSpan,
        var text: String,
        val category: PrivacyCategory,
        val subtype: String?,
        val detector: DetectorId,
        var confidence: Confidence,
        val roleHint: String?,
        val sameAs: String?,
        val vaultEntryId: String?,
        val extraForms: LinkedHashSet<String>,
    ) {
        fun withConfidence(c: Confidence) = Accepted(span, text, category, subtype, detector, c, roleHint, sameAs, vaultEntryId, extraForms)
    }

    private class Cluster(
        val category: PrivacyCategory,
        val keys: LinkedHashSet<String>,
        val tokens: LinkedHashSet<String>,
        val mentions: MutableList<Accepted>,
        val vaultEntryId: String?,
        val ambiguousWith: List<Int>,
    )

    private val TITLES = setOf("dr", "mr", "mrs", "ms", "mx", "miss", "prof", "sir", "madam", "dame")
    private val NAME_CATEGORIES = setOf(PrivacyCategory.PERSON, PrivacyCategory.ORG)

    fun merge(candidates: List<Candidate>, text: String, existing: EntityMap = EntityMap(), vault: List<VaultEntry> = emptyList()): MergeResult {
        val accepted = resolveOverlaps(candidates.filter { it.category != PrivacyCategory.QUASI }, text)
        return assignIds(cluster(accepted, vault), existing, vault)
    }

    private fun resolveOverlaps(candidates: List<Candidate>, text: String): List<Accepted> {
        val ordered = candidates.sortedWith { a, b ->
            when {
                a.detector.priority != b.detector.priority -> a.detector.priority - b.detector.priority
                a.span.length != b.span.length -> b.span.length - a.span.length
                a.category.priority != b.category.priority -> a.category.priority - b.category.priority
                else -> a.span.compareTo(b.span)
            }
        }
        val kept = ArrayList<Accepted>()
        for (c in ordered) {
            val overlapping = kept.indices.filter { kept[it].span.overlaps(c.span) }
            if (overlapping.isEmpty()) {
                kept.add(Accepted(c.span, c.text, c.category, c.subtype, c.detector, c.confidence, c.roleHint, c.sameAs, c.vaultEntryId, LinkedHashSet()))
                continue
            }
            val only = if (overlapping.size == 1) kept[overlapping[0]] else null
            if (only != null && only.category == c.category && c.span.contains(only.span) && c.span != only.span) {
                val grown = text.substringOf(c.span)
                if (grown != null) {
                    only.extraForms.add(only.text)
                    only.extraForms.add(c.text)
                    only.span = c.span
                    only.text = grown
                    only.confidence = Confidence.max(only.confidence, c.confidence)
                    continue
                }
            }
            val same = overlapping.firstOrNull { kept[it].category == c.category }
            if (same != null) kept[same].extraForms.add(c.text)
        }
        return kept.sortedWith { a, b -> a.span.compareTo(b.span) }
    }

    private fun stripPossessive(s: String): String {
        for (suffix in listOf("'s", "’s")) if (s.endsWith(suffix) && Js.codePointLength(s) > 3) return s.substring(0, s.length - 2)
        return s
    }

    /** Comparison key: folded, possessive and titles stripped; IDs and phones compare without separators. */
    private fun key(text: String, category: PrivacyCategory): String {
        var s = Js.trimWhere(FoldedSearch.fold(text)) { Js.isWhitespace(it) || Js.isP(it) }
        for (suffix in listOf("'s", "s'")) {
            if (s.endsWith(suffix) && Js.codePointLength(s) > suffix.length + 1) {
                s = s.substring(0, s.length - (if (suffix == "'s") 2 else 1))
            }
        }
        return when (category) {
            PrivacyCategory.PERSON, PrivacyCategory.ORG, PrivacyCategory.LOCATION, PrivacyCategory.HEALTH, PrivacyCategory.QUASI -> {
                val words = Js.splitWhitespace(s).filter { it.isNotEmpty() }.map { w -> w.trimStart('.', ',').trimEnd('.', ',') }.toMutableList()
                if (category == PrivacyCategory.PERSON) while (words.size > 1 && words[0] in TITLES) words.removeAt(0)
                words.joinToString(" ")
            }
            PrivacyCategory.ID, PrivacyCategory.CONTACT, PrivacyCategory.SECRET -> {
                if (s.contains("@") || s.contains("/")) s
                else Js.codePoints(s).filter { !(it.length == 1 && (Js.isWhitespace(it[0]) || it[0] in "-().")) }.joinToString("")
            }
            PrivacyCategory.DATE -> s
        }
    }

    private fun tokensOf(k: String): LinkedHashSet<String> = k.split(" ").filterTo(LinkedHashSet()) { Js.codePointLength(it) >= 2 && it !in TITLES }

    private fun cluster(accepted: List<Accepted>, vault: List<VaultEntry>): List<Cluster> {
        val clusters = ArrayList<Cluster>()
        val order = accepted.indices.sortedWith { x, y ->
            val a = tokensOf(key(accepted[x].text, accepted[x].category)).size
            val b = tokensOf(key(accepted[y].text, accepted[y].category)).size
            if (a != b) b - a else accepted[x].span.compareTo(accepted[y].span)
        }
        for (i in order) {
            val m = accepted[i]
            val k = key(m.text, m.category)
            val t = tokensOf(k)

            if (!m.vaultEntryId.isNullOrEmpty()) {
                val c = clusters.firstOrNull { it.vaultEntryId == m.vaultEntryId }
                if (c != null) {
                    c.mentions.add(m)
                    c.keys.add(k)
                } else {
                    val keys = linkedSetOf(k)
                    val toks = LinkedHashSet(t)
                    val entry = vault.firstOrNull { it.id == m.vaultEntryId }
                    if (entry != null) {
                        for (term in entry.allTerms()) {
                            val tk = key(term, m.category)
                            keys.add(tk)
                            toks.addAll(tokensOf(tk))
                        }
                    }
                    clusters.add(Cluster(m.category, keys, toks, mutableListOf(m), m.vaultEntryId, emptyList()))
                }
                continue
            }
            val exact = clusters.firstOrNull { it.category == m.category && k in it.keys }
            if (exact != null) {
                exact.mentions.add(m)
                continue
            }
            if (!m.sameAs.isNullOrEmpty()) {
                val sk = key(m.sameAs, m.category)
                val c = clusters.firstOrNull { it.category == m.category && sk in it.keys }
                if (c != null) {
                    c.mentions.add(m)
                    c.keys.add(k)
                    c.tokens.addAll(t)
                    continue
                }
            }
            if (m.category in NAME_CATEGORIES && t.isNotEmpty()) {
                val supersets = clusters.indices.filter { clusters[it].category == m.category && clusters[it].tokens.containsAll(t) }
                if (supersets.size == 1) {
                    val c = clusters[supersets[0]]
                    c.mentions.add(m)
                    c.keys.add(k)
                    continue
                }
                if (supersets.size > 1) {
                    clusters.add(Cluster(m.category, linkedSetOf(k), t, mutableListOf(m.withConfidence(Confidence.MEDIUM)), null, supersets))
                    continue
                }
            }
            clusters.add(Cluster(m.category, linkedSetOf(k), t, mutableListOf(m), null, emptyList()))
        }
        return clusters
    }

    private fun assignIds(clusters: List<Cluster>, existing: EntityMap, vault: List<VaultEntry>): MergeResult {
        val map = existing.clone()
        val mentions = ArrayList<Mention>()
        val idByCluster = HashMap<Int, PlaceholderId>()
        fun firstStart(c: Cluster): Int = c.mentions.minOf { it.span.start }
        val order = clusters.indices.sortedWith { a, b -> firstStart(clusters[a]) - firstStart(clusters[b]) }

        for (ci in order) {
            val c = clusters[ci]
            val entry = if (!c.vaultEntryId.isNullOrEmpty()) vault.firstOrNull { it.id == c.vaultEntryId } else null
            var forms = LinkedHashSet<String>()
            for (m in c.mentions) {
                forms.add(m.text)
                forms.add(stripPossessive(m.text))
                forms.addAll(m.extraForms)
            }
            if (entry != null) forms.addAll(entry.allTerms())
            forms = forms.filterTo(LinkedHashSet()) { Js.trim(it).isNotEmpty() }

            var canonical = entry?.canonical
            if (canonical == null) {
                var best: String? = null
                var bestTokens = -1
                for (raw in c.mentions.map { stripPossessive(it.text) }) {
                    val n = tokensOf(key(raw, c.category)).size
                    if (best == null || n > bestTokens || (n == bestTokens && Js.codePointLength(raw) > Js.codePointLength(best))) {
                        best = raw
                        bestTokens = n
                    }
                }
                canonical = best ?: ""
            }
            var bestMention: Accepted? = null
            for (m in c.mentions) if (bestMention == null || m.detector.priority < bestMention.detector.priority) bestMention = m
            val role: String? = if (entry != null) (if (entry.isUser) "the user" else entry.roleHint)
            else c.mentions.map { it.roleHint }.firstOrNull { !it.isNullOrEmpty() }
            val confidence = if (c.ambiguousWith.isEmpty()) c.mentions.map { it.confidence }.reduce { a, b -> if (a.rank >= b.rank) a else b } else Confidence.MEDIUM

            val foldedForms = forms.mapTo(HashSet()) { key(it, c.category) }
            val reuse = map.sorted().firstOrNull { e ->
                e.category == c.category &&
                    ((e.vaultEntryId != null && e.vaultEntryId == c.vaultEntryId) || e.surfaceForms.any { key(it, c.category) in foldedForms })
            }
            val id: PlaceholderId
            if (reuse != null) {
                id = reuse.id
                map.upsert(
                    reuse.copy(
                        surfaceForms = reuse.surfaceForms + forms,
                        sources = reuse.sources + c.mentions.map { it.detector },
                        confidence = Confidence.max(reuse.confidence, confidence),
                        roleHint = reuse.roleHint ?: role,
                    ),
                )
            } else {
                id = if (entry?.isUser == true) Placeholders.ME else map.nextId(c.category)
                map.upsert(
                    Entity.make(
                        id = id, category = c.category, canonical = canonical, surfaceForms = forms, roleHint = role, action = Action.Placeholder,
                        sources = c.mentions.mapTo(LinkedHashSet()) { it.detector }, confidence = confidence, subtype = bestMention?.subtype,
                        vaultEntryId = c.vaultEntryId,
                    ),
                )
            }
            idByCluster[ci] = id
            for (m in c.mentions) mentions.add(Mention(m.span, id, m.text))
        }

        val ambiguous = ArrayList<Ambiguity>()
        clusters.forEachIndexed { ci, c ->
            val id = idByCluster[ci] ?: return@forEachIndexed
            for (other in c.ambiguousWith) {
                val o = idByCluster[other]
                if (o != null) ambiguous.add(Ambiguity(id, o))
            }
        }
        mentions.sortWith { a, b -> a.span.compareTo(b.span) }
        return MergeResult(map, mentions, ambiguous)
    }
}
