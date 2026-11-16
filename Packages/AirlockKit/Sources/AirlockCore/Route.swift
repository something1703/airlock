/// How a request is allowed to run (`docs/02-ARCHITECTURE.md` §5).
///
/// Guarantees: the four routes map 1:1 to Firebase AI Logic's inference modes on
/// every platform (iOS sessions, web/Android `InferenceMode`). Raw text may only
/// ever use `.phoneOnly` (INV-3).
public enum Route: String, Codable, Sendable, CaseIterable, Hashable {
    case phoneOnly, phoneFirst, cloudFirst, cloudOnly

    /// Equivalent `InferenceMode` name in the web and Android SDKs.
    public var inferenceModeName: String {
        switch self {
        case .phoneOnly: "ONLY_ON_DEVICE"
        case .phoneFirst: "PREFER_ON_DEVICE"
        case .cloudFirst: "PREFER_IN_CLOUD"
        case .cloudOnly: "ONLY_IN_CLOUD"
        }
    }

    /// Whether this route may send anything off the device.
    public var mayUseCloud: Bool { self != .phoneOnly }
}

/// The result of one engine call.
///
/// Guarantees: `modelVersion` is copied from `response.rawResponse.modelVersion`
/// (AGENTS.md §5.5); `ranOnDevice` is derived from it, never assumed from the route.
public struct EngineResult: Sendable, Hashable {
    /// `rawResponse.modelVersion` value reported for Apple's on-device model.
    public static let appleOnDeviceModelVersion = "apple-foundation-models-system-language-model"

    public let text: String
    public let modelVersion: String
    public let ranOnDevice: Bool
    public let latency: Duration
    public let blockedByArmor: Bool

    public init(text: String, modelVersion: String, ranOnDevice: Bool? = nil, latency: Duration, blockedByArmor: Bool = false) {
        self.text = text
        self.modelVersion = modelVersion
        self.ranOnDevice = ranOnDevice ?? (modelVersion == Self.appleOnDeviceModelVersion)
        self.latency = latency
        self.blockedByArmor = blockedByArmor
    }
}
