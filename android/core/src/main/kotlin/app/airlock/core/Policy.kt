package app.airlock.core

/** User settings that adjust the dial (Settings → Privacy). */
data class PolicySettings(
    /** Generalise named health details even in Balanced. */
    val protectHealth: Boolean = false,
    /** Balanced/Open keep non-birth dates unless this is false. */
    val keepDates: Boolean = true,
    /** Per-category override applied after the dial. Never applies to `secret`. */
    val categoryOverrides: Map<PrivacyCategory, Action> = emptyMap(),
) {
    companion object {
        val DEFAULT = PolicySettings()
    }
}

/** A choice the user made for one entity on the Review screen. */
data class UserOverride(
    val action: Action,
    /** Required to un-seal a Vault entity (long-press "Reveal this time"). */
    val revealThisTime: Boolean = false,
)

/**
 * Stage 5 — decide what happens to each entity (port of policy.ts / PolicyEngine.swift; docs/03-PRIVACY-ENGINE.md §2.1).
 * Order: dial → category setting → user override. `secret` is always blocked; Vault entities become `keep` only
 * through an override with `revealThisTime`; people, contacts and IDs are never "generalised".
 */
class PolicyEngine(val dial: DialPreset, val settings: PolicySettings = PolicySettings.DEFAULT) {
    fun dialAction(e: Entity): Action {
        if (e.vaultEntryId != null) return if (e.category == PrivacyCategory.SECRET) Action.Block else Action.Placeholder
        val strict = dial == DialPreset.STRICT
        return when (e.category) {
            PrivacyCategory.SECRET -> Action.Block
            PrivacyCategory.PERSON, PrivacyCategory.CONTACT, PrivacyCategory.ID -> Action.Placeholder
            PrivacyCategory.ORG -> if (dial == DialPreset.OPEN) Action.Keep else Action.Generalise(if (strict) 3 else 2)
            PrivacyCategory.LOCATION -> when {
                !e.subtype.isNullOrEmpty() && e.subtype in ADDRESS_SUBTYPES -> Action.Placeholder
                Js.any(e.canonical, Js::isN) -> Action.Placeholder
                dial == DialPreset.OPEN -> Action.Keep
                else -> Action.Generalise(if (strict) 3 else 2)
            }
            PrivacyCategory.DATE -> when {
                e.subtype == "dob" -> Action.Generalise(if (strict) 3 else 2)
                strict || !settings.keepDates -> Action.Generalise(1)
                else -> Action.Keep
            }
            PrivacyCategory.HEALTH -> when (dial) {
                DialPreset.OPEN -> Action.Keep
                DialPreset.BALANCED -> if (settings.protectHealth) Action.Generalise(2) else Action.Keep
                DialPreset.STRICT -> Action.Generalise(2)
            }
            PrivacyCategory.QUASI -> Action.Keep
        }
    }

    fun action(e: Entity, override: UserOverride? = null): Action {
        if (e.category == PrivacyCategory.SECRET) return Action.Block
        var action = dialAction(e)
        val categoryOverride = settings.categoryOverrides[e.category]
        if (e.vaultEntryId == null && categoryOverride != null) action = categoryOverride
        if (override != null) {
            if (e.vaultEntryId != null && override.action == Action.Keep && !override.revealThisTime) return action
            if (override.action == Action.Block) return Action.Placeholder
            action = override.action
        }
        if (action is Action.Generalise && (e.category == PrivacyCategory.PERSON || e.category == PrivacyCategory.CONTACT || e.category == PrivacyCategory.ID)) {
            return Action.Placeholder
        }
        return action
    }

    val redTeamMode: RedTeamMode get() = when (dial) {
        DialPreset.OPEN -> RedTeamMode.OFF
        DialPreset.BALANCED -> RedTeamMode.SUGGEST
        DialPreset.STRICT -> RedTeamMode.AUTO_APPLY
    }

    val reviewMode: ReviewMode get() = when (dial) {
        DialPreset.OPEN -> ReviewMode.ONLY_IF_RISK
        DialPreset.BALANCED -> ReviewMode.IF_LOW_CONFIDENCE_OR_RISK
        DialPreset.STRICT -> ReviewMode.ALWAYS
    }

    /** Strict buckets money amounts. */
    val bucketsMoney: Boolean get() = dial == DialPreset.STRICT

    companion object {
        val ADDRESS_SUBTYPES = setOf("address", "unit", "postcode")
    }
}
