// Core types — a port of web/src/engine/types.ts and AirlockCore (Swift). Spans are UTF-16 code-unit
// offsets (Kotlin `String` indices are UTF-16 too), so the shared fixtures mean the same on every platform.
package app.airlock.core

enum class PrivacyCategory(val wire: String, val prefix: String?, val priority: Int) {
    PERSON("person", "PERSON", 3),
    ORG("org", "ORG", 4),
    LOCATION("location", "LOC", 5),
    CONTACT("contact", "CONTACT", 2),
    ID("id", "ID", 1),
    DATE("date", "DATE", 6),
    HEALTH("health", "HEALTH", 7),
    SECRET("secret", "SECRET", 0),
    QUASI("quasi", null, 8);

    companion object {
        /** Declaration order matches `ALL_CATEGORIES` in the other ports. */
        val ALL: List<PrivacyCategory> = entries
        fun fromWire(s: String): PrivacyCategory? = entries.firstOrNull { it.wire == s }
        fun fromPrefix(prefix: String): PrivacyCategory? = prefix.uppercase().let { up -> entries.firstOrNull { it.prefix == up } }
    }
}

/** Merge rule: user > vault > pattern > llm > nl > redteam (lower wins). */
enum class DetectorId(val wire: String, val priority: Int) {
    USER("user", 0), VAULT("vault", 1), PATTERN("pattern", 2), LLM("llm", 3), NL("nl", 4), REDTEAM("redteam", 5);

    companion object {
        fun fromWire(s: String): DetectorId? = entries.firstOrNull { it.wire == s }
    }
}

enum class Confidence(val wire: String, val rank: Int) {
    LOW("low", 0), MEDIUM("medium", 1), HIGH("high", 2);

    companion object {
        fun fromWire(s: String): Confidence? = entries.firstOrNull { it.wire == s.lowercase() }
        fun max(a: Confidence, b: Confidence): Confidence = if (a.rank >= b.rank) a else b
    }
}

/** Half-open range [start, end) in UTF-16 code units. */
data class TextSpan(val start: Int, val end: Int) : Comparable<TextSpan> {
    val length: Int get() = end - start
    fun overlaps(o: TextSpan): Boolean = start < o.end && o.start < end
    fun contains(inner: TextSpan): Boolean = start <= inner.start && inner.end <= end
    override fun compareTo(other: TextSpan): Int = if (start != other.start) start - other.start else end - other.end
}

fun String.substringOf(s: TextSpan): String? = if (s.start >= 0 && s.end <= length && s.start <= s.end) substring(s.start, s.end) else null

/** One raw detection before merging. `text` is exactly the UTF-16 substring at `span`. */
data class Candidate(
    val span: TextSpan,
    val text: String,
    val category: PrivacyCategory,
    val subtype: String? = null,
    val detector: DetectorId,
    val confidence: Confidence,
    val roleHint: String? = null,
    val sameAs: String? = null,
    val vaultEntryId: String? = null,
)

// MARK: Placeholder ids — canonical strings: "PERSON_1", "ORG_2", "PERSON_ME".

typealias PlaceholderId = String

object Placeholders {
    const val ME: PlaceholderId = "PERSON_ME"

    /** `index` is null for ME. */
    data class Parsed(val category: PrivacyCategory, val index: Int?)

    private val NUMBER = Regex("^[1-9][0-9]*$")

    /** Accepts the canonical grammar only (case-insensitive prefix); `ME` only for PERSON; no leading zeros. */
    fun parse(s: String): Parsed? {
        val cut = s.indexOf('_')
        if (cut <= 0 || cut == s.length - 1) return null
        val category = PrivacyCategory.fromPrefix(s.substring(0, cut)) ?: return null
        if (category.prefix == null) return null
        val rest = s.substring(cut + 1)
        if (rest.uppercase() == "ME") return if (category == PrivacyCategory.PERSON) Parsed(category, null) else null
        if (!NUMBER.matches(rest)) return null
        return rest.toIntOrNull()?.let { Parsed(category, it) }
    }

    fun make(category: PrivacyCategory, n: Int): PlaceholderId {
        val prefix = category.prefix
        require(prefix != null && n >= 1) { "invalid placeholder" }
        return "${prefix}_$n"
    }

    fun token(id: PlaceholderId): String = "[[$id]]"
    fun isMe(id: PlaceholderId): Boolean = id == ME
    fun category(id: PlaceholderId): PrivacyCategory = requireNotNull(parse(id)) { "invalid placeholder id" }.category

    /** Category priority, then ME first, then number. */
    val ORDER: Comparator<PlaceholderId> = Comparator { a, b ->
        val pa = parse(a)
        val pb = parse(b)
        when {
            pa == null || pb == null -> a.compareTo(b)
            pa.category != pb.category -> pa.category.priority - pb.category.priority
            pa.index == null -> if (pb.index == null) 0 else -1
            pb.index == null -> 1
            else -> pa.index - pb.index
        }
    }
}

// MARK: Actions

sealed interface Action {
    data object Placeholder : Action
    data object Keep : Action
    data object Block : Action
    data class Generalise(val level: Int) : Action

    val mustNotEgress: Boolean get() = this !is Keep

