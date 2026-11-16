import Foundation

// Engine contracts (docs/02-ARCHITECTURE.md §4). No Firebase here: AirlockEngines implements
// these with Firebase AI Logic; AirlockEngineMocks implements them for tests and previews.

/// Whether Apple's on-device model can run (mirrors `FirebaseAI.SystemLanguageModel.availability`).
public enum PhoneAvailability: String, Sendable, Hashable, Codable {
    case available, deviceNotEligible, appleIntelligenceNotEnabled, modelNotReady, unknown

    public var isAvailable: Bool { self == .available }
}

/// Engine failures. **No case carries content** — not the prompt, not the model's text, not
/// an SDK description that might echo either (INV-8). User-facing wording lives in the app.
public enum EngineError: Error, Sendable, Hashable {
    case unavailable(PhoneAvailability)
    /// Prompt + output exceeded the on-device window — chunk smaller and retry.
    case contextTooLong
    /// Apple's guardrails (or a refusal) declined this content on device.
    case refused
    case unsupportedLanguage
    /// The on-device model is busy or rate-limited.
    case busy
    /// The model's output couldn't be parsed.
    case parse
    /// Google Model Armor blocked the request (second net, Agent Platform only).
    case armorBlocked
    /// Gemini's own safety system blocked the prompt or answer.
    case cloudBlocked
    case quota
    case serviceUnavailable
    case offline
    case appCheck
    case cancelled
    /// Anything else, as a stable code (never a free-text description).
    case other(code: String)

    /// Worth retrying with backoff.
    public var isTransientCloud: Bool { self == .quota || self == .serviceUnavailable }
}

/// A prompt for the **phone-only** engine. May contain raw text (it never leaves the device).
///
/// Guarantees: the text is `package`-scoped, so code outside AirlockKit (the app, a future
/// plugin) can neither build one from a `String` nor read one back. Only phone-only engines
/// accept it (INV-3).
public struct PhonePrompt: Sendable, Hashable {
    /// Prompt id for logs and metrics, e.g. `detect.v1` (never the content).
    public let promptID: String
    package let instructions: String?
    package let text: String

    package init(promptID: String, instructions: String? = nil, text: String) {
        self.promptID = promptID
        self.instructions = instructions
        self.text = text
    }

    /// Approximate size in UTF-16 units, for budgeting.
    public var utf16Count: Int { text.utf16.count + (instructions?.utf16.count ?? 0) }
}

/// Generation options for on-device calls.
public struct PhoneOptions: Sendable, Hashable {
    public var greedy: Bool
    public var temperature: Double?
    public var maxTokens: Int?
    /// Apple's `permissiveContentTransformations` guardrails — for detection/redaction of
    /// sensitive user text, which the default guardrails often refuse (R-05).
    public var permissiveGuardrails: Bool

    public init(greedy: Bool = true, temperature: Double? = nil, maxTokens: Int? = nil, permissiveGuardrails: Bool = true) {
        self.greedy = greedy
        self.temperature = temperature
        self.maxTokens = maxTokens
        self.permissiveGuardrails = permissiveGuardrails
    }

    /// Detection, red-team, generalisation, tactics: deterministic and permissive.
    public static let analysis = PhoneOptions(greedy: true, maxTokens: 1_100, permissiveGuardrails: true)
}

/// What to do with sealed text: a rendered task instruction (`task.*.v1`).
public struct TaskSpec: Sendable, Hashable {
    public let id: String
    public let instruction: String
    public let maxOutputTokens: Int?

    public init(id: String, instruction: String, maxOutputTokens: Int? = nil) {
        self.id = id
        self.instruction = instruction
        self.maxOutputTokens = maxOutputTokens
    }
}

/// Earlier turns of a sealed thread, replayed into a fresh session (INV-4).
///
/// Guarantees: user turns are `SealedText` (gate-checked); assistant turns are the model's own
/// placeholder text exactly as received — never restored text (INV-7).
public struct SealedHistory: Sendable, Hashable {
    public enum Turn: Sendable, Hashable {
        case user(SealedText)
        case assistant(modelText: String)
    }

    public let turns: [Turn]

    public init(turns: [Turn]) {
        self.turns = turns
    }
}

/// One streamed update. Snapshots are **cumulative** (API-NOTES §8).
public struct EngineChunk: Sendable, Hashable {
    public let cumulativeText: String
    public let modelVersion: String?

