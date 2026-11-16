import AirlockCore

/// User settings that adjust the dial (Settings → Privacy).
public struct PolicySettings: Sendable, Hashable, Codable {
    /// Generalise named health details even in Balanced ("Health" category toggle).
    public var protectHealth: Bool
    /// Balanced/Open keep non-birth dates unless this is false.
    public var keepDates: Bool
    /// Per-category override applied after the dial. Never applies to `secret`.
    public var categoryOverrides: [PrivacyCategory: Action]

    public init(protectHealth: Bool = false, keepDates: Bool = true, categoryOverrides: [PrivacyCategory: Action] = [:]) {
        self.protectHealth = protectHealth
        self.keepDates = keepDates
        self.categoryOverrides = categoryOverrides
    }
}

/// A choice the user made for one entity on the Review screen.
public struct UserOverride: Sendable, Hashable, Codable {
    public var action: Action
    /// Required to un-seal a Vault entity (long-press "Reveal this time").
    public var revealThisTime: Bool

    public init(action: Action, revealThisTime: Bool = false) {
        self.action = action
        self.revealThisTime = revealThisTime
    }
}

/// Stages 5 — decide what happens to each entity (`docs/03-PRIVACY-ENGINE.md` §2.1, §7).
///
/// Guarantees:
/// - Implements the dial table exactly; order is dial → category setting → user override.
/// - `secret` is always `.block`, whatever the settings or overrides.
/// - Vault entities are always placeholdered and become `.keep` only through an
///   override with `revealThisTime == true`.
/// - Addresses, units and postcodes are always placeholdered; only towns/cities are generalised.
public struct PolicyEngine: Sendable, Hashable {
    public let dial: DialPreset
    public let settings: PolicySettings

    public init(dial: DialPreset, settings: PolicySettings = PolicySettings()) {
        self.dial = dial
        self.settings = settings
    }

    static let addressSubtypes: Set<String> = ["address", "unit", "postcode"]

    /// The dial's default for an entity, before settings and overrides.
    public func dialAction(for e: Entity) -> Action {
        if e.vaultEntryID != nil { return e.category == .secret ? .block : .placeholder }
        switch e.category {
        case .secret: return .block
        case .person, .contact, .id: return .placeholder
        case .org:
            return dial == .open ? .keep : .generalise(level: dial == .strict ? 3 : 2)
        case .location:
            if let s = e.subtype, Self.addressSubtypes.contains(s) { return .placeholder }
            if e.canonical.contains(where: \.isNumber) { return .placeholder }
            return dial == .open ? .keep : .generalise(level: dial == .strict ? 3 : 2)
        case .date:
            if e.subtype == "dob" { return .generalise(level: dial == .strict ? 3 : 2) }
            if dial == .strict || !settings.keepDates { return .generalise(level: 1) }
            return .keep
        case .health:
            switch dial {
            case .open: return .keep
            case .balanced: return settings.protectHealth ? .generalise(level: 2) : .keep
            case .strict: return .generalise(level: 2)
            }
        case .quasi:
            return .keep
        }
    }

    /// Final action after settings and the user's override.
    public func action(for e: Entity, override: UserOverride? = nil) -> Action {
        if e.category == .secret { return .block }
        var action = dialAction(for: e)
        if e.vaultEntryID == nil, let o = settings.categoryOverrides[e.category] { action = o }
        if let o = override {
            if e.vaultEntryID != nil, o.action == .keep, !o.revealThisTime { return action }
            if o.action == .block, e.category != .secret { return .placeholder }
            action = o.action
        }
        // People, contacts and IDs are never "generalised" — a vaguer phrase would still identify.
        if case .generalise = action, [.person, .contact, .id].contains(e.category) { return .placeholder }
        return action
    }

    public var redTeamMode: RedTeamMode {
        switch dial {
        case .open: .off
        case .balanced: .suggest
        case .strict: .autoApply
        }
    }

    public var reviewMode: ReviewMode {
        switch dial {
        case .open: .onlyIfRisk
        case .balanced: .ifLowConfidenceOrRisk
        case .strict: .always
        }
    }

    /// Strict buckets money amounts ("$1,240" → "$1,000–1,500").
    public var bucketsMoney: Bool { dial == .strict }
}
