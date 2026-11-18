import Foundation

/// A Remote Config value with its declared type.
public enum ConfigValue: Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    /// A JSON document stored as a string (Remote Config `JSON` type).
    case json(String)

    /// Remote Config `valueType` name.
    public var remoteConfigType: String {
        switch self {
        case .string: "STRING"
        case .number: "NUMBER"
        case .bool: "BOOLEAN"
        case .json: "JSON"
        }
    }

    /// The value exactly as Remote Config stores it (always a string).
    public var remoteConfigString: String {
        switch self {
        case .string(let s), .json(let s): s
        case .bool(let b): b ? "true" : "false"
        case .number(let d): d.rounded() == d ? String(Int(d)) : String(d)
        }
    }
}

/// Every tunable: model names, thresholds, flags, prompt overrides.
///
/// Guarantees: `AppConfig.defaults` is the **only** place a model name may be
/// written in Swift (lint-enforced), and it matches
/// `firebase/remoteconfig.template.json` key-for-key and value-for-value
/// (`AppConfigTests`). Unknown or mistyped remote values fall back to defaults.
public struct AppConfig: Sendable, Hashable {
    public static let defaults: [String: ConfigValue] = [
        "ai_backend": .string("googleAI"),
        "ai_location": .string("global"),
        "model_cloud_deep": .string("gemini-3.8-flash"),
        "model_cloud_quick": .string("gemini-3.5-flash-lite"),
        "model_cloud_max": .string("gemini-4-hydrogen"),
        "model_cloud_proof": .string("gemini-3.8-flash"),
        "model_cloud_fallback": .string("gemini-3.5-flash-lite"),
        "dial_default": .string("balanced"),
        "detect_chunk_tokens": .number(1400),
        "detect_chunk_tokens_web": .number(3000),
        "detect_chunk_tokens_android": .number(700),
        "redteam_enabled": .bool(true),
        "redteam_rounds": .number(2),
        "nltagger_enabled": .bool(true),
        "vision_ocr_enabled": .bool(true),
        "llm_structured_output": .bool(false),
        "pattern_packs_disabled": .json("[]"),
        "prompt_overrides_json": .json("{}"),
        "feature_tools_calendar": .bool(true),
        "feature_proof": .bool(true),
        "feature_infer_card": .bool(true),
        "feature_sync": .bool(true),
        "evidence_json": .json("{}"),
        "min_supported_build": .number(1),
        "raw_purge_days": .number(30),
        "armor_expected": .bool(false),
        "armor_force_unary": .bool(false),
        "cloud_first_chunk_ms": .number(15000),
        "cloud_timeout_ms": .number(90000),
        "tool_max_rounds": .number(3),
    ]

    private let values: [String: ConfigValue]

    /// Builds a config from remote string values; anything missing or unparseable uses the default.
    public init(remote: [String: String] = [:]) {
        var merged = Self.defaults
        for (key, raw) in remote {
            guard let def = Self.defaults[key] else { continue }
            switch def {
            case .string: merged[key] = .string(raw)
            case .json: merged[key] = .json(raw)
            case .bool:
                if raw == "true" || raw == "false" { merged[key] = .bool(raw == "true") }
            case .number:
                if let d = Double(raw), d.isFinite { merged[key] = .number(d) }
            }
        }
        values = merged
    }

    public func string(_ key: String) -> String {
        if case .string(let s)? = values[key] { return s }
        if case .json(let s)? = values[key] { return s }
        return ""
    }

    public func bool(_ key: String) -> Bool {
        if case .bool(let b)? = values[key] { return b }
        return false
    }

    public func int(_ key: String) -> Int {
        if case .number(let d)? = values[key] { return Int(d) }
        return 0
    }

    // Typed accessors used across AirlockKit.
    public var modelCloudDeep: String { string("model_cloud_deep") }
    public var modelCloudQuick: String { string("model_cloud_quick") }
    public var modelCloudMax: String { string("model_cloud_max") }
    public var modelCloudProof: String { string("model_cloud_proof") }
    public var dialDefault: DialPreset { DialPreset(rawValue: string("dial_default")) ?? .balanced }
    public var detectChunkTokens: Int { max(200, int("detect_chunk_tokens")) }
    public var redTeamEnabled: Bool { bool("redteam_enabled") }
    public var redTeamRounds: Int { min(max(0, int("redteam_rounds")), 2) }
    public var nlTaggerEnabled: Bool { bool("nltagger_enabled") }
    public var visionOCREnabled: Bool { bool("vision_ocr_enabled") }

    /// Pattern pack ids disabled remotely (`pattern_packs_disabled`, JSON array of strings).
    public var disabledPatternPacks: Set<String> {
        guard let data = string("pattern_packs_disabled").data(using: .utf8),
            let arr = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Set(arr)
    }
}