    public init(cumulativeText: String, modelVersion: String?) {
        self.cumulativeText = cumulativeText
        self.modelVersion = modelVersion
    }
}

/// Answer quality chosen in Review ("Answer with").
public enum AnswerQuality: String, Sendable, Hashable, Codable {
    /// Route table defaults (`docs/02-ARCHITECTURE.md` §5).
    case auto
    /// Deep tasks use `model_cloud_max`.
    case best
}

/// The on-device engine. The **only** engine that accepts a `PhonePrompt` (and thus raw text).
public protocol PhoneOnlyEngine: Sendable {
    func availability() async -> PhoneAvailability
    func respond(_ prompt: PhonePrompt, options: PhoneOptions) async throws(EngineError) -> EngineResult
}

/// A cloud-capable engine (phoneFirst, cloudFirst, cloudOnly). Accepts **only** `SealedText` (INV-1).
public protocol SealedEngine: Sendable {
    var route: Route { get }
    func respond(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) async throws(EngineError) -> EngineResult
    /// Cumulative snapshots; the stream finishes with an `EngineError` on failure.
    func stream(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) -> AsyncThrowingStream<EngineChunk, any Error>
}

/// A parameter of a private tool (OpenAPI subset: no defaults, no oneOf).
public struct ToolParameter: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable { case string, integer, number, boolean }
    public let name: String
    public let kind: Kind
    public let description: String
    public let optional: Bool

    public init(name: String, kind: Kind, description: String, optional: Bool = false) {
        self.name = name
        self.kind = kind
        self.description = description
        self.optional = optional
    }
}

/// A private tool the cloud model may call (`docs/04-PROMPTS.md` §6).
public struct ToolSpec: Sendable, Hashable {
    public let name: String
    public let description: String
    public let parameters: [ToolParameter]

    public init(name: String, description: String, parameters: [ToolParameter]) {
        self.name = name
        self.description = description
        self.parameters = parameters
    }
}

/// A function call requested by the cloud model. Arguments are the model's own JSON.
public struct ToolCall: Sendable, Hashable {
    public let id: String?
    public let name: String
    public let argumentsJSON: String

    public init(id: String?, name: String, argumentsJSON: String) {
        self.id = id
        self.name = name
        self.argumentsJSON = argumentsJSON
    }
}

/// The phone's answer to a tool call.
///
/// Guarantees (INV-5): a result can only be a gate-produced `SealedText` (a JSON document), or
/// the fixed `{"error":"user_declined"}` / `{"error":"unavailable"}` payloads built by the engine.
public enum ToolReply: Sendable, Hashable {
    case result(SealedText)
    case declined
    case unavailable
}

/// Cloud function calling with private tools.
public protocol ToolCapableEngine: Sendable {
    func runToolLoop(
        _ sealed: SealedText, task: TaskSpec, tools: [ToolSpec],
        executor: @escaping @Sendable (ToolCall) async -> ToolReply
    ) async throws(EngineError) -> EngineResult
}

/// A web source used by Google Search grounding.
public struct GroundingSource: Sendable, Hashable {
    public let title: String?
    public let uri: String
    public init(title: String?, uri: String) {
        self.title = title
        self.uri = uri
    }
}

/// A Search-grounded answer, with what the Search display rules require.
public struct GroundedResult: Sendable, Hashable {
    public let result: EngineResult
    public let sources: [GroundingSource]
    public let searchQueries: [String]
    /// Google's rendered search-suggestion chip HTML — must be displayed as provided.
    public let searchEntryPointHTML: String?

    public init(result: EngineResult, sources: [GroundingSource], searchQueries: [String], searchEntryPointHTML: String?) {
        self.result = result
        self.sources = sources
        self.searchQueries = searchQueries
        self.searchEntryPointHTML = searchEntryPointHTML
    }
}

/// Cloud + Google Search grounding (Proof mode).
public protocol SearchGroundedEngine: Sendable {
    func respond(_ sealed: SealedText, task: TaskSpec) async throws(EngineError) -> GroundedResult
}

/// Vends every engine. Implemented by `FirebaseEngines` and `MockEngines`.
public protocol EngineProvider: Sendable {
    var phone: any PhoneOnlyEngine { get }
    func sealed(route: Route, quality: AnswerQuality) -> any SealedEngine
    var tools: any ToolCapableEngine { get }
    var search: any SearchGroundedEngine { get }
}
