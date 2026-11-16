import AirlockCore
import Foundation

/// Thread-safe call log shared by the mocks.
final class CallLog<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [T] = []
    func append(_ t: T) { lock.withLock { items.append(t) } }
    var all: [T] { lock.withLock { items } }
}

/// Scriptable on-device engine for tests and previews.
///
/// Guarantees: never touches the network; records every prompt id (and, inside AirlockKit,
/// the prompt text) so tests can prove what was — or wasn't — sent to which engine.
public final class MockPhoneEngine: PhoneOnlyEngine, Sendable {
    public typealias Handler = @Sendable (_ promptID: String, _ text: String) async throws(EngineError) -> String

    private let availabilityValue: PhoneAvailability
    private let latency: Duration
    private let handler: Handler
    private let log = CallLog<(id: String, text: String)>()

    public init(availability: PhoneAvailability = .available, latency: Duration = .zero, handler: @escaping Handler) {
        self.availabilityValue = availability
        self.latency = latency
        self.handler = handler
    }

    /// A phone that always answers with `text`.
    public convenience init(answering text: String, availability: PhoneAvailability = .available) {
        self.init(availability: availability) { _, _ in text }
    }

    public func availability() async -> PhoneAvailability { availabilityValue }

    public func respond(_ prompt: PhonePrompt, options: PhoneOptions) async throws(EngineError) -> EngineResult {
        log.append((prompt.promptID, prompt.text))
        guard availabilityValue == .available else { throw .unavailable(availabilityValue) }
        if latency > .zero { try? await Task.sleep(for: latency) }
        let text = try await handler(prompt.promptID, prompt.text)
        return EngineResult(text: text, modelVersion: EngineResult.appleOnDeviceModelVersion, latency: latency)
    }

    /// Prompt ids in call order.
    public var calledPromptIDs: [String] { log.all.map(\.id) }
    /// Prompt texts in call order (AirlockKit tests only).
    package var calledPromptTexts: [String] { log.all.map(\.text) }
}

/// Scriptable sealed (cloud-capable) engine. Records every `SealedText` it receives.
public final class MockSealedEngine: SealedEngine, Sendable {
    public typealias Handler = @Sendable (_ sealed: SealedText, _ task: TaskSpec) async throws(EngineError) -> String

    public let route: Route
    private let modelVersion: String
    private let handler: Handler
    private let log = CallLog<SealedText>()

    public init(route: Route, modelVersion: String = "mock-gemini", handler: @escaping Handler) {
        self.route = route
        self.modelVersion = modelVersion
        self.handler = handler
    }

    public func respond(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) async throws(EngineError) -> EngineResult {
        log.append(sealed)
        let text = try await handler(sealed, task)
        return EngineResult(text: text, modelVersion: modelVersion, latency: .milliseconds(1))
    }

    public func stream(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) -> AsyncThrowingStream<EngineChunk, any Error> {
        let version = modelVersion
        return AsyncThrowingStream { continuation in
            let task = Task {
                do throws(EngineError) {
                    let result = try await self.respond(sealed, task: task, history: history)
                    // Cumulative snapshots every ~12 characters, like the real SDK.
                    var acc = ""
                    for ch in result.text {
                        acc.append(ch)
                        if acc.count % 12 == 0 { continuation.yield(EngineChunk(cumulativeText: acc, modelVersion: version)) }
                    }
                    continuation.yield(EngineChunk(cumulativeText: acc, modelVersion: version))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public var received: [SealedText] { log.all }
}

/// Scripted tool-calling engine: issues `calls`, collects the phone's replies, then answers.
public final class MockToolEngine: ToolCapableEngine, Sendable {
    public typealias Finish = @Sendable (_ replies: [ToolReply]) -> String

    private let calls: [ToolCall]
    private let finish: Finish
    private let log = CallLog<ToolReply>()

    public init(calls: [ToolCall], finish: @escaping Finish) {
        self.calls = calls
        self.finish = finish
    }

    public func runToolLoop(
        _ sealed: SealedText, task: TaskSpec, tools: [ToolSpec], executor: @escaping @Sendable (ToolCall) async -> ToolReply
    ) async throws(EngineError) -> EngineResult {
        var replies: [ToolReply] = []
        for call in calls where tools.contains(where: { $0.name == call.name }) {
            let reply = await executor(call)
            log.append(reply)
            replies.append(reply)
        }
        return EngineResult(text: finish(replies), modelVersion: "mock-gemini", latency: .milliseconds(1))
    }

    public var replies: [ToolReply] { log.all }
}

/// Scripted Search-grounded engine.
public final class MockSearchEngine: SearchGroundedEngine, Sendable {
    private let answer: String
    private let sources: [GroundingSource]

    public init(answer: String, sources: [GroundingSource] = []) {
        self.answer = answer
        self.sources = sources
    }

    public func respond(_ sealed: SealedText, task: TaskSpec) async throws(EngineError) -> GroundedResult {
        GroundedResult(
            result: EngineResult(text: answer, modelVersion: "mock-gemini", latency: .milliseconds(1)), sources: sources,
            searchQueries: [], searchEntryPointHTML: nil)
    }
}

/// A complete mock `EngineProvider`.
public struct MockEngines: EngineProvider {
    public let phone: any PhoneOnlyEngine
    public let sealedEngines: [Route: any SealedEngine]
    public let tools: any ToolCapableEngine
    public let search: any SearchGroundedEngine

    public init(
        phone: any PhoneOnlyEngine = MockPhoneEngine(answering: "{\"items\":[]}"),
        sealed: [Route: any SealedEngine] = [:],
        tools: any ToolCapableEngine = MockToolEngine(calls: []) { _ in "Done." },
        search: any SearchGroundedEngine = MockSearchEngine(answer: "VERDICT: UNCLEAR")
    ) {
        self.phone = phone
        self.sealedEngines = sealed
        self.tools = tools
        self.search = search
    }

    public func sealed(route: Route, quality: AnswerQuality) -> any SealedEngine {
        sealedEngines[route] ?? MockSealedEngine(route: route) { _, _ in "Here's a reply for [[PERSON_1]]." }
    }
}
