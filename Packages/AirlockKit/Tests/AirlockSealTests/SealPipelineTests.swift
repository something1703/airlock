import AirlockCore
import AirlockDetect
import AirlockEngineMocks
import AirlockPrompts
import Foundation
import Testing

@testable import AirlockSeal

final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [SealProgress] = []
    func add(_ p: SealProgress) { lock.withLock { items.append(p) } }
    var all: [SealProgress] { lock.withLock { items } }
}

@Suite struct SealPipelineTests {
    let raw =
        "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. I work nights at Mercy General Hospital. Thanks, Maya Chen"
    let vault = [
        VaultEntry(id: "v-me", canonical: "Maya Chen", aliases: ["Maya"], category: .person, roleHint: "me", isUser: true),
        VaultEntry(id: "v-raj", canonical: "Raj Patel", aliases: ["Raj"], category: .person, roleHint: "my landlord"),
    ]

    func pipeline(_ phone: MockPhoneEngine, dial: DialPreset = .balanced) throws -> SealPipeline {
        SealPipeline(
            phone: phone, patterns: fixturePatterns, vault: vault, prompts: try PromptLibrary(),
            settings: SealSettings(dial: dial, nlTaggerEnabled: false, today: utcDate("2026-11-21")))
    }

    static let detectAnswer =
        #"{"items":[{"text":"Mercy General Hospital","type":"ORG","role":"the writer's employer","confidence":"high"}]}"#
    static let noGuesses = #"{"guesses":[]}"#

    /// detect.v1 → Mercy General; gen.v1 → `rewrite`; attack.v1 → `attack`.
    static func phone(rewrite: String = "a large hospital", attack: String = noGuesses) -> MockPhoneEngine {
        MockPhoneEngine { id, text in
            switch id {
            case "gen.v1" where text.contains("Phrase to rewrite: Mercy General Hospital") && rewrite == "in the area":
                #"{"rewrite":"a large hospital"}"#
            case "gen.v1": "{\"rewrite\":\"\(rewrite)\"}"
            case "attack.v1": attack
            default: detectAnswer
            }
        }
    }

