package app.airlock.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

// Terse accessors for reading the shared fixtures.
operator fun JsonElement.get(key: String): JsonElement = (this as JsonObject)[key] ?: JsonNull
val JsonElement.list: List<JsonElement> get() = if (this is JsonArray) this else emptyList()
val JsonElement.str: String get() = (this as JsonPrimitive).content
val JsonElement.strOrNull: String? get() = if (this is JsonNull || this !is JsonPrimitive) null else content
val JsonElement.int: Int get() = requireNotNull((this as JsonPrimitive).intOrNull)
val JsonElement.intOrNull: Int? get() = (this as? JsonPrimitive)?.intOrNull
val JsonElement.bool: Boolean get() = (this as? JsonPrimitive)?.booleanOrNull ?: false
val JsonElement.strings: List<String> get() = list.map { it.str }
val JsonElement.isNull: Boolean get() = this is JsonNull
val JsonElement.entries: Set<Map.Entry<String, JsonElement>> get() = (this as JsonObject).entries

fun cat(s: String): PrivacyCategory = requireNotNull(PrivacyCategory.fromWire(s)) { s }

fun fixtureEntity(f: JsonElement): Entity = Entity.make(
    id = f["id"].str, category = cat(f["category"].str), canonical = f["canonical"].str, surfaceForms = f["surfaceForms"].strings.toSet(),
    action = Action.parse(f["action"].str), sources = setOf(DetectorId.LLM), confidence = Confidence.HIGH, vaultEntryId = f["vaultEntryId"].strOrNull,
)

fun fixtureVault(v: JsonElement): VaultEntry = VaultEntry(
    id = v["id"].str, canonical = v["canonical"].str, aliases = v["aliases"].strings, category = cat(v["category"].str),
    roleHint = v["roleHint"].strOrNull, isUser = v["isUser"].bool,
)
