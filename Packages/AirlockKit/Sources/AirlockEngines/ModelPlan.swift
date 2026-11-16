import AirlockCore

/// Which model(s) a route uses — a pure description, testable without Firebase.
public indirect enum ModelSpec: Sendable, Hashable {
    /// Apple's on-device model through Firebase AI Logic (`FirebaseAI.SystemLanguageModel`).
    case system(permissiveGuardrails: Bool)
    /// A Gemini model by name (from `AppConfig` only).
    case gemini(String)
    /// `HybridModel(primary:secondary:)` — falls back on *any* first-turn primary error (API-NOTES §7.7).
    case hybrid(primary: ModelSpec, secondary: ModelSpec)

    /// True if any part of this spec can reach the cloud.
    public var usesCloud: Bool {
        switch self {
        case .system: false
        case .gemini: true
        case .hybrid(let p, let s): p.usesCloud || s.usesCloud
        }
    }
}

/// How a route is executed (`docs/02-ARCHITECTURE.md` §5).
///
/// Guarantees: `.phoneOnly` never contains a Gemini model (INV-3); every Gemini name comes
/// from `AppConfig`; when Model Armor is expected, cloud-first is cloud-only with a manual
/// phone fallback **only when offline**, so an Armor block is shown rather than answered on device.
public struct ModelPlan: Sendable, Hashable {
    public let route: Route
    public let model: ModelSpec
    /// Retry on the phone-only model, with the same sealed text, only for `EngineError.offline`.
    public let manualOfflineFallback: Bool
    /// System instruction prompt id.
    public let instructionsID: String

    public static func plan(route: Route, config: AppConfig, quality: AnswerQuality = .auto) -> ModelPlan {
        let deep = quality == .best ? config.modelCloudMax : config.modelCloudDeep
        switch route {
        case .phoneOnly:
            return ModelPlan(
                route: route, model: .system(permissiveGuardrails: false), manualOfflineFallback: false, instructionsID: "phone-system.v1")
        case .phoneFirst:
            return ModelPlan(
                route: route, model: .hybrid(primary: .system(permissiveGuardrails: false), secondary: .gemini(config.modelCloudQuick)),
                manualOfflineFallback: false, instructionsID: "phone-system.v1")
        case .cloudFirst:
            if config.bool("armor_expected") {
                return ModelPlan(route: route, model: .gemini(deep), manualOfflineFallback: true, instructionsID: "cloud-system.v1")
            }
            return ModelPlan(
                route: route, model: .hybrid(primary: .gemini(deep), secondary: .system(permissiveGuardrails: false)),
                manualOfflineFallback: false, instructionsID: "cloud-system.v1")
        case .cloudOnly:
            return ModelPlan(route: route, model: .gemini(deep), manualOfflineFallback: false, instructionsID: "cloud-system.v1")
        }
    }
}
