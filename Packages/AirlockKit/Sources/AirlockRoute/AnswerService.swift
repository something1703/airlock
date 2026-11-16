import AirlockCore
import AirlockLedger
import AirlockPrompts
import AirlockRestore
import Foundation

/// The finished answer, restored on device.
public struct AnswerOutcome: Sendable {
    /// What the model actually wrote (placeholders) — the only answer text that may sync (INV-7).
    public let modelText: String
    /// Real names back in — local only.
    public let restored: RestoreResult
    public let fidelity: FidelityReport
    public let route: Route
    public let modelVersion: String
    public let ranOnDevice: Bool
    /// Cloud was preferred but the phone answered (offline, or the SDK fell back — API-NOTES §7.7).
    public let fellBackToPhone: Bool
    public let latency: Duration
    /// Present whenever the sealed text may have left the phone.
    public let receipt: Receipt?
}

/// Streaming updates for the Thread screen.
public enum AnswerEvent: Sendable {
    /// The route chosen (RouteBadge shows "Asking Gemini…" or "On this iPhone").
    case started(Route)
    /// Restored text so far (cumulative) and its segments (for underlines).
    case partial(text: String, segments: [RestoredSegment])
    case finished(AnswerOutcome)
}

/// Answers a sealed request: route → engine → streaming restore → receipt.
///
/// Guarantees:
/// - Only `SealedText` reaches an engine (INV-1); restore happens here, on device.
/// - A receipt is written whenever the request may have left the phone — every cloud-capable
///   route except a phone-first answer that `modelVersion` proves ran on device — including when
///   Model Armor blocked it (`armor: .blocked`).
/// - Streaming output equals unary restore of the final text (`StreamingRestorer` guarantee).
public actor AnswerService {
    private let engines: any EngineProvider
    private let catalog: TaskCatalog
    private let ledger: ReceiptLedger
    private let armorExpected: Bool

    public init(engines: any EngineProvider, prompts: PromptLibrary, ledger: ReceiptLedger, armorExpected: Bool = false) {
        self.engines = engines
        self.catalog = TaskCatalog(prompts: prompts)
        self.ledger = ledger
        self.armorExpected = armorExpected
    }

    public nonisolated func answer(
        _ sealed: SealedText, task: TaskKind, question: SealedText? = nil, history: SealedHistory? = nil, restore: RestoreContext,
        preference: AnswerPreference = .auto, threadId: String, sealLatency: Duration = .zero
    ) -> AsyncThrowingStream<AnswerEvent, any Error> {
        AsyncThrowingStream { continuation in
            let work = Task {
                do {
                    let outcome = try await self.run(
                        sealed, task: task, question: question, history: history, restore: restore, preference: preference,
                        threadId: threadId, sealLatency: sealLatency
                    ) { continuation.yield($0) }
                    continuation.yield(.finished(outcome))
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    private func run(
        _ sealed: SealedText, task: TaskKind, question: SealedText?, history: SealedHistory?, restore: RestoreContext,
        preference: AnswerPreference, threadId: String, sealLatency: Duration, emit: @Sendable (AnswerEvent) -> Void
    ) async throws -> AnswerOutcome {
        let (route, quality) = Router.route(for: task, sealed: sealed, preference: preference)
        let spec: TaskSpec
        do { spec = try catalog.spec(task, question: question) } catch { throw EngineError.other(code: "prompt") }
        emit(.started(route))

        let ctx = RestoreContext(
            entities: restore.entities, userFirstName: restore.userFirstName, writingAsUser: task.writesAsUser,
            secretDisplay: restore.secretDisplay)
        var restorer = StreamingRestorer(context: ctx)
        var modelText = ""
        var modelVersion = ""
        let clock = ContinuousClock()
        let start = clock.now
        do {
            for try await chunk in engines.sealed(route: route, quality: quality).stream(sealed, task: spec, history: history) {
                modelText = chunk.cumulativeText
                if let v = chunk.modelVersion, !v.isEmpty { modelVersion = v }
                restorer.update(cumulative: modelText)
                emit(.partial(text: restorer.text, segments: restorer.segments))
            }
        } catch let error as EngineError where error == .armorBlocked {
            await ledger.append(
                sealed: sealed, threadId: threadId, route: route, modelVersion: "blocked", armor: .blocked, sealLatency: sealLatency,
                networkLatency: clock.now - start)
            throw error
        }
        // Flush the hold-back window so the last partial the UI sees equals the final text.
        restorer.finish()
        emit(.partial(text: restorer.text, segments: restorer.segments))
        let latency = clock.now - start
        let ranOnDevice = modelVersion == EngineResult.appleOnDeviceModelVersion
        let leftPhone = route.mayUseCloud && !(route == .phoneFirst && ranOnDevice)
        var receipt: Receipt?
        if leftPhone {
            receipt = await ledger.append(
                sealed: sealed, threadId: threadId, route: route, modelVersion: modelVersion,
                armor: armorExpected ? .pass : .notConfigured, sealLatency: sealLatency, networkLatency: latency)
        } else {
            await ledger.recordOnDeviceAnswer()
        }
        return AnswerOutcome(
            modelText: modelText, restored: Restorer.result(from: restorer),
            fidelity: FidelityCheck.check(modelOutput: modelText, context: ctx),
            route: route, modelVersion: modelVersion, ranOnDevice: ranOnDevice,
            fellBackToPhone: ranOnDevice && (route == .cloudFirst || route == .cloudOnly), latency: latency, receipt: receipt)
    }
}
