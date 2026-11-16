import AirlockCore
import AirlockDetect
import AirlockEngineMocks
import AirlockLedger
import AirlockPrompts
import AirlockRestore
import Foundation
import Testing

@testable import AirlockRoute
@testable import AirlockSeal

let patterns: PatternDetector = {
    guard let p = try? PatternDetector.bundled(useDataDetectors: false) else { fatalError("packs") }
    return p
}()

let raj = Entity(
    id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: ["Raj Patel", "Raj"],
    sources: [.vault], confidence: .high)
let me = Entity(
    id: .me, category: .person, canonical: "Maya Chen", surfaceForms: ["Maya Chen", "Maya"], sources: [.vault], confidence: .high)

func sealedMessage(_ text: String = "Hi [[PERSON_1]], the heater is still broken. — [[PERSON_ME]]") throws -> SealedText {
    let legend = [
        LegendLine(placeholder: .me, description: "the user"), LegendLine(placeholder: raj.id, description: "the user's landlord"),
    ]
    .filter { text.contains($0.placeholder.token) }
    let draft = SealDraft(
        text: text, legend: legend, replacements: [], entities: EntityMap([raj, me]), secretWarnings: [], revealedVaultIDs: [],
        keptValues: [])
    return try EgressGate(patterns: patterns, vault: []).seal(draft)
}

@Suite struct RouterTests {
    @Test(arguments: [
        (TaskKind.summary, Route.phoneFirst), (.actions, .phoneFirst), (.rewrite(tone: "calm"), .phoneFirst), (.explain, .phoneFirst),
        (.help, .cloudFirst), (.questions, .cloudFirst), (.reply(tone: "firm"), .cloudFirst), (.custom, .cloudFirst),
    ])
    func routeTable(task: TaskKind, expected: Route) throws {
        #expect(Router.route(for: task, sealed: try sealedMessage(), preference: .auto).route == expected)
        #expect(Router.route(for: task, sealed: try sealedMessage(), preference: .phoneOnly).route == .phoneOnly)
    }

    @Test func longTextGoesCloudOnlyAndBestQualityOnlyForDeepTasks() throws {
        let long = try sealedMessage(String(repeating: "The heater is broken again. ", count: 300))
        #expect(Router.route(for: .summary, sealed: long, preference: .auto).route == .cloudOnly)
        #expect(Router.route(for: .help, sealed: try sealedMessage(), preference: .best).quality == .best)
        #expect(Router.route(for: .summary, sealed: try sealedMessage(), preference: .best).quality == .auto)
    }

    @Test func taskSpecsRender() throws {
        let catalog = TaskCatalog(prompts: try PromptLibrary())
        #expect(
            try catalog.spec(.reply(tone: "firm but polite")).instruction
                == "Draft a reply I can send. Tone: firm but polite. Write it as me. Use placeholders for names.")
        let q = try sealedMessage("What can I ask [[PERSON_1]] to fix?")
        #expect(try catalog.spec(.custom, question: q).instruction == "What can I ask [[PERSON_1]] to fix?")
        #expect(try catalog.spec(.summary).maxOutputTokens == 600)
    }
}

@Suite struct AnswerServiceTests {
    let restore = RestoreContext(entities: EntityMap([raj, me]), userFirstName: "Maya")

    func collect(_ stream: AsyncThrowingStream<AnswerEvent, any Error>) async throws -> (events: [AnswerEvent], outcome: AnswerOutcome?) {
        var events: [AnswerEvent] = []
        var outcome: AnswerOutcome?
        for try await e in stream {
            events.append(e)
            if case .finished(let o) = e { outcome = o }
        }
        return (events, outcome)
    }

