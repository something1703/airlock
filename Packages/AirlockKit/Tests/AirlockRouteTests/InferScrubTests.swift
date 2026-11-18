import AirlockCore
import AirlockEngineMocks
import AirlockLedger
import AirlockPrompts
import AirlockRestore
import Foundation
import Testing

@testable import AirlockRoute

/// F-25 and F-27 — the native twin of `web/tests/infer-scrub.test.ts`.
@Suite struct CloudInferenceTests {
    @Test func usesTheVersionedPromptWithoutTheQuotedBlock() throws {
        let t = try CloudInference.task(prompts: try PromptLibrary())
        #expect(t.id == "infer.v1")
        #expect(t.instruction.hasPrefix("Without guessing any real names"))
        #expect(!t.instruction.contains("<<<") && !t.instruction.contains(">>>"))
        #expect(t.instruction.contains(#""inferences""#))
    }

    @Test func parsingIsLenientAboutWrappersStrictAboutShapeSortedByConfidence() {
        let r = CloudInference.parse(
            #"Sure!\n```json\n{"inferences":[{"attribute":"age","value":"30s","confidence":"low"},{"attribute":"job","value":"nurse","confidence":"HIGH","evidence":"night shifts"},{"value":"no attribute"},{"attribute":"who","value":"[[PERSON_1]]","confidence":"high"},{"attribute":"town","value":"near {the} river","confidence":"medium"}]}\n```"#
        )
        #expect(!r.unreadable)
        #expect(r.inferences.map(\.attribute) == ["job", "town", "age"])
        #expect(r.inferences.map(\.confidence) == [.high, .medium, .low])
        #expect(r.inferences.first?.evidence == "night shifts")
        #expect(CloudInference.parse("I can't help with that").unreadable)
        #expect(CloudInference.parse(#"{"inferences":"nope"}"#).unreadable)
        #expect(CloudInference.parse(#"{"inferences":[]}"#) == ([], false))
    }

    @Test func unknownConfidenceIsLowAndAtMostEightItemsAreKept() {
        let items = (0..<12).map { #"{"attribute":"a\#($0)","value":"v\#($0)","confidence":"\#($0 == 11 ? "high" : "sure")"}"# }
        let r = CloudInference.parse(#"{"inferences":[\#(items.joined(separator: ","))]}"#)
        #expect(r.inferences.count == CloudInference.maxItems)
        #expect(r.inferences.first?.attribute == "a11")
        #expect(r.inferences.dropFirst().allSatisfy { $0.confidence == .low })
    }

    @Test func resendsExactlyTheSealedTextAndWritesAMatchingReceipt() async throws {
        let sealed = try sealedMessage()
        let ledger = ReceiptLedger()
        // The original answer's receipt.
        let first = await ledger.append(
            sealed: sealed, threadId: "t", route: .cloudFirst, modelVersion: "gemini-demo", armor: .notConfigured, sealLatency: .zero,
            networkLatency: .zero)
        let cloud = MockSealedEngine(route: .cloudOnly, modelVersion: "gemini-demo") { _, task in
            #expect(task.id == "infer.v1")
            return #"{"inferences":[{"attribute":"situation","value":"Renting with a broken heater","confidence":"high","evidence":"the heater"}]}"#
        }
        let r = try await CloudInference.run(
            engines: MockEngines(sealed: [.cloudOnly: cloud]), prompts: try PromptLibrary(), ledger: ledger, sealed: sealed, threadId: "t")
        #expect(cloud.received == [sealed], "only the sealed text that already left")
        #expect(r.inferences.map(\.attribute) == ["situation"] && !r.unreadable)
        #expect(r.receipt.seq == first.seq + 1 && r.receipt.route == .cloudOnly)
        #expect(r.receipt.outboundSha256 == first.outboundSha256, "identical outbound text: nothing new left")
        #expect(r.receipt.outboundText == first.outboundText)
        for raw in ["Raj", "Maya"] { #expect(!(r.receipt.outboundText ?? "").contains(raw)) }
        #expect(await ledger.verify() == .valid(count: 2))
    }

    @Test func armorBlockStillWritesABlockedReceipt() async throws {
        let blocked = MockSealedEngine(route: .cloudOnly) { _, _ throws(EngineError) in throw .armorBlocked }
        let ledger = ReceiptLedger()
        await #expect(throws: EngineError.armorBlocked) {
            _ = try await CloudInference.run(
                engines: MockEngines(sealed: [.cloudOnly: blocked]), prompts: try PromptLibrary(), ledger: ledger, sealed: try sealedMessage(),
                threadId: "t")
        }
        #expect(await ledger.receipts.map(\.armor) == [.blocked])
    }

    @Test func otherFailuresWriteNoReceipt() async throws {
        let offline = MockSealedEngine(route: .cloudOnly) { _, _ throws(EngineError) in throw .offline }
        let ledger = ReceiptLedger()
        await #expect(throws: EngineError.offline) {
            _ = try await CloudInference.run(
                engines: MockEngines(sealed: [.cloudOnly: offline]), prompts: try PromptLibrary(), ledger: ledger, sealed: try sealedMessage(),
                threadId: "t")
        }
        #expect(await ledger.receipts.isEmpty)
    }
}

@Suite struct ScrubCopyTests {
    @Test func clipboardTextIsExactlyWhatAReceiptWouldRecord() async throws {
        let sealed = try sealedMessage()
        let receipt = await ReceiptLedger().append(
            sealed: sealed, threadId: "t", route: .cloudOnly, modelVersion: "x", armor: .notConfigured, sealLatency: .zero, networkLatency: .zero)
        let copied = ScrubCopy.clipboardText(sealed)
        #expect(copied == receipt.outboundText)
        #expect(copied.contains("[[PERSON_1]]") && copied.contains("[[PERSON_1]] — the user's landlord"))
        for raw in ["Raj", "Maya"] { #expect(!copied.contains(raw)) }
        let bare = try sealedMessage("The heater is still broken.")
        #expect(ScrubCopy.clipboardText(bare) == "The heater is still broken.")
    }

    @Test func pastedAnswerIsRestoredLocally() throws {
        let ctx = RestoreContext(entities: EntityMap([raj, me]), userFirstName: "Maya", writingAsUser: true)
        let r = try #require(ScrubCopy.restorePasted("Dear [[PERSON_1]], please fix the heater. Regards, [[PERSON_ME]]", context: ctx))
        #expect(r.text == "Dear Raj Patel, please fix the heater. Regards, Maya")
        #expect(ScrubCopy.restorePasted("  \n ", context: ctx) == nil)
    }
}
