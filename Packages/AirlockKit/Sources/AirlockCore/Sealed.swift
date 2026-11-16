/// One legend line sent with sealed text: `[[PERSON_1]] — the user's landlord`.
///
/// Guarantees: `description` is a role hint only. The egress gate (G5) rejects
/// any legend line containing a surface form or a pattern hit.
public struct LegendLine: Sendable, Hashable, Codable {
    public let placeholder: PlaceholderID
    public let description: String

    public init(placeholder: PlaceholderID, description: String) {
        self.placeholder = placeholder
        self.description = description
    }

    /// Wire form used in the cloud user turn (`docs/04-PROMPTS.md` §5).
    public var rendered: String { "\(placeholder.token) — \(description)" }
}

/// The egress gate's deterministic checks (`docs/03-PRIVACY-ENGINE.md` §9).
public enum GateCheck: String, Sendable, Codable, CaseIterable, Hashable {
    case g1VaultTerms = "G1"
    case g2SurfaceForms = "G2"
    case g3Patterns = "G3"
    case g4PlaceholdersWellFormed = "G4"
    case g5LegendClean = "G5"
    case g6Normalised = "G6"
    case g7Size = "G7"

    /// Plain name shown on the Receipt screen.
    public var plainName: String {
        switch self {
        case .g1VaultTerms: "No saved names"
        case .g2SurfaceForms: "No detected names or details"
        case .g3Patterns: "No email, phone, ID or secret patterns"
        case .g4PlaceholdersWellFormed: "Every placeholder explained"
        case .g5LegendClean: "Explanations reveal nothing"
        case .g6Normalised: "No hidden characters"
        case .g7Size: "Size within limits"
        }
    }
}

/// What the gate verified about one outbound text.
public struct GateReport: Sendable, Hashable, Codable {
    public let checksPassed: [GateCheck]
    /// Sealed entity counts per category, plus `generalised` and `redteamApplied`.
    public let counts: [String: Int]
    /// Lowercase hex SHA-256 of the exact outbound UTF-8 text (value + rendered legend).
    public let outboundSha256: String
    /// True only when a DEBUG build skipped the checks (`debug_disable_gate`, used solely to demo
    /// the Model Armor second net). The UI shows a red banner and the receipt records it.
    public let bypassed: Bool

    public init(checksPassed: [GateCheck], counts: [String: Int], outboundSha256: String, bypassed: Bool = false) {
        self.checksPassed = checksPassed
        self.counts = counts
        self.outboundSha256 = outboundSha256
        self.bypassed = bypassed
    }
}

/// Text that has passed the egress gate. **The only input type cloud engines accept** (INV-1, INV-2).
///
/// Guarantees: there is no public initializer. The only initializer is behind
/// `@_spi(EgressGate)`, which only `AirlockSeal/EgressGate.swift` may import —
/// enforced by `scripts/lint.sh` and `SealedTextConstructionTests`. Decoding is
/// deliberately not supported: sealed text can't be resurrected from storage
/// and re-sent without passing the gate again.
public struct SealedText: Sendable, Hashable {
    public let value: String
    public let legend: [LegendLine]
    public let gateReport: GateReport

    @_spi(EgressGate)
    public init(value: String, legend: [LegendLine], gateReport: GateReport) {
        self.value = value
        self.legend = legend
        self.gateReport = gateReport
    }

    /// Legend as sent: one rendered line per placeholder.
    public var renderedLegend: String { legend.map(\.rendered).joined(separator: "\n") }
}
