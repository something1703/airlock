package app.airlock.core

import java.util.regex.Pattern

/** One placeholder found in model output. `original` is exactly the text at `span`. */
data class PlaceholderToken(
    val span: TextSpan,
    /** Exactly what the model wrote, e.g. `[[ Person_1 ]]`. */
    val original: String,
    val id: PlaceholderId,
    /** True only for the exact canonical form `[[PERSON_1]]`. */
    val isCanonical: Boolean,
)

/**
 * Finds placeholders in model output (port of restore.ts `PlaceholderParser`). The canonical form is always
 * returned (unknown ids become "unknown" chips); tolerated variants — `[PERSON_1]`, bare `PERSON_1`,
 * `[[ PERSON_1 ]]`, `[[Person_1]]`, `[[PERSON 1]]`, `【PERSON_1】` — only when the id is in `knownIds`.
 */
class PlaceholderParser(val knownIds: Set<PlaceholderId>) {
    fun tokens(text: String): List<PlaceholderToken> {
        val found = ArrayList<PlaceholderToken>()
        val m = BRACKETED.matcher(text)
        while (m.find()) {
            val id = canonicalId(m.group(2), m.group(4)) ?: continue
            val original = m.group()
            val canonical = m.group(1) == "[[" && m.group(5) == "]]" && m.group(3) == "_" && original == Placeholders.token(id)
            if (!canonical && id !in knownIds) continue
            found.add(PlaceholderToken(TextSpan(m.start(), m.end()), original, id, canonical))
        }
        val b = BARE.matcher(text)
        while (b.find()) {
            val span = TextSpan(b.start(), b.end())
            if (found.any { it.span.start < span.end && span.start < it.span.end }) continue
            val id = canonicalId(b.group(1), b.group(2))
            if (id == null || id !in knownIds || b.group() != id) continue
            found.add(PlaceholderToken(span, b.group(), id, false))
        }
        return found.sortedBy { it.span.start }
    }

    companion object {
        const val MAX_TOKEN_LENGTH = 24
        private const val CATS = "PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET"
        private val BRACKETED = Pattern.compile("(\\[\\[|\\[|【)[ ]{0,2}($CATS)([_ ])(\\d{1,4}|ME)[ ]{0,2}(\\]\\]|\\]|】)", Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE)
        private val BARE = Pattern.compile("(?<![A-Za-z0-9_\\[【])($CATS)_(\\d{1,4}|ME)(?![A-Za-z0-9_\\]】])")

        private fun canonicalId(cat: String, idx: String): PlaceholderId? {
            val p = Placeholders.parse("${cat}_$idx") ?: return null
            return if (p.index == null) Placeholders.ME else "${p.category.prefix}_${p.index}"
        }
    }
}

/** What the restorer needs; all of it stays on device. */
data class RestoreContext(
    val entities: EntityMap,
    /** Used for `[[PERSON_ME]]` only in drafts written as the user. */
    val userFirstName: String? = null,
    val writingAsUser: Boolean = false,
    /** Plain-text stand-in for secrets in copied text. Secrets are never restored. */
    val secretDisplay: String? = null,
)

/** A piece of restored output. Secrets carry no value — they are never restored. */
sealed interface RestoredSegment {
    data class Text(val text: String) : RestoredSegment
    data class Restored(val id: PlaceholderId, val display: String, val original: String) : RestoredSegment
    data class Secret(val id: PlaceholderId, val original: String) : RestoredSegment
    data class Unknown(val id: PlaceholderId, val original: String) : RestoredSegment

    fun output(secretDisplay: String): String = when (this) {
        is Text -> text
        is Restored -> display
        is Secret -> secretDisplay
        is Unknown -> original
    }
}

/**
 * Streaming-safe restore (port of StreamingRestorer). For any split of a response into chunks — deltas or
 * cumulative snapshots — the segments equal restoring the whole response at once. Only the last ≤ [HOLD_BACK]
 * UTF-16 units are held back; secrets are never restored. Not thread-safe: one restorer per answer.
 */
class StreamingRestorer(val context: RestoreContext) {
    private class Forms(val first: String, val later: String)

    private val parser = PlaceholderParser(context.entities.keys().toSet())
    private val forms = displayForms(context.entities)
    private val buffer = StringBuilder()
    private var emitted = 0
    private val seen = HashSet<PlaceholderId>()
    private val segs = ArrayList<RestoredSegment>()
    val segments: List<RestoredSegment> get() = segs.toList()
    var finished = false
        private set

    fun append(delta: String): List<RestoredSegment> {
        check(!finished) { "restorer already finished" }
        buffer.append(delta)
        return process(false)
    }

    fun update(cumulative: String): List<RestoredSegment> =
        if (cumulative.length > buffer.length) append(cumulative.substring(buffer.length)) else emptyList()

    fun finish(): List<RestoredSegment> {
        val out = process(true)
        finished = true
        return out
    }

    val text: String get() {
        val sd = context.secretDisplay ?: DEFAULT_SECRET_DISPLAY
        return segs.joinToString("") { it.output(sd) }
    }