    @Test func happyPathUsesValidatedOnDeviceRewrite() async throws {
        let phone = Self.phone()
        let progress = ProgressLog()
        let r = await try pipeline(phone).run(RawText(raw, source: .paste)) { progress.add($0) }
        #expect(
            r.draft.text
                == "Hi [[PERSON_1]], the heater at [[LOC_1]] has been broken since Oct 28. I work nights at a large hospital. Thanks, [[PERSON_ME]]"
        )
        #expect(phone.calledPromptIDs == ["detect.v1", "gen.v1", "attack.v1"])
        #expect(progress.all.contains(.detecting(section: 1, of: 1)) && progress.all.last == .done)
        #expect(!r.requiresReview, "balanced, all high confidence, no risks")
        _ = try EgressGate(patterns: fixturePatterns, vault: vault).seal(r.draft)
    }

    /// FX-02: timings count calls per stage and add up; no model → no calls and no first reply.
    @Test func timingsCountCallsPerStage() async throws {
        let r = await try pipeline(Self.phone()).run(RawText(raw, source: .paste))
        let t = r.timings
        let counts: [Int] = [t.detectCalls, t.repairCalls, t.generaliseCalls, t.redTeamCalls]
        #expect(counts == [1, 0, 1, 1])
        #expect(t.firstModelOutput != nil)
        let stages: Duration = t.rules + t.detect + t.generalise + t.redTeam
        #expect(stages <= t.total)
        #expect(t.total == r.sealDuration)

        let off = await try pipeline(MockPhoneEngine(answering: Self.detectAnswer, availability: .appleIntelligenceNotEnabled), dial: .open)
            .run(RawText(raw, source: .paste))
        #expect(off.timings.detectCalls + off.timings.generaliseCalls + off.timings.redTeamCalls == 0)
        #expect(off.timings.firstModelOutput == nil)
    }

    @Test func leakyRewriteFallsBackToLadder() async throws {
        let phone = Self.phone(rewrite: "the Mercy General campus")
        let r = await try pipeline(phone).run(RawText(raw, source: .paste))
        #expect(r.draft.text.contains("I work nights at an organisation."))
        #expect(!r.draft.text.contains("Mercy"))
    }

    /// INV-9: no on-device model → rules only, mandatory review, and nothing but the phone engine exists to call.
    @Test func unavailablePhoneForcesReviewAndStillSeals() async throws {
        let phone = MockPhoneEngine(answering: Self.detectAnswer, availability: .appleIntelligenceNotEnabled)
        let r = await try pipeline(phone, dial: .open).run(RawText(raw, source: .paste))
        #expect(phone.calledPromptIDs.isEmpty, "the model is never asked")
        #expect(r.requiresReview)
        #expect(r.reasons.contains(.phoneUnavailable(.appleIntelligenceNotEnabled)))
        #expect(r.draft.text.contains("[[PERSON_1]]") && r.draft.text.contains("[[LOC_1]]") && r.draft.text.contains("[[PERSON_ME]]"))
        _ = try EgressGate(patterns: fixturePatterns, vault: vault).seal(r.draft)
    }

    @Test func refusalForcesReview() async throws {
        let phone = MockPhoneEngine { _, _ throws(EngineError) in throw .refused }
        let r = await try pipeline(phone).run(RawText(raw, source: .paste))
        #expect(r.requiresReview && r.reasons.contains(.refused(chunks: [0])))
    }

    @Test func strictAlwaysReviewsAndOverridesReseal() async throws {
        let phone = Self.phone()
        let p = try pipeline(phone, dial: .strict)
        let r = await p.run(RawText(raw, source: .paste))
        #expect(r.requiresReview)
        let callsBefore = phone.calledPromptIDs.count
        let raj = try #require(r.merge.entities.sorted.first { $0.vaultEntryID == "v-raj" })
        let revealed = await p.reseal(r, overrides: [raj.id: UserOverride(action: .keep, revealThisTime: true)])
        #expect(revealed.draft.text.hasPrefix("Hi Raj,"))
        #expect(phone.calledPromptIDs.count == callsBefore, "reseal never re-runs the model")
    }

    @Test func secretsForceReview() async throws {
        let phone = MockPhoneEngine { id, _ in id == "attack.v1" ? Self.noGuesses : #"{"items":[]}"# }
        let r = await try pipeline(phone, dial: .open).run(RawText("Your verification code is 482913.", source: .paste))
        #expect(r.requiresReview && r.reasons.contains(.secretsFound))
        #expect(r.draft.text == "Your verification code is [[SECRET_1]].")
    }

    // MARK: Red-team in the pipeline

    static let townGuess =
        #"{"guesses":[{"attribute":"location","guess":"lives in a small town","evidence":"near the old mill","confidence":"medium"}]}"#
    let townRaw = "Hi Raj, I work nights at Mercy General Hospital near the old mill. Thanks, Maya Chen"

    @Test func balancedReturnsRiskCardsAndForcesReview() async throws {
        let phone = Self.phone(rewrite: "in the area", attack: Self.townGuess)
        let r = await try pipeline(phone).run(RawText(townRaw, source: .paste))
        #expect(r.risks.count == 1 && r.risks[0].suggestion == "in the area")
        #expect(r.draft.text.contains("near the old mill"), "Balanced never rewrites on its own")
        #expect(r.requiresReview && r.reasons.contains(.risks(count: 1)))

        // "Use suggestion" in Review → reseal applies it, no extra model calls.
        let calls = phone.calledPromptIDs.count
        let p = try pipeline(phone)
        let accepted = await p.reseal(r, overrides: [:], acceptedRisks: r.risks)
        #expect(accepted.draft.text.contains("at a large hospital in the area."))
        #expect(!accepted.reasons.contains(.risks(count: 1)))
        #expect(phone.calledPromptIDs.count == calls)
        let sealed = try EgressGate(patterns: fixturePatterns, vault: vault).seal(accepted.draft)
        #expect(sealed.gateReport.counts["redteamApplied"] == 1)
    }

    @Test func strictAutoApplies() async throws {
        let phone = Self.phone(rewrite: "in the area", attack: Self.townGuess)
        let r = await try pipeline(phone, dial: .strict).run(RawText(townRaw, source: .paste))
        #expect(r.draft.text.contains("in the area") && !r.draft.text.contains("old mill"))
        #expect(r.acceptedRisks.count == 1 && r.pendingRisks.isEmpty)
        _ = try EgressGate(patterns: fixturePatterns, vault: vault).seal(r.draft)
    }

    @Test func unparseableAttackMarksRedTeamUnavailable() async throws {
        let phone = Self.phone(attack: "no json, sorry")
        let r = await try pipeline(phone).run(RawText(townRaw, source: .paste))
        #expect(r.redTeamUnavailable && r.requiresReview && r.reasons.contains(.redTeamUnavailable))
    }

    @Test func openDialSkipsRedTeam() async throws {
        let phone = Self.phone(attack: Self.townGuess)
        _ = await try pipeline(phone, dial: .open).run(RawText(townRaw, source: .paste))
        #expect(!phone.calledPromptIDs.contains("attack.v1"))
    }
}