    @Test func deepAnswerStreamsRestoresAndWritesReceipt() async throws {
        let answer =
            "Here's a reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], please fix the heater this week.\n\nThanks,\n[[PERSON_ME]]"
        let cloud = MockSealedEngine(route: .cloudFirst, modelVersion: "gemini-3.8-flash") { _, _ in answer }
        let ledger = ReceiptLedger()
        let service = AnswerService(engines: MockEngines(sealed: [.cloudFirst: cloud]), prompts: try PromptLibrary(), ledger: ledger)
        let sealed = try sealedMessage()
        let (events, outcome) = try await collect(service.answer(sealed, task: .reply(tone: "firm"), restore: restore, threadId: "thr_1"))
        let o = try #require(outcome)
        #expect(o.restored.text == "Here's a reply you can send to Raj Patel:\n\nHi Raj, please fix the heater this week.\n\nThanks,\nMaya")
        #expect(o.modelText == answer && o.fidelity.isClean && !o.ranOnDevice && !o.fellBackToPhone)
        #expect(cloud.received == [sealed], "the engine only ever saw the sealed text")
        // Partial restored text only grows and ends at the final text.
        let partials = events.compactMap { if case .partial(let t, _) = $0 { t } else { nil } }
        #expect(partials.count > 1)
        for (a, b) in zip(partials, partials.dropFirst()) { #expect(b.hasPrefix(a)) }
        #expect(partials.last == o.restored.text)
        // Receipt.
        let receipt = try #require(o.receipt)
        #expect(receipt.route == .cloudFirst && receipt.modelVersion == "gemini-3.8-flash" && receipt.seq == 1)
        #expect(receipt.outboundSha256 == sealed.gateReport.outboundSha256 && receipt.counts["person"] == 2)
        #expect(await ledger.verify() == .valid(count: 1))
        #expect(!(receipt.outboundText ?? "").contains("Raj"))
    }

    @Test func quickTaskOnDeviceMakesNoReceipt() async throws {
        let phoneFirst = MockSealedEngine(route: .phoneFirst, modelVersion: EngineResult.appleOnDeviceModelVersion) { _, _ in
            "- [[PERSON_1]] hasn't fixed the heater."
        }
        let ledger = ReceiptLedger()
        let service = AnswerService(engines: MockEngines(sealed: [.phoneFirst: phoneFirst]), prompts: try PromptLibrary(), ledger: ledger)
        let (_, outcome) = try await collect(service.answer(try sealedMessage(), task: .summary, restore: restore, threadId: "t"))
        #expect(outcome?.ranOnDevice == true && outcome?.receipt == nil)
        #expect(outcome?.restored.text == "- Raj Patel hasn't fixed the heater.")
        #expect(await ledger.receipts.isEmpty)
        #expect(await ledger.stats(since: .distantPast).onDeviceAnswers == 1)
    }

    @Test func cloudFallbackToPhoneIsLabelledAndStillReceipted() async throws {
        let fellBack = MockSealedEngine(route: .cloudFirst, modelVersion: EngineResult.appleOnDeviceModelVersion) { _, _ in
            "Ask [[PERSON_1]] again."
        }
        let ledger = ReceiptLedger()
        let service = AnswerService(engines: MockEngines(sealed: [.cloudFirst: fellBack]), prompts: try PromptLibrary(), ledger: ledger)
        let (_, outcome) = try await collect(service.answer(try sealedMessage(), task: .help, restore: restore, threadId: "t"))
        #expect(outcome?.fellBackToPhone == true)
        #expect(outcome?.receipt != nil, "conservative: a cloud-first attempt may have sent the sealed text")
    }

    @Test func armorBlockWritesBlockedReceiptAndThrows() async throws {
        let blocked = MockSealedEngine(route: .cloudFirst) { _, _ throws(EngineError) in throw .armorBlocked }
        let ledger = ReceiptLedger()
        let service = AnswerService(
            engines: MockEngines(sealed: [.cloudFirst: blocked]), prompts: try PromptLibrary(), ledger: ledger, armorExpected: true)
        await #expect(throws: EngineError.armorBlocked) {
            _ = try await collect(service.answer(try sealedMessage(), task: .help, restore: restore, threadId: "t"))
        }
        #expect(await ledger.receipts.map(\.armor) == [.blocked])
    }

    @Test func modelGuessingARealNameIsFlagged() async throws {
        let guesser = MockSealedEngine(route: .cloudFirst) { _, _ in "I think [[PERSON_1]] is Raj from the corner shop." }
        let service = AnswerService(
            engines: MockEngines(sealed: [.cloudFirst: guesser]), prompts: try PromptLibrary(), ledger: ReceiptLedger())
        let (_, outcome) = try await collect(service.answer(try sealedMessage(), task: .help, restore: restore, threadId: "t"))
        #expect(outcome?.fidelity.guessedEntities.map(\.description) == ["PERSON_1"])
    }
}

@Suite struct LedgerTests {
    @Test func chainAndWeeklyStats() async throws {
        let ledger = ReceiptLedger()
        let sealed = try sealedMessage()
        for i in 0..<5 {
            await ledger.append(
                sealed: sealed, threadId: "t\(i)", route: .cloudFirst, modelVersion: "gemini-3.8-flash", armor: .notConfigured,
                sealLatency: .milliseconds(900),
                networkLatency: .seconds(2), at: Date(timeIntervalSince1970: 1_790_000_000 + Double(i) * 60))
        }
        await ledger.recordOnDeviceAnswer()
        #expect(await ledger.verify() == .valid(count: 5))
        let receipts = await ledger.receipts
        #expect(receipts.map(\.seq) == [1, 2, 3, 4, 5])
        #expect(receipts[0].latencyMs == ["seal": 900, "network": 2000])
        #expect(receipts[0].createdAt.hasSuffix("Z") && receipts[0].createdAt.count == 20)
        let stats = await ledger.stats(since: .distantPast)
        #expect(stats.requests == 5 && stats.cloudAnswers == 5 && stats.onDeviceAnswers == 1)
        #expect(stats.byCategory["person"] == 10 && stats.sealedDetails == 10)
    }
}