    private fun process(final: Boolean): List<RestoredSegment> {
        val buf = buffer.toString()
        val tokens = parser.tokens(buf)
        var safeEnd = if (final) buf.length else maxOf(emitted, buf.length - HOLD_BACK)
        if (!final) {
            val spanning = tokens.firstOrNull { it.span.start < safeEnd && it.span.end > safeEnd }
            if (spanning != null) safeEnd = maxOf(emitted, spanning.span.start)
        }
        // Never cut between the two UTF-16 halves of one character.
        if (!final && safeEnd > emitted && safeEnd < buf.length) {
            if (buf[safeEnd - 1].code in 0xd800..0xdbff) safeEnd -= 1
        }
        if (safeEnd <= emitted) return emptyList()

        val out = ArrayList<RestoredSegment>()
        var cursor = emitted
        for (t in tokens) {
            if (t.span.start < emitted || t.span.end > safeEnd) continue
            if (t.span.start > cursor) out.add(RestoredSegment.Text(buf.substring(cursor, t.span.start)))
            out.add(resolve(t))
            cursor = t.span.end
        }
        if (safeEnd > cursor) out.add(RestoredSegment.Text(buf.substring(cursor, safeEnd)))
        emitted = safeEnd
        for (seg in out) {
            val last = segs.lastOrNull()
            if (seg is RestoredSegment.Text && last is RestoredSegment.Text) segs[segs.size - 1] = RestoredSegment.Text(last.text + seg.text)
            else segs.add(seg)
        }
        return out
    }

    private fun resolve(t: PlaceholderToken): RestoredSegment {
        if (t.id.startsWith("SECRET_")) return RestoredSegment.Secret(t.id, t.original)
        if (Placeholders.isMe(t.id)) {
            val display = if (context.writingAsUser) (context.userFirstName ?: "me") else "you"
            return RestoredSegment.Restored(t.id, display, t.original)
        }
        val f = forms[t.id] ?: return RestoredSegment.Unknown(t.id, t.original)
        val display = if (t.id in seen) f.later else f.first
        seen.add(t.id)
        return RestoredSegment.Restored(t.id, display, t.original)
    }

    companion object {
        const val HOLD_BACK = 32
        const val DEFAULT_SECRET_DISPLAY = "(hidden code)"
        private val TITLES = setOf("dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "prof", "prof.")
        private val BY_LENGTH = Comparator<String> { a, b -> if (a.length != b.length) a.length - b.length else a.compareTo(b) }

        /** First mention canonical; later person mentions use the shortest surface form no other person shares. */
        private fun displayForms(map: EntityMap): Map<PlaceholderId, Forms> {
            val sorted = map.sorted()
            val people = sorted.filter { it.category == PrivacyCategory.PERSON }
            val result = HashMap<PlaceholderId, Forms>()
            for (e in sorted) {
                if (e.category != PrivacyCategory.PERSON) {
                    result[e.id] = Forms(e.canonical, e.canonical)
                    continue
                }
                val otherForms = HashSet<String>()
                for (o in people) {
                    if (o.id == e.id) continue
                    for (f in o.surfaceForms) otherForms.add(FoldedSearch.fold(f))
                    for (w in o.canonical.split(" ")) otherForms.add(FoldedSearch.fold(w))
                }
                val short = e.surfaceForms.filter { it.lowercase() !in TITLES && FoldedSearch.fold(it) !in otherForms }.sortedWith(BY_LENGTH).firstOrNull() ?: e.canonical
                result[e.id] = Forms(e.canonical, short)
            }
            return result
        }
    }
}

/** A whole restored answer, with where the restored values sit (for underlining). */
data class RestoreResult(
    val text: String,
    val segments: List<RestoredSegment>,
    /** Where restored values sit in `text` (UTF-16). */
    val restoredRanges: List<Pair<TextSpan, PlaceholderId>>,
    val unknownIds: List<PlaceholderId>,
    val secretsHidden: Int,
)

/** Did the model's own output stay clean? */
data class FidelityReport(
    /** Canonical placeholders the phone couldn't resolve. */
    val unknownIds: List<PlaceholderId>,
    /** Entities whose real value appears in the model's own output — it guessed a real name. */
    val guessedEntities: List<PlaceholderId>,
) {
    val isClean: Boolean get() = unknownIds.isEmpty() && guessedEntities.isEmpty()
}

/** Restore entry points (port of restore.ts `restore`, `resultFrom`, `fidelityCheck`). */
object Restorer {
    fun resultFrom(r: StreamingRestorer): RestoreResult {
        val sd = r.context.secretDisplay ?: StreamingRestorer.DEFAULT_SECRET_DISPLAY
        val ranges = ArrayList<Pair<TextSpan, PlaceholderId>>()
        val unknown = ArrayList<PlaceholderId>()
        var secrets = 0
        var offset = 0
        val segments = r.segments
        for (seg in segments) {
            val len = seg.output(sd).length
            when (seg) {
                is RestoredSegment.Restored -> ranges.add(TextSpan(offset, offset + len) to seg.id)
                is RestoredSegment.Unknown -> unknown.add(seg.id)
                is RestoredSegment.Secret -> secrets++
                is RestoredSegment.Text -> {}
            }
            offset += len
        }
        return RestoreResult(r.text, segments, ranges, unknown, secrets)
    }

    /** Unary restore — one streaming append plus finish, so streaming and non-streaming can never disagree. */
    fun restore(modelOutput: String, context: RestoreContext): RestoreResult {
        val s = StreamingRestorer(context)
        s.append(modelOutput)
        s.finish()
        return resultFrom(s)
    }

    /** Runs on the model's raw output (before restore), so any real value found there wasn't introduced by restore. */
    fun fidelityCheck(modelOutput: String, context: RestoreContext): FidelityReport {
        val unknownIds = restore(modelOutput, context).unknownIds
        val guessed = context.entities.sorted()
            .filter { e -> e.action.mustNotEgress && e.surfaceForms.any { it.length >= 3 && FoldedSearch.contains(it, modelOutput) } }
            .map { it.id }
        return FidelityReport(unknownIds, guessed)
    }
}
