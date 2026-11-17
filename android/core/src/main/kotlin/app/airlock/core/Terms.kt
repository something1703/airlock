package app.airlock.core

/** Which gate check a term belongs to: G1 = Vault, G2 = entity. */
enum class TermCheck { G1, G2 }

/** One string that must not appear in outbound text. */
data class Term(val text: String, val check: TermCheck, val category: PrivacyCategory, val caseSensitive: Boolean)

/** Entity term expansion (port of terms.ts), shared by the egress gate and generaliser validation. */
object Terms {
    /** First names that are also everyday words — not checked case-sensitively as bare tokens. */
    val COMMON_WORDS = setOf(
        "will", "may", "june", "april", "august", "rose", "grace", "hope", "joy", "faith", "mark", "bill", "frank", "art", "sky", "river", "dawn",
        "summer", "autumn", "winter", "ray", "rich", "sunny", "honey", "page", "pat", "sue", "jack", "max", "victor", "trust", "ivy", "lily", "daisy",
        "ruby", "pearl", "amber", "crystal", "sandy", "rusty", "brook", "gay", "holly", "jean", "rob", "drew", "chase", "hunter", "mason", "cash",
        "king", "queen", "young", "white", "black", "brown", "green", "gray", "grey", "long", "little", "small", "good", "best", "street", "the",
        "and", "for", "you", "your", "our", "his", "her", "dear", "mom", "dad", "mum", "aunt", "uncle", "grandma", "mrs", "miss", "prof", "sir",
        "madam", "dame", "lord", "lady", "doctor",
    )

    /** Generic words inside organisation and place names — never identifying on their own. */
    val GENERIC_PLACE_WORDS = setOf(
        "hospital", "clinic", "medical", "centre", "center", "health", "care", "general", "university", "college", "school", "academy",
        "institute", "bank", "group", "company", "corp", "corporation", "inc", "ltd", "llc", "limited", "partners", "services", "solutions",
        "logistics", "properties", "property", "management", "realty", "holdings", "international", "national", "global", "city", "county",
        "state", "north", "south", "east", "west", "new", "saint", "street", "road", "avenue", "lane", "drive", "court", "place", "park",
        "square", "apartment", "apartments", "unit", "suite", "floor", "view", "hill", "valley", "lake", "river", "church", "office",
        "department", "agency", "council", "trust", "foundation",
    )

    private fun stripEdges(w: String): String = Js.trimWhere(w) { Js.isP(it) || Js.isS(it) }

    /** `form.split(/[\s,-]+/u)`. */
    private fun splitWords(s: String): List<String> {
        val out = ArrayList<String>()
        var start = 0
        var i = 0
        fun sep(c: Char) = Js.isWhitespace(c) || c == ',' || c == '-'
        while (i < s.length) {
            if (sep(s[i])) {
                var j = i
                while (j < s.length && sep(s[j])) j++
                out.add(s.substring(start, i))
                start = j
                i = j
            } else i++
        }
        out.add(s.substring(start))
        return out
    }

    /**
     * Every way an entity could still show up: whole surface forms (case-insensitive), plus for people,
     * organisations and places: contiguous sub-phrases of ≥ 2 words ("Mercy General" from "Mercy General Hospital")
     * and distinctive single words (≥ 3 letters for people, ≥ 4 otherwise), case-sensitive, excluding everyday and
     * generic words.
     */
    fun entityTerms(e: Entity): List<Term> {
        val forms = e.surfaceForms.filter { it.length >= 2 }
        val terms = forms.mapTo(ArrayList()) { Term(it, TermCheck.G2, e.category, false) }
        if (e.category != PrivacyCategory.PERSON && e.category != PrivacyCategory.ORG && e.category != PrivacyCategory.LOCATION) return terms
        val phrases = LinkedHashSet<String>()
        val singles = LinkedHashSet<String>()
        val minLength = if (e.category == PrivacyCategory.PERSON) 3 else 4
        for (form in forms) {
            val words = splitWords(form).map(::stripEdges).filter { it.isNotEmpty() }
            if (words.size >= 3) {
                for (n in 2 until words.size) {
                    var i = 0
                    while (i + n <= words.size) {
                        phrases.add(words.subList(i, i + n).joinToString(" "))
                        i++
                    }
                }
            }
            for (w in words) {
                val first = w.codePointAt(0)
                if (Js.codePointLength(w) < minLength || !Js.isLu(first)) continue
                val lower = w.lowercase()
                if (lower in COMMON_WORDS || lower in GENERIC_PLACE_WORDS || Js.all(w, Js::isN)) continue
                singles.add(w)
            }
        }
        val all = forms.toSet()
        for (p in phrases.sorted()) if (p !in all) terms.add(Term(p, TermCheck.G2, e.category, false))
        for (s in singles.sorted()) if (s !in all) terms.add(Term(s, TermCheck.G2, e.category, true))
        return terms
    }
}
