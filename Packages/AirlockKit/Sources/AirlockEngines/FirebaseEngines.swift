import AirlockCore
import AirlockPrompts
import FirebaseAILogic
import Foundation

/// Serialises on-device calls: Apple's model handles one request at a time well, and parallel
/// calls only queue anyway and complicate cancellation (`docs/02-ARCHITECTURE.md` §8).
actor PhoneQueue {
    private var tail: Task<Void, Never>?

    func run<T: Sendable>(_ op: @escaping @Sendable () async -> Result<T, EngineError>) async -> Result<T, EngineError> {
        let previous = tail
        let task = Task { () -> Result<T, EngineError> in
            await previous?.value
            if Task.isCancelled { return .failure(.cancelled) }
            return await op()
        }
        tail = Task { _ = await task.value }
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }
}

/// The Firebase AI Logic implementation of every engine. **The only Firebase AI call site.**
///
/// Guarantees:
/// - A new `GenerativeModelSession` per call (INV-4).
/// - `modelVersion` always comes from `rawResponse.modelVersion` (AGENTS.md §5.5).
/// - Raw text (`PhonePrompt`) only ever reaches a phone-only system-model session (INV-3).
/// - Must be created after `FirebaseApp.configure()`.
public final class FirebaseEngines: EngineProvider, Sendable {
    let ai: FirebaseAI
    let config: AppConfig
    let prompts: PromptLibrary
    let queue = PhoneQueue()

    public init(config: AppConfig, prompts: PromptLibrary) {
        self.config = config
        self.prompts = prompts
        let backend: Backend =
            config.string("ai_backend") == "agentPlatform" ? .agentPlatform(location: config.string("ai_location")) : .googleAI()
        ai = FirebaseAI.firebaseAI(backend: backend)
    }

    public var phone: any PhoneOnlyEngine { FirebasePhoneEngine(engines: self) }

    public func sealed(route: Route, quality: AnswerQuality) -> any SealedEngine {
        FirebaseSealedEngine(engines: self, plan: ModelPlan.plan(route: route, config: config, quality: quality))
    }

    public var tools: any ToolCapableEngine { FirebaseToolEngine(engines: self) }
    public var search: any SearchGroundedEngine { FirebaseSearchEngine(engines: self) }

    // MARK: Shared helpers

    func provider(_ spec: ModelSpec) -> any LanguageModelProvider {
        switch spec {
        case .system(let permissive):
            return FirebaseAI.SystemLanguageModel.systemModel(guardrails: permissive ? .permissiveContentTransformations : .default)
        case .gemini(let name):
            return GeminiModelProvider.geminiModel(name: name)
        case .hybrid(let p, let s):
            return HybridModelProvider.hybridModel(primary: provider(p), secondary: provider(s))
        }
    }

    static func phoneOptions(_ o: PhoneOptions) -> FirebaseAI.GenerationOptions {
        FirebaseAI.GenerationOptions(sampling: o.greedy ? .greedy : nil, temperature: o.temperature, maximumResponseTokens: o.maxTokens)
    }

    static func options(for spec: ModelSpec, maxTokens: Int?) -> any GenerationOptionsRepresentable {
        let gemini = GenerationConfig(maxOutputTokens: maxTokens)
        let phone = FirebaseAI.GenerationOptions(maximumResponseTokens: maxTokens.map { min($0, 1_500) })
        switch spec {
        case .system: return ResponseGenerationOptions.foundationModels(phone)
        case .gemini: return ResponseGenerationOptions.gemini(gemini)
        case .hybrid: return ResponseGenerationOptions.hybrid(gemini: gemini, foundationModels: phone)
        }
    }

    /// Exponential backoff ×3 (0.5 s, 1 s, 2 s) for 429/503, then the error surfaces.
    static func withRetry<T: Sendable>(_ op: @Sendable () async throws(EngineError) -> T) async throws(EngineError) -> T {
        var delay = Duration.milliseconds(500)
        for attempt in 0...3 {
            do {
                return try await op()
            } catch  where error.isTransientCloud && attempt < 3 {
                try? await Task.sleep(for: delay)
                delay *= 2
            }
        }
        return try await op()
    }

    public func phoneAvailability() -> PhoneAvailability {
        ErrorMapper.availability(FirebaseAI.SystemLanguageModel.default.availability)
    }
}

