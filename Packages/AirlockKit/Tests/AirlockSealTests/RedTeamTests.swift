import AirlockCore
import AirlockDetect
import AirlockEngineMocks
import AirlockPrompts
import Foundation
import Testing

@testable import AirlockSeal

@Suite struct RedTeamTests {
    let prompts: PromptLibrary
    let org = Entity(
        id: PlaceholderID(category: .org, number: 1), category: .org, canonical: "Harbor View Clinic", surfaceForms: ["Harbor View Clinic"],
        action: .generalise(level: 2), generalisedText: "a clinic", sources: [.llm], confidence: .high)
    let person = Entity(
        id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: ["Raj Patel", "Raj"],
        sources: [.vault], confidence: .high)

    init() throws {
        prompts = try PromptLibrary()
    }

    func draft(_ text: String) -> SealDraft {
        SealDraft(
            text: text, legend: [LegendLine(placeholder: person.id, description: "the user's landlord")], replacements: [],
            entities: EntityMap([person, org]), secretWarnings: [], revealedVaultIDs: [], keptValues: [])
    }

    func team(attack: @escaping @Sendable (Int) -> String, rewrite: @escaping @Sendable (String) -> String) -> (RedTeam, MockPhoneEngine) {
        let attacks = Counter()
        let phone = MockPhoneEngine { id, text in
            switch id {
            case "attack.v1": return attack(attacks.next())
            case "gen.v1":
                let phrase = text.components(separatedBy: "Phrase to rewrite: ").last?.components(separatedBy: "\n").first ?? ""
                return "{\"rewrite\":\"\(rewrite(phrase))\"}"
            default: return "{}"
            }
        }
        return (RedTeam(phone: phone, prompts: prompts, patterns: fixturePatterns), phone)
    }

    static func guesses(_ items: [(String, String, String)]) -> String {
        let body = items.map { #"{"attribute":"\#($0.0)","guess":"g","evidence":"\#($0.1)","confidence":"\#($0.2)"}"# }.joined(
            separator: ",")
        return #"{"guesses":[\#(body)]}"#
    }

    let text = "I'm the only night nurse at a clinic near the old mill, and [[PERSON_1]] keeps calling."

    @Test func filtersGuesses() async {
        let (rt, _) = team(
            attack: { _ in
                Self.guesses([
                    ("location", "near the old mill", "medium"),  // kept
                    ("occupation", "night nurse", "low"),  // low confidence
                    ("location", "the lighthouse", "high"),  // not in the draft
                    ("hobby", "keeps calling", "high"),  // unknown attribute
                    ("identity", "[[PERSON_1]]", "high"),  // only a placeholder
                ])
            }, rewrite: { _ in "in the area" })
        let r = await rt.run(draft(text), mode: .suggest, maxRounds: 2, taskSummary: "help")
        #expect(r.risks.map(\.evidence) == ["near the old mill"])
        #expect(r.risks[0].suggestion == "in the area")
        #expect(r.rounds == 1 && r.draft.text == text, "suggest mode: one round, draft untouched")
    }

    @Test func capsAtSix() async {
        let words = (1...9).map { "detail\($0)" }
        let t = words.joined(separator: " ")
        let (rt, _) = team(attack: { _ in Self.guesses(words.map { ("event", $0, "high") }) }, rewrite: { _ in "something" })
        let r = await rt.run(draft(t), mode: .suggest, maxRounds: 1, taskSummary: "help")
        #expect(r.risks.count == RedTeam.maxRisksPerRound)
    }

