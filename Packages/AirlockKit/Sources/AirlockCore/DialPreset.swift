/// The privacy dial (`docs/03-PRIVACY-ENGINE.md` §2.1).
///
/// Guarantees: raw values match Remote Config `dial_default` and the Firestore
/// `users/{uid}.dial` field.
public enum DialPreset: String, Sendable, Codable, CaseIterable, Hashable {
    case open, balanced, strict
}

/// How red-team suggestions are handled for a dial.
public enum RedTeamMode: String, Sendable, Codable, Hashable {
    case off, suggest, autoApply
}

/// When the Review screen is shown.
public enum ReviewMode: String, Sendable, Codable, Hashable {
    case onlyIfRisk, ifLowConfidenceOrRisk, always
}
