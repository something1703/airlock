package app.airlock.core

/** One "always protect" entry the user saved. Stored only on device, encrypted (INV-6). */
data class VaultEntry(
    val id: String,
    val canonical: String,
    val aliases: List<String>,
    val category: PrivacyCategory,
    val roleHint: String? = null,
    /** The user themself → always `[[PERSON_ME]]`. */
    val isUser: Boolean,
) {
    /** Canonical plus aliases (non-blank, de-duplicated), longest first (code points), then by UTF-16 order. */
    fun allTerms(): List<String> =
        LinkedHashSet((listOf(canonical) + aliases).filter { Js.trim(it).isNotEmpty() }).sortedWith { a, b ->
            val la = Js.codePointLength(a)
            val lb = Js.codePointLength(b)
            if (la != lb) lb - la else a.compareTo(b)
        }
}

/** D1 — Vault matcher (highest-priority detector). Folded, word-bounded; longer terms win; hits never overlap. */
class VaultMatcher(val entries: List<VaultEntry>) {
    fun detect(text: String): List<Candidate> {
        val terms = entries.flatMap { entry -> entry.allTerms().map { it to entry } }
            .sortedWith { a, b -> Js.codePointLength(b.first) - Js.codePointLength(a.first) }
        val hits = ArrayList<Pair<TextSpan, VaultEntry>>()
        for ((term, entry) in terms) {
            for (span in FoldedSearch.ranges(term, text)) {
                if (hits.none { it.first.overlaps(span) }) hits.add(span to entry)
            }
        }
        hits.sortWith { a, b -> a.first.compareTo(b.first) }
        val out = ArrayList<Candidate>()
        for ((span, entry) in hits) {
            val value = text.substringOf(span) ?: continue
            out.add(
                Candidate(
                    span = span, text = value, category = entry.category, subtype = if (entry.isUser) "self" else null,
                    detector = DetectorId.VAULT, confidence = Confidence.HIGH,
                    roleHint = if (entry.isUser) "the user" else entry.roleHint, vaultEntryId = entry.id,
                ),
            )
        }
        return out
    }
}
