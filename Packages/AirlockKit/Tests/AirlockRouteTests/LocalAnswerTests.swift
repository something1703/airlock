import AirlockCore
import AirlockEngineMocks
import AirlockPrompts
import Foundation
import Testing

@testable import AirlockRoute

/// FX-02: quick tasks answered on the device from the raw message — no seal, no Review.
@Suite struct LocalAnswerTests {
    @Test func quickTasksWithTheModelAvailableUnlessBestAnswer() {
        for task in [TaskKind.summary, .explain, .actions, .rewrite(tone: "firm")] {
            #expect(LocalAnswer.runsOnDevice(task: task, preference: .auto, availability: .available, rawLength: 500))
            #expect(!LocalAnswer.runsOnDevice(task: task, preference: .best, availability: .available, rawLength: 500))
        }
    }

    @Test func deepTasksOnlyWhenThisDeviceOnly() {
        for task in [TaskKind.help, .questions, .reply(tone: "firm"), .custom] {
            #expect(!LocalAnswer.runsOnDevice(task: task, preference: .auto, availability: .available, rawLength: 500))
            #expect(LocalAnswer.runsOnDevice(task: task, preference: .phoneOnly, availability: .available, rawLength: 500))
            #expect(!LocalAnswer.runsOnDevice(task: task, preference: .best, availability: .available, rawLength: 500))
        }
    }

    @Test func neverWithoutTheModelOrForAMessageTooBigForItsWindow() {
        #expect(!LocalAnswer.runsOnDevice(task: .summary, preference: .phoneOnly, availability: nil, rawLength: 500))
        #expect(!LocalAnswer.runsOnDevice(task: .summary, preference: .phoneOnly, availability: .appleIntelligenceNotEnabled, rawLength: 500))
        #expect(LocalAnswer.runsOnDevice(task: .summary, preference: .auto, availability: .available, rawLength: Router.onDeviceLimit))
        #expect(!LocalAnswer.runsOnDevice(task: .summary, preference: .auto, availability: .available, rawLength: Router.onDeviceLimit + 1))
    }

    @Test func sendsTheRawMessageAndTheTaskToThePhoneOnlyEngineOnly() async throws {
        let phone = MockPhoneEngine(answering: "  - Raj is late.\n- Ask for a date.  ")
        let r = await try LocalAnswer.run(
            phone: phone, prompts: try PromptLibrary(), task: .summary, raw: "Raj Patel said the heater is fixed on Friday.")
        #expect(phone.calledPromptIDs == ["phone-local.v1"])
        let sent = try #require(phone.calledPromptTexts.first)
        #expect(sent.contains("Raj Patel said the heater is fixed on Friday."))
        #expect(sent.contains("Summarise this in 5 bullet points."))
        #expect(r.text == "- Raj is late.\n- Ask for a date.")
    }

    @Test func earlierExchangesGoInFrontNewestKeptFirst() async throws {
        let phone = MockPhoneEngine(answering: "ok")
        let big = String(repeating: "x", count: 4_000)
        _ = await try LocalAnswer.run(
            phone: phone, prompts: try PromptLibrary(), task: .summary, raw: "now",
            earlier: [.init(raw: "oldest", answer: big), .init(raw: "recent", answer: "short")])
        let sent = try #require(phone.calledPromptTexts.first)
        #expect(sent.contains("Earlier in this conversation:") && sent.contains("recent") && !sent.contains("oldest"))
        #expect(sent.range(of: "recent")!.lowerBound < sent.range(of: "now")!.lowerBound)
    }

    @Test func anEmptyAnswerOrAnUnavailableModelIsAnErrorSoTheCallerFallsBack() async throws {
        await #expect(throws: EngineError.self) {
            _ = try await LocalAnswer.run(phone: MockPhoneEngine(answering: " \n "), prompts: try PromptLibrary(), task: .summary, raw: "hi")
        }
        await #expect(throws: EngineError.self) {
            _ = try await LocalAnswer.run(
                phone: MockPhoneEngine(answering: "x", availability: .appleIntelligenceNotEnabled), prompts: try PromptLibrary(), task: .summary, raw: "hi")
        }
    }
}
