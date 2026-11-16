import AirlockCore
import AirlockEngineMocks
import AirlockPrompts
import Foundation
import Testing

@testable import AirlockDetect

@Suite struct ChunkerTests {
    @Test func estimates() {
        #expect(Chunker.estimateTokens(String(repeating: "a", count: 320)) == 100)
        #expect(Chunker.estimateTokens(String(repeating: "漢", count: 180)) == 100)
    }

    @Test func coverageBudgetAndOverlapProperty() {
        var rng = SeededRNG(seed: 99)
        let words = ["The", "heater", "broke", "again", "and", "Raj", "said", "he", "would", "call", "tomorrow", "morning", "東京", "Привет"]
        for _ in 0..<300 {
            let sentences = (0..<Int.random(in: 1...40, using: &rng)).map { _ in
                (0..<Int.random(in: 1...30, using: &rng)).map { _ in words.randomElement(using: &rng)! }.joined(separator: " ") + "."
            }
            let text = sentences.joined(separator: " ")
            let budget = Int.random(in: 60...400, using: &rng)
            let chunks = Chunker.chunks(text, budgetTokens: budget)
            #expect(chunks.first?.span.start == 0)
            #expect(chunks.last?.span.end == text.utf16.count)
            for (a, b) in zip(chunks, chunks.dropFirst()) {
                #expect(b.span.start <= a.span.end, "gap between chunks")
                #expect(b.span.start > a.span.start, "no progress")
            }
            for c in chunks {
                #expect(Chunker.estimateTokens(c.text) <= budget, "chunk over budget")
                #expect(text.substring(utf16: c.span) == c.text, "offsets round-trip")
            }
        }
    }

    @Test func halvesNearTheMiddle() {
        let text = "one two three four five six seven eight"
        let c = Chunker.chunks(text, budgetTokens: 1000)[0]
        let halves = Chunker.halve(c, in: text)
        #expect(halves.count == 2)
        #expect(halves.map(\.text).joined() == text)
    }
}

@Suite struct LLMDetectorTests {
    let prompts: PromptLibrary

    init() throws {
        prompts = try PromptLibrary()
    }

    func detect(_ text: String, budget: Int = 1400, handler: @escaping MockPhoneEngine.Handler) async -> (
        LLMDetectionReport, MockPhoneEngine
    ) {
        let phone = MockPhoneEngine(handler: handler)
        let report = await LLMDetector(engine: phone, prompts: prompts, budgetTokens: budget).detect(in: text)
        return (report, phone)
    }

    let text = "Hi Raj, I work at Mercy General Hospital near the old mill."

    @Test func validJSON() async {
        let (r, phone) = await detect(text) { _, _ in
            #"{"items":[{"text":"Raj","type":"PERSON","role":"the writer's landlord","same_as":null,"confidence":"high"},{"text":"Mercy General Hospital","type":"ORG","role":"the writer's employer","confidence":"high"}]}"#
        }
        #expect(r.candidates.map(\.text) == ["Raj", "Mercy General Hospital"])
        #expect(r.candidates[0].roleHint == "the writer's landlord" && r.candidates[0].detector == .llm)
        #expect(phone.calledPromptIDs == ["detect.v1"])
        #expect(phone.calledPromptTexts[0].contains("Mercy General Hospital"), "chunk embedded in the prompt")
    }

    @Test func fencedJSONWithTrailingProse() async {
        let (r, _) = await detect(text) { _, _ in
            "Sure!\n```json\n{\"items\":[{\"text\":\"Raj\",\"type\":\"PERSON\"}]}\n```\nHope that helps {not json}."
        }
        #expect(r.candidates.map(\.text) == ["Raj"])
        #expect(r.isComplete)
    }

    @Test func hallucinatedSpansDropped() async {
        let (r, _) = await detect(text) { _, _ in #"{"items":[{"text":"Priya Shah","type":"PERSON"},{"text":"raj","type":"PERSON"}]}"# }
        #expect(r.hallucinatedDropped == 1)
        #expect(r.candidates.map(\.text) == ["Raj"], "case-insensitive fallback returns the text as written")
        for c in r.candidates { #expect(text.substring(utf16: c.span) == c.text) }
    }

    @Test func brokenJSONRepairedOnce() async {
        let (r, phone) = await detect(text) { id, _ in
            id == "detect.v1" ? #"{"items":[{"text":"Raj","type":"PERSON""# : #"{"items":[{"text":"Raj","type":"PERSON"}]}"#
        }
        #expect(phone.calledPromptIDs == ["detect.v1", "detect-repair.v1"])
        #expect(r.candidates.map(\.text) == ["Raj"] && r.repairsUsed == 1)
    }

    @Test func brokenTwiceMarksChunkFailed() async {
        let (r, phone) = await detect(text) { _, _ in "I can't do JSON today." }
        #expect(phone.calledPromptIDs == ["detect.v1", "detect-repair.v1"])
        #expect(r.failedChunks == [0] && r.candidates.isEmpty && !r.isComplete)
    }

    @Test func refusalReported() async {
        let (r, _) = await detect(text) { _, _ throws(EngineError) in throw .refused }
        #expect(r.refusedChunks == [0])
    }

    @Test func contextTooLongHalvesAndRetries() async {
        let calls = Counter()
        let (r, _) = await detect(text) { _, prompt throws(EngineError) in
            if calls.next() == 0 { throw .contextTooLong }
            return prompt.contains("Raj") ? #"{"items":[{"text":"Raj","type":"PERSON"}]}"# : #"{"items":[]}"#
        }
        #expect(r.candidates.map(\.text) == ["Raj"])
        #expect(calls.value == 3, "original + two halves")
    }

    @Test func unavailableSkipsTheModel() async {
        let phone = MockPhoneEngine(answering: "{}", availability: .appleIntelligenceNotEnabled)
        let r = await LLMDetector(engine: phone, prompts: prompts, budgetTokens: 1400).detect(in: text)
        #expect(r.unavailable == .appleIntelligenceNotEnabled)
        #expect(phone.calledPromptIDs.isEmpty)
    }

    @Test func multiChunkOffsetsAreGlobal() async {
        let long = (1...60).map { "Sentence \($0) mentions nobody at all here." }.joined(separator: " ") + " Finally Lena Okafor called."
        let (r, _) = await detect(long, budget: 120) { _, prompt in
            prompt.contains("Lena Okafor") ? #"{"items":[{"text":"Lena Okafor","type":"PERSON"}]}"# : #"{"items":[]}"#
        }
        #expect(r.chunkCount > 3)
        #expect(r.candidates.count == 1)
        #expect(long.substring(utf16: r.candidates[0].span) == "Lena Okafor")
    }

    @Test func nlTaggerFindsNames() {
        let found = NLDetector.detect(in: "Yesterday Tim Cook visited Paris with Apple.")
        #expect(found.allSatisfy { $0.detector == .nl && $0.confidence == .medium })
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func next() -> Int {
        lock.withLock {
            defer { n += 1 }; return n
        }
    }
    var value: Int { lock.withLock { n } }
}