/// Phone-only engine: `ai.generativeModelSession(model: .systemModel(...))`, no cloud model attached.
struct FirebasePhoneEngine: PhoneOnlyEngine {
    let engines: FirebaseEngines

    func availability() async -> PhoneAvailability { engines.phoneAvailability() }

    func respond(_ prompt: PhonePrompt, options: PhoneOptions) async throws(EngineError) -> EngineResult {
        let a = engines.phoneAvailability()
        guard a == .available else { throw .unavailable(a) }
        let ai = engines.ai
        let model = engines.provider(.system(permissiveGuardrails: options.permissiveGuardrails))
        let fmOptions = FirebaseEngines.phoneOptions(options)
        let instructions = prompt.instructions
        let text = prompt.text
        let result = await engines.queue.run { () async -> Result<EngineResult, EngineError> in
            let clock = ContinuousClock()
            let start = clock.now
            do {
                let session = ai.generativeModelSession(model: model, instructions: instructions)
                let response = try await session.respond(to: text, options: ResponseGenerationOptions.foundationModels(fmOptions))
                return .success(
                    EngineResult(text: response.content, modelVersion: response.rawResponse.modelVersion, latency: clock.now - start))
            } catch {
                return .failure(ErrorMapper.map(error))
            }
        }
        return try result.get()
    }
}

/// phoneFirst / cloudFirst / cloudOnly on sealed text only.
struct FirebaseSealedEngine: SealedEngine {
    let engines: FirebaseEngines
    let plan: ModelPlan

    var route: Route { plan.route }

    private func session(_ spec: ModelSpec) throws(EngineError) -> GenerativeModelSession {
        let instructions: String
        do { instructions = try engines.prompts.template(spec.usesCloud ? plan.instructionsID : "phone-system.v1") } catch {
            throw .other(code: "prompt")
        }
        return engines.ai.generativeModelSession(model: engines.provider(spec), instructions: instructions)
    }

    private func userTurn(_ sealed: SealedText, _ task: TaskSpec, _ history: SealedHistory?) throws(EngineError) -> String {
        do { return try engines.prompts.cloudUserTurn(sealed, task: task, history: history) } catch { throw .other(code: "prompt") }
    }

    func respond(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) async throws(EngineError) -> EngineResult {
        let turn = try userTurn(sealed, task, history)
        do {
            return try await FirebaseEngines.withRetry { () async throws(EngineError) -> EngineResult in
                try await once(plan.model, turn: turn, maxTokens: task.maxOutputTokens)
            }
        } catch .offline where plan.manualOfflineFallback {
            return try await once(.system(permissiveGuardrails: false), turn: turn, maxTokens: task.maxOutputTokens)
        }
    }

    private func once(_ spec: ModelSpec, turn: String, maxTokens: Int?) async throws(EngineError) -> EngineResult {
        let s = try session(spec)
        let clock = ContinuousClock()
        let start = clock.now
        do {
            let response = try await s.respond(to: turn, options: FirebaseEngines.options(for: spec, maxTokens: maxTokens))
            return EngineResult(text: response.content, modelVersion: response.rawResponse.modelVersion, latency: clock.now - start)
        } catch {
            throw ErrorMapper.map(error)
        }
    }

    func stream(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) -> AsyncThrowingStream<EngineChunk, any Error> {
        AsyncThrowingStream { continuation in
            let work = Task {
                do throws(EngineError) {
                    let turn = try userTurn(sealed, task, history)
                    do throws(EngineError) {
                        try await streamOnce(plan.model, turn: turn, maxTokens: task.maxOutputTokens, into: continuation)
                    } catch .offline where plan.manualOfflineFallback {
                        try await streamOnce(
                            .system(permissiveGuardrails: false), turn: turn, maxTokens: task.maxOutputTokens, into: continuation)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    private func streamOnce(
        _ spec: ModelSpec, turn: String, maxTokens: Int?, into continuation: AsyncThrowingStream<EngineChunk, any Error>.Continuation
    ) async throws(EngineError) {
        let s = try session(spec)
        do {
            let stream = s.streamResponse(to: turn, options: FirebaseEngines.options(for: spec, maxTokens: maxTokens))
            for try await snapshot in stream {
                continuation.yield(EngineChunk(cumulativeText: snapshot.content, modelVersion: snapshot.rawResponse.modelVersion))
            }
        } catch {
            throw ErrorMapper.map(error)
        }
    }
}