    @Test func rejectsLeakyOrPlaceholderChangingSuggestions() async {
        let t = "[[PERSON_1]]'s office at the old mill, on the night shift."
        let (rt, _) = team(
            attack: { _ in
                Self.guesses([("location", "[[PERSON_1]]'s office at the old mill", "high"), ("occupation", "the night shift", "high")])
            },
            rewrite: { phrase in phrase.contains("mill") ? "an office near Harbor View" : "evenings" })
        let r = await rt.run(draft(t), mode: .suggest, maxRounds: 1, taskSummary: "help")
        let byEvidence = Dictionary(uniqueKeysWithValues: r.risks.map { ($0.evidence, $0.suggestion) })
        #expect(byEvidence["[[PERSON_1]]'s office at the old mill"] == .some(nil), "drops the placeholder and leaks 'Harbor View'")
        #expect(byEvidence["the night shift"] == "evenings")

        #expect(
            RedTeam.isValid(
                "[[PERSON_1]]'s office", replacing: "[[PERSON_1]]'s office at the old mill", entities: EntityMap([person, org]),
                patterns: fixturePatterns))
        #expect(
            !RedTeam.isValid(
                "[[PERSON_2]]'s office", replacing: "[[PERSON_1]]'s office at the old mill", entities: EntityMap([person, org]),
                patterns: fixturePatterns))
    }

    @Test func strictAppliesAndRunsSecondRound() async {
        let (rt, phone) = team(
            attack: { n in
                n == 0
                    ? Self.guesses([("location", "near the old mill", "high")])
                    : Self.guesses([("occupation", "the only night nurse", "high")])
            },
            rewrite: { phrase in phrase.contains("mill") ? "in the area" : "a nurse" })
        let r = await rt.run(draft(text), mode: .autoApply, maxRounds: 2, taskSummary: "help")
        #expect(r.rounds == 2)
        #expect(r.draft.text == "I'm a nurse at a clinic in the area, and [[PERSON_1]] keeps calling.")
        #expect(r.applied.count == 2)
        #expect(Set(phone.calledPromptIDs) == ["attack.v1", "gen.v1"], "phone only ever sees attack/gen")
        let sealed = try? EgressGate(patterns: fixturePatterns, vault: []).seal(r.draft)
        #expect(sealed?.gateReport.counts["redteamApplied"] == 2)
    }

    @Test func strictStopsWhenNothingLeft() async {
        let (rt, phone) = team(attack: { _ in #"{"guesses":[]}"# }, rewrite: { _ in "x" })
        let r = await rt.run(draft(text), mode: .autoApply, maxRounds: 2, taskSummary: "help")
        #expect(r.rounds == 1 && r.risks.isEmpty && phone.calledPromptIDs == ["attack.v1"])
    }

    @Test func offMakesNoCalls() async {
        let (rt, phone) = team(attack: { _ in "" }, rewrite: { _ in "" })
        let r = await rt.run(draft(text), mode: .off, maxRounds: 2, taskSummary: "help")
        #expect(phone.calledPromptIDs.isEmpty && r.risks.isEmpty && !r.unavailable)
    }

    @Test func failuresMarkUnavailable() async {
        for phone in [
            MockPhoneEngine(answering: "x", availability: .modelNotReady),
            MockPhoneEngine { _, _ throws(EngineError) in throw .refused },
            MockPhoneEngine(answering: "no json"),
        ] {
            let r = await RedTeam(phone: phone, prompts: prompts, patterns: fixturePatterns).run(
                draft(text), mode: .suggest, maxRounds: 2, taskSummary: "h")
            #expect(r.unavailable && r.draft.text == text)
        }
    }

    @Test func applyIsDeterministicIdempotentAndSkipsMissing() {
        let risks = [
            Risk(id: 1, attribute: .location, guess: "", evidence: "near the old mill", confidence: .high, suggestion: "in the area"),
            Risk(id: 2, attribute: .event, guess: "", evidence: "the lighthouse fire", confidence: .high, suggestion: "a fire"),
            Risk(id: 3, attribute: .occupation, guess: "", evidence: "night nurse", confidence: .high, suggestion: nil),
        ]
        let once = RedTeam.apply(risks, to: draft(text))
        #expect(once.text == "I'm the only night nurse at a clinic in the area, and [[PERSON_1]] keeps calling.")
        #expect(RedTeam.apply(risks, to: once).text == once.text)
        #expect(once.replacements.filter { $0.kind == .redteam }.count == 1)
        for r in once.replacements { #expect(once.text.substring(utf16: r.sealedSpan) != nil) }
    }

    @Test func applyShiftsExistingReplacements() {
        let base = SealDraft(
            text: "near the old mill, [[PERSON_1]] called.", legend: [],
            replacements: [
                Replacement(
                    normalisedSpan: TextSpan(start: 0, end: 3), sealedSpan: TextSpan(start: 19, end: 31), entityID: person.id,
                    kind: .placeholder)
            ], entities: EntityMap([person]), secretWarnings: [], revealedVaultIDs: [], keptValues: [])
        let out = RedTeam.apply(
            [Risk(id: 1, attribute: .location, guess: "", evidence: "near the old mill", confidence: .high, suggestion: "nearby")], to: base
        )
        let placeholder = out.replacements.first { $0.kind == .placeholder }
        #expect(placeholder.flatMap { out.text.substring(utf16: $0.sealedSpan) } == "[[PERSON_1]]")
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
}