    /** "generalise:2" etc. — the string form used by the shared fixtures. */
    val wire: String
        get() = when (this) {
            Placeholder -> "placeholder"
            Keep -> "keep"
            Block -> "block"
            is Generalise -> "generalise:$level"
        }

    companion object {
        fun parse(s: String): Action = when {
            s.startsWith("generalise:") -> Generalise(s.removePrefix("generalise:").toInt())
            s == "keep" -> Keep
            s == "block" -> Block
            else -> Placeholder
        }
    }
}

// MARK: Entities

data class Entity(
    val id: PlaceholderId,
    val category: PrivacyCategory,
    val canonical: String,
    val surfaceForms: Set<String> = setOf(canonical),
    val roleHint: String? = null,
    val action: Action = Action.Placeholder,
    val generalisedText: String? = null,
    val sources: Set<DetectorId>,
    val confidence: Confidence,
    val subtype: String? = null,
    /** The Vault entry this came from, if any — such entities can only be revealed explicitly. */
    val vaultEntryId: String? = null,
) {
    companion object {
        /** Like `makeEntity`: the canonical form is always among the surface forms. */
        fun make(
            id: PlaceholderId, category: PrivacyCategory, canonical: String, sources: Set<DetectorId>, confidence: Confidence,
            surfaceForms: Set<String> = emptySet(), roleHint: String? = null, action: Action = Action.Placeholder,
            generalisedText: String? = null, subtype: String? = null, vaultEntryId: String? = null,
        ) = Entity(id, category, canonical, surfaceForms + canonical, roleHint, action, generalisedText, sources, confidence, subtype, vaultEntryId)
    }
}

/** Placeholder → entity for one thread. Lives only on device, encrypted at rest (INV-6). Immutable entities, mutable map. */
class EntityMap(entities: Iterable<Entity> = emptyList()) {
    private val map = LinkedHashMap<PlaceholderId, Entity>()

    init {
        for (e in entities) map[e.id] = e
    }

    operator fun get(id: PlaceholderId): Entity? = map[id]
    fun has(id: PlaceholderId): Boolean = map.containsKey(id)
    fun upsert(e: Entity) { map[e.id] = e }
    val size: Int get() = map.size
    fun keys(): List<PlaceholderId> = map.keys.toList()

    /** Entities sorted by placeholder id. */
    fun sorted(): List<Entity> = map.values.sortedWith(compareBy(Placeholders.ORDER) { it.id })

    /** Independent copy (entities are immutable data classes, so a shallow copy suffices). */
    fun clone(): EntityMap = EntityMap(map.values)

    /** Next unused number for a category (`PERSON_ME` doesn't consume one). */
    fun nextId(category: PrivacyCategory): PlaceholderId {
        var max = 0
        for (id in map.keys) {
            val p = Placeholders.parse(id)
            if (p != null && p.category == category && p.index != null) max = maxOf(max, p.index)
        }
        return Placeholders.make(category, max + 1)
    }
}

// MARK: Dial

enum class DialPreset(val wire: String) { OPEN("open"), BALANCED("balanced"), STRICT("strict") }
enum class RedTeamMode(val wire: String) { OFF("off"), SUGGEST("suggest"), AUTO_APPLY("autoApply") }
enum class ReviewMode(val wire: String) { ONLY_IF_RISK("onlyIfRisk"), IF_LOW_CONFIDENCE_OR_RISK("ifLowConfidenceOrRisk"), ALWAYS("always") }

// MARK: Routes

/** `inferenceMode` matches the Firebase AI Logic `InferenceMode` names (web + Android SDKs). */
enum class Route(val wire: String, val inferenceMode: String) {
    PHONE_ONLY("phoneOnly", "ONLY_ON_DEVICE"),
    PHONE_FIRST("phoneFirst", "PREFER_ON_DEVICE"),
    CLOUD_FIRST("cloudFirst", "PREFER_IN_CLOUD"),
    CLOUD_ONLY("cloudOnly", "ONLY_IN_CLOUD"),
}

// MARK: Sealed text

data class LegendLine(val placeholder: PlaceholderId, val description: String) {
    fun rendered(): String = "${Placeholders.token(placeholder)} — $description"
}

enum class GateCheckId { G1, G2, G3, G4, G5, G6, G7 }

data class GateReport(
    val checksPassed: List<GateCheckId>,
    val counts: Map<String, Int>,
    /** Lowercase hex SHA-256 of the exact outbound text (value + "\n\n" + rendered legend). */
    val outboundSha256: String,
    val bypassed: Boolean,
)

/**
 * Text that has passed the egress gate — the only input type cloud engines accept (INV-1, INV-2).
 * The constructor is `internal` and requires a [GateToken], which only `EgressGate` can create
 * (`SealedTextConstructionTest` scans the sources and fails if anything else mentions it).
 */
class SealedText internal constructor(
    @Suppress("UNUSED_PARAMETER") token: GateToken,
    val value: String,
    val legend: List<LegendLine>,
    val gateReport: GateReport,
) {
    /** Legend as sent: one rendered line per placeholder. */
    fun renderedLegend(): String = legend.joinToString("\n") { it.rendered() }

    /** Exactly what leaves the device. */
    fun outbound(): String = if (legend.isEmpty()) value else "$value\n\n${renderedLegend()}"

    override fun toString(): String = "Sealed(${value.length} chars)"
}

/** Capability that only the egress gate holds. */
class GateToken internal constructor()
