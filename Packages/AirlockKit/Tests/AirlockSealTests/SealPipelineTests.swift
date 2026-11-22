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

    /// FX-02 detect.v2: the model's general phrase is used (no gen.v1); bad ones fall back to the fixed phrase.
    @Test func detectV2UsesTheModelsGeneralPhrase() async throws {
        func pipe(_ p: MockPhoneEngine) throws -> SealPipeline {
            SealPipeline(
                phone: p, patterns: fixturePatterns, vault: vault, prompts: try PromptLibrary(),
                settings: SealSettings(dial: .balanced, nlTaggerEnabled: false, today: utcDate("2026-11-21"), detectPromptID: "detect.v2"))
        }
        let good = MockPhoneEngine { id, _ in
            id == "detect.v2" ? "ORG | Mercy General Hospital | employer | a large hospital\nEND" : id == "attack.v1" ? Self.noGuesses : "{}"
        }
        let r = await try pipe(good).run(RawText(raw, source: .paste))
        #expect(good.calledPromptIDs == ["detect.v2", "attack.v1"])
        #expect(r.draft.text.contains("I work nights at a large hospital."))
        #expect(r.timings.generaliseCalls == 0)
        for bad in ["Mercy General campus", "Works nights at a big hospital downtown today."] {
            let p = MockPhoneEngine { id, _ in
                id == "detect.v2" ? "ORG | Mercy General Hospital | employer | \(bad)\nEND" : id == "attack.v1" ? Self.noGuesses : "{}"
            }
            let r = await try pipe(p).run(RawText(raw, source: .paste))
            #expect(!p.calledPromptIDs.contains("gen.v1"), "\(bad)")
            #expect(r.draft.text.contains("I work nights at an organisation."), "\(bad)")
        }
        let none = MockPhoneEngine { id, _ in
            id == "detect.v2" ? "ORG | Mercy General Hospital | employer | -\nEND" : id == "gen.v1" ? #"{"rewrite":"a large hospital"}"# : Self.noGuesses
        }
        let r3 = await try pipe(none).run(RawText(raw, source: .paste))
        #expect(none.calledPromptIDs == ["detect.v2", "gen.v1", "attack.v1"])
        #expect(r3.draft.text.contains("a large hospital"))
    }

    @Test func plausibleGeneralShapeCheck() {
        for g in ["a large hospital", "a nearby street", "a chronic condition"] {
            #expect(Generaliser.plausibleGeneral(g, replacing: "Mercy General Hospital"), "\(g)")
        }
        #expect(!Generaliser.plausibleGeneral("Two-week turnaround required for repairs.", replacing: "14 days"))
        #expect(!Generaliser.plausibleGeneral("a very large and busy teaching hospital in town", replacing: "Mercy General"))
        #expect(!Generaliser.plausibleGeneral("a [[ORG_1]] clinic", replacing: "Mercy"))
        #expect(!Generaliser.plausibleGeneral("The hospital", replacing: "mercy"))
        #expect(Generaliser.plausibleGeneral("The hospital", replacing: "Mercy"))
        #expect(!Generaliser.plausibleGeneral("", replacing: "Mercy"))
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

    /// FX-02: rule hits are reported before the first model call, longest span wins, distinct details counted once.
    @Test func rulesReadyComesBeforeTheFirstModelCall() async throws {
        let phone = Self.phone()
        let events = ProgressLog()
        _ = await try pipeline(phone).run(RawText(raw, source: .paste)) { events.add($0) }
        guard case .rulesReady(let preview)? = events.all.first else {
            Issue.record("rulesReady must be the first progress event")
            return
        }
        let ns = preview.text as NSString
        let found = preview.spans.map { ns.substring(with: NSRange(location: $0.span.start, length: $0.span.end - $0.span.start)) }
        #expect(found.contains("Raj") && found.contains("Maya Chen"))
        #expect(!found.contains("Mercy General Hospital"), "only the model finds the hospital")
    }

    @Test func rulesPreviewKeepsLongestOverlapAndCountsDistinct() {
        let text = "Raj Patel and raj and Raj"
        func c(_ s: Int, _ e: Int) -> Candidate {
            Candidate(span: TextSpan(start: s, end: e), text: "", category: .person, detector: .vault, confidence: .high)
        }
        let p = RulesPreview(text: text, candidates: [c(0, 3), c(0, 9), c(14, 17), c(22, 25)])
        let ns = text as NSString
        #expect(p.spans.map { ns.substring(with: NSRange(location: $0.span.start, length: $0.span.end - $0.span.start)) } == ["Raj Patel", "raj", "Raj"])
        #expect(p.count == 2)
        #expect(RulesPreview(text: "nothing here", candidates: []).count == 0)
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

    /// A phone that behaves like `base` but holds the red-team's attack call until `gate` is released.
    fileprivate static func gated(_ base: MockPhoneEngine, by gate: Gate) -> MockPhoneEngine {
        MockPhoneEngine { (id: String, text: String) async throws(EngineError) -> String in
            if id == "attack.v1" { await gate.wait() }
            return try await base.respond(PhonePrompt(promptID: id, text: text), options: .analysis).text
        }
    }

    /// FX-02: Balanced shows the draft before the red-team finishes; the risk cards arrive with the late result.
    @Test func stagedBalancedShowsTheDraftFirst() async throws {
        let gate = Gate()
        let base = Self.phone(rewrite: "in the area", attack: Self.townGuess)
        let phone = Self.gated(base, by: gate)
        let (early, later) = await try pipeline(phone).runStaged(RawText(townRaw, source: .paste))
        #expect(early.redTeamPending)
        #expect(early.risks.isEmpty && early.draft.text.contains("a large hospital"))
        #expect(early.timings.redTeamCalls == 0)
        let task = try #require(later)
        await gate.release()
        let full = await task.value
        #expect(!full.redTeamPending)
        #expect(full.risks.count == 1 && full.acceptedRisks.isEmpty)
        #expect(full.draft.text == early.draft.text)
        #expect(full.reasons.contains(.risks(count: 1)))
        #expect(full.timings.redTeamCalls > 0)
    }

    /// FX-02: Strict also shows the draft first; its rewrites arrive with the late result, and Review stays mandatory.
    @Test func stagedStrictShowsTheDraftFirstAndRewritesArriveLater() async throws {
        let gate = Gate()
        let base = Self.phone(rewrite: "in the area", attack: Self.townGuess)
        let phone = Self.gated(base, by: gate)
        let (early, later) = await try pipeline(phone, dial: .strict).runStaged(RawText(townRaw, source: .paste))
        #expect(early.redTeamPending && early.requiresReview)
        #expect(early.draft.text.contains("near the old mill") && early.acceptedRisks.isEmpty)
        let task = try #require(later)
        await gate.release()
        let full = await task.value
        #expect(!full.redTeamPending)
        #expect(full.draft.text.contains("in the area") && !full.draft.text.contains("old mill"))
        #expect(full.acceptedRisks.count == 1 && full.pendingRisks.isEmpty)
        _ = try EgressGate(patterns: fixturePatterns, vault: vault).seal(full.draft)
    }

    /// A chip toggled while the check runs keeps the pending flag, so Send stays locked.
    @Test func resealKeepsThePendingFlag() async throws {
        let gate = Gate()
        let base = Self.phone(rewrite: "in the area", attack: Self.townGuess)
        let phone = Self.gated(base, by: gate)
        let p = try pipeline(phone)
        let (early, later) = await p.runStaged(RawText(townRaw, source: .paste))
        let touched = await p.reseal(early, overrides: [:])
        #expect(touched.redTeamPending)
        await gate.release()
        _ = await later?.value
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


/// Holds a model call until the test lets it go.
fileprivate actor Gate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if open { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        open = true
        for w in waiters { w.resume() }
        waiters = []
    }
}
