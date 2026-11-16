import { type Action, type DialPreset, type Entity, type PrivacyCategory, type RedTeamMode, type ReviewMode, BLOCK, KEEP, PLACEHOLDER, generalise } from "./types";

/** User settings that adjust the dial (Settings → Privacy). */
export interface PolicySettings {
  /** Generalise named health details even in Balanced. */
  protectHealth: boolean;
  /** Balanced/Open keep non-birth dates unless this is false. */
  keepDates: boolean;
  /** Per-category override applied after the dial. Never applies to `secret`. */
  categoryOverrides: Partial<Record<PrivacyCategory, Action>>;
}
export const DEFAULT_POLICY_SETTINGS: PolicySettings = { protectHealth: false, keepDates: true, categoryOverrides: {} };

/** A choice the user made for one entity on the Review screen. */
export interface UserOverride {
  action: Action;
  /** Required to un-seal a Vault entity (long-press "Reveal this time"). */
  revealThisTime: boolean;
}

export const ADDRESS_SUBTYPES = new Set(["address", "unit", "postcode"]);

/**
 * Stage 5 — decide what happens to each entity (port of PolicyEngine.swift; docs/03-PRIVACY-ENGINE.md §2.1).
 * Order: dial → category setting → user override. `secret` is always blocked; Vault entities become
 * `keep` only through an override with `revealThisTime`; people, contacts and IDs are never "generalised".
 */
export class PolicyEngine {
  constructor(
    readonly dial: DialPreset,
    readonly settings: PolicySettings = DEFAULT_POLICY_SETTINGS,
  ) {}

  dialAction(e: Entity): Action {
    if (e.vaultEntryId != null) return e.category === "secret" ? BLOCK : PLACEHOLDER;
    const strict = this.dial === "strict";
    switch (e.category) {
      case "secret":
        return BLOCK;
      case "person":
      case "contact":
      case "id":
        return PLACEHOLDER;
      case "org":
        return this.dial === "open" ? KEEP : generalise(strict ? 3 : 2);
      case "location":
        if (e.subtype && ADDRESS_SUBTYPES.has(e.subtype)) return PLACEHOLDER;
        if (/\p{N}/u.test(e.canonical)) return PLACEHOLDER;
        return this.dial === "open" ? KEEP : generalise(strict ? 3 : 2);
      case "date":
        if (e.subtype === "dob") return generalise(strict ? 3 : 2);
        return strict || !this.settings.keepDates ? generalise(1) : KEEP;
      case "health":
        if (this.dial === "open") return KEEP;
        if (this.dial === "balanced") return this.settings.protectHealth ? generalise(2) : KEEP;
        return generalise(2);
      case "quasi":
        return KEEP;
    }
  }

  action(e: Entity, override?: UserOverride): Action {
    if (e.category === "secret") return BLOCK;
    let action = this.dialAction(e);
    const categoryOverride = this.settings.categoryOverrides[e.category];
    if (e.vaultEntryId == null && categoryOverride) action = categoryOverride;
    if (override) {
      if (e.vaultEntryId != null && override.action.kind === "keep" && !override.revealThisTime) return action;
      if (override.action.kind === "block") return PLACEHOLDER;
      action = override.action;
    }
    if (action.kind === "generalise" && (e.category === "person" || e.category === "contact" || e.category === "id")) return PLACEHOLDER;
    return action;
  }

  get redTeamMode(): RedTeamMode {
    return this.dial === "open" ? "off" : this.dial === "balanced" ? "suggest" : "autoApply";
  }
  get reviewMode(): ReviewMode {
    return this.dial === "open" ? "onlyIfRisk" : this.dial === "balanced" ? "ifLowConfidenceOrRisk" : "always";
  }
  /** Strict buckets money amounts. */
  get bucketsMoney(): boolean {
    return this.dial === "strict";
  }
}
