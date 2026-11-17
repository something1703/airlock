import AirlockCore
import AirlockDetect
import AirlockRestore
import Foundation
import Testing

@testable import AirlockSeal

// MARK: - Fixture helpers

func parseAction(_ s: String) -> Action {
    if s.hasPrefix("generalise:"), let n = Int(s.dropFirst("generalise:".count)) { return .generalise(level: n) }
    switch s {
    case "keep": return .keep
    case "block": return .block
    default: return .placeholder
    }
}

func actionString(_ a: Action) -> String {
    switch a {
    case .placeholder: "placeholder"
    case .keep: "keep"
    case .block: "block"
    case .generalise(let l): "generalise:\(l)"
    }
}

struct FEntity: Decodable {
    let id, category, canonical: String
    let surfaceForms: [String]
    let action: String
    let vaultEntryId: String?
    var entity: Entity {
        Entity(
            id: PlaceholderID(string: id)!, category: PrivacyCategory(rawValue: category)!, canonical: canonical,
            surfaceForms: Set(surfaceForms), action: parseAction(action), sources: [.llm], confidence: .high, vaultEntryID: vaultEntryId)
    }
}

struct FVault: Decodable {
    let id, canonical, category: String
    let aliases: [String]
    let roleHint: String?
    let isUser: Bool
    var entry: VaultEntry {
        VaultEntry(
            id: id, canonical: canonical, aliases: aliases, category: PrivacyCategory(rawValue: category)!, roleHint: roleHint,
            isUser: isUser)
    }
}

let fixturePatterns: PatternDetector = {
    // Data detectors off: conformance must match the web/Android engines.
    guard let d = try? PatternDetector.bundled(useDataDetectors: false) else { fatalError("pattern packs failed to load") }
    return d
}()

func utcDate(_ s: String) -> Date {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: s)!
}

// MARK: - Policy

struct PolicyFixture: Decodable {
    struct Override: Decodable { let action: String; let revealThisTime: Bool }
    struct Case: Decodable {
        let dial, category, canonical, expected: String
        let subtype: String?
        let vault, protectHealth: Bool
        let override: Override?
    }
    let cases: [Case]
}

@Suite struct PolicyTests {
    @Test func sharedFixture() throws {
        let f = try fixture("policy.json", as: PolicyFixture.self)
        #expect(f.cases.count >= 40)
        for c in f.cases {
            let engine = PolicyEngine(dial: DialPreset(rawValue: c.dial)!, settings: PolicySettings(protectHealth: c.protectHealth))
            let category = PrivacyCategory(rawValue: c.category)!
            let id: PlaceholderID = category == .quasi ? .me : PlaceholderID(category: category, number: 1)
            let e = Entity(
                id: id, category: category, canonical: c.canonical, surfaceForms: [], sources: [.llm], confidence: .high,
                subtype: c.subtype, vaultEntryID: c.vault ? "v" : nil)
            let o = c.override.map { UserOverride(action: parseAction($0.action), revealThisTime: $0.revealThisTime) }
            #expect(
                actionString(engine.action(for: e, override: o)) == c.expected,
                "\(c.dial) \(c.category)/\(c.subtype ?? "-") override=\(String(describing: c.override))")
        }
    }

    @Test func modesPerDial() {
        #expect(PolicyEngine(dial: .open).redTeamMode == .off)
        #expect(PolicyEngine(dial: .balanced).reviewMode == .ifLowConfidenceOrRisk)
        #expect(PolicyEngine(dial: .strict).reviewMode == .always && PolicyEngine(dial: .strict).bucketsMoney)
    }
}

// MARK: - Generaliser and money

@Suite struct GeneraliserTests {
    let today = utcDate("2026-11-21")

    @Test func agesFromDOB() {
        let dob = Entity(
            id: PlaceholderID(category: .date, number: 1), category: .date, canonical: "4 Mar 1989", surfaceForms: [], sources: [.pattern],
            confidence: .high, subtype: "dob")
        #expect(Generaliser.ladderDefault(for: dob, level: 2, today: today) == "late 30s")
        #expect(Generaliser.ladderDefault(for: dob, level: 3, today: today) == "30s")
        let teen = Entity(
            id: PlaceholderID(category: .date, number: 2), category: .date, canonical: "2010-05-01", surfaceForms: [], sources: [.pattern],
            confidence: .high, subtype: "dob")
        #expect(Generaliser.ladderDefault(for: teen, level: 2, today: today) == "a teenager")
    }

    @Test func relativeDates() {
        let cases: [(String, String)] = [
            ("Oct 28", "3 weeks ago"), ("2026-11-20", "yesterday"), ("21/11/2026", "today"),
            ("Dec 5, 2026", "in 2 weeks"), ("2025-11-21", "about 1 year ago"), ("not a date", "a recent date"),
        ]
        for (raw, expected) in cases {
            let e = Entity(
                id: PlaceholderID(category: .date, number: 1), category: .date, canonical: raw, surfaceForms: [], sources: [.pattern],
                confidence: .high, subtype: "date")
            #expect(Generaliser.ladderDefault(for: e, level: 1, today: today) == expected, "\(raw)")
        }
    }

    @Test func validationRules() {
        let map = EntityMap([
            Entity(
                id: PlaceholderID(category: .org, number: 1), category: .org, canonical: "Mercy General Hospital",
                surfaceForms: ["Mercy General"], action: .generalise(level: 2), sources: [.llm], confidence: .high)
        ])
        let ok = { (r: String) in Generaliser.validate(r, replacing: "Mercy General Hospital", entities: map, patterns: fixturePatterns) }
        #expect(ok("a large hospital"))
        #expect(!ok(""))
        #expect(!ok("a very large and busy teaching hospital in the city centre"))
        #expect(!ok("Mercy General Hospital"))
        #expect(!ok("the Mercy General campus"))
        #expect(!ok("call 312-555-0147"))
        #expect(!ok("[[ORG_1]]"))
    }

    @Test func moneyBuckets() {
        #expect(MoneyBucketer.bucket(1240, symbol: "$") == "$1,000–1,500")
        #expect(MoneyBucketer.bucket(85, symbol: "€") == "€85–90")
        #expect(MoneyBucketer.bucket(7, symbol: "£") == "under £10")
        #expect(MoneyBucketer.find(in: "Rent is $1,240.50 and ₹45000, not 1,240.").map(\.bucket) == ["$1,000–1,500", "₹45,000–50,000"])
    }
}

// MARK: - Sealer + full deterministic pipeline (seal.json)

struct SealFixture: Decodable {
    struct FCandidate: Decodable {
        let start, end: Int
        let text, category, detector: String
        let subtype, roleHint: String?
    }
    struct FOverride: Decodable { let id, action: String; let revealThisTime: Bool }
    struct Case: Decodable {
        let name, dial, today, text, expectedText: String
        let vault: [FVault]
        let llm: [FCandidate]
        let overrides: [FOverride]
        let expectedLegend: [[String]]
    }
    let cases: [Case]
}

/// The deterministic pipeline as the app will run it (minus the on-device LLM, whose output is given).
func runPipeline(
    _ raw: String, vault: [VaultEntry], llm: [Candidate], dial: DialPreset, today: Date,
    overrides: [PlaceholderID: UserOverride] = [:], existing: EntityMap = EntityMap()
) -> (draft: SealDraft, merge: MergeResult, normalised: NormalisedText) {
    let n = Normaliser.normalise(raw)
    let candidates = VaultMatcher(entries: vault).detect(in: n.text) + fixturePatterns.detect(in: n.text) + llm
    let merge = Merger.merge(candidates, in: n.text, existing: existing, vault: vault)
    let sealer = Sealer(policy: PolicyEngine(dial: dial), patterns: fixturePatterns, today: today)
    return (sealer.draft(n, merge: merge, overrides: overrides), merge, n)
}

@Suite struct SealPipelineFixtureTests {
    @Test func sharedFixture() throws {
        for c in try fixture("seal.json", as: SealFixture.self).cases {
            let llm = c.llm.map {
                Candidate(
                    span: TextSpan(start: $0.start, end: $0.end), text: $0.text, category: PrivacyCategory(rawValue: $0.category)!,
                    subtype: $0.subtype, detector: .llm, confidence: .high, roleHint: $0.roleHint)
            }
            let vault = c.vault.map(\.entry)
            // Overrides refer to ids, which are only known after merging: merge once, then seal with overrides.
            let first = runPipeline(c.text, vault: vault, llm: llm, dial: DialPreset(rawValue: c.dial)!, today: utcDate(c.today))
            var overrides: [PlaceholderID: UserOverride] = [:]
            for o in c.overrides {
                overrides[PlaceholderID(string: o.id)!] = UserOverride(action: parseAction(o.action), revealThisTime: o.revealThisTime)
            }
            let run = runPipeline(
                c.text, vault: vault, llm: llm, dial: DialPreset(rawValue: c.dial)!, today: utcDate(c.today), overrides: overrides)
            _ = first
            #expect(run.draft.text == c.expectedText, "[\(c.name)]")
            #expect(run.draft.legend.map { [$0.placeholder.description, $0.description] } == c.expectedLegend, "[\(c.name)] legend")

            let gate = EgressGate(patterns: fixturePatterns, vault: vault)
            #expect(throws: Never.self, "[\(c.name)] gate must pass") { _ = try gate.seal(run.draft) }
        }
    }

    @Test func replacementsMapBack() {
        let raw = "Hi Raj, call 312-555-0147."
        let vault = [VaultEntry(id: "v", canonical: "Raj", category: .person, roleHint: "my landlord")]
        let run = runPipeline(raw, vault: vault, llm: [], dial: .balanced, today: Date())
        for r in run.draft.replacements {
            #expect(run.draft.text.substring(utf16: r.sealedSpan) == r.entityID?.token)
            #expect(run.normalised.text.substring(utf16: r.normalisedSpan) != nil)
        }
        #expect(run.draft.text == "Hi [[PERSON_1]], call [[CONTACT_1]].")
    }

    @Test func roleRewriting() {
        #expect(Sealer.rewriteRole("the writer's landlord") == "the user's landlord")
        #expect(Sealer.rewriteRole("my sister") == "the user's sister")
        #expect(Sealer.rewriteRole("me") == "the user")
        #expect(Sealer.rewriteRole("landlord") == "the user's landlord")
        #expect(Sealer.rewriteRole("a coworker") == "a coworker")
    }

    @Test func leakyRoleHintFallsBack() {
        let raw = "Lena Okafor emailed."
        let llm = [
            Candidate(
                span: TextSpan(start: 0, end: 11), text: "Lena Okafor", category: .person, detector: .llm, confidence: .high,
                roleHint: "Okafor's manager at a@b.co")
        ]
        let run = runPipeline(raw, vault: [], llm: llm, dial: .balanced, today: Date())
        #expect(run.draft.legend.first?.description == "a person mentioned in the message")
    }
}

// MARK: - Egress gate (gate.json)

struct GateFixture: Decodable {
    struct Case: Decodable {
        let name, text: String
        let legend: [[String]]
        let entities: [FEntity]
        let vault: [FVault]
        let revealed, kept, mustInclude: [String]
        let toolResult, pass: Bool
        let maxUTF16: Int?
    }
    let cases: [Case]
}

@Suite struct EgressGateTests {
    @Test func sharedFixture() throws {
        for c in try fixture("gate.json", as: GateFixture.self).cases {
            let gate = EgressGate(
                patterns: fixturePatterns, vault: c.vault.map(\.entry), limits: GateLimits(maxUTF16: c.maxUTF16 ?? 40_000))
            let map = EntityMap(c.entities.map(\.entity))
            let legend = c.legend.map { LegendLine(placeholder: PlaceholderID(string: $0[0])!, description: $0[1]) }
            let result: Result<SealedText, GateBlocked>
            if c.toolResult {
                result = Result { () throws(GateBlocked) in try gate.sealToolResult(c.text, entities: map) }
            } else {
                let draft = SealDraft(
                    text: c.text, legend: legend, replacements: [], entities: map, secretWarnings: [], revealedVaultIDs: Set(c.revealed),
                    keptValues: Set(c.kept.map(FoldedSearch.fold)))
                result = Result { () throws(GateBlocked) in try gate.seal(draft) }
            }
            switch result {
            case .success(let sealed):
                #expect(c.pass, "[\(c.name)] should have been blocked")
                #expect(sealed.value == c.text)
                #expect(sealed.gateReport.checksPassed == GateCheck.allCases && !sealed.gateReport.bypassed)
            case .failure(let blocked):
                #expect(!c.pass, "[\(c.name)] false block: \(blocked.hits.map(\.check.rawValue))")
                let got = Set(blocked.checks.map(\.rawValue))
                #expect(Set(c.mustInclude).isSubset(of: got), "[\(c.name)] expected \(c.mustInclude), got \(got.sorted())")
            }
        }
    }

    @Test func blockedErrorCarriesNoValues() {
        let gate = EgressGate(patterns: fixturePatterns, vault: [VaultEntry(id: "v", canonical: "Maya Chen", category: .person)])
        let draft = SealDraft(
            text: "From Maya Chen, maya@example.com", legend: [], replacements: [], entities: EntityMap(), secretWarnings: [],
            revealedVaultIDs: [], keptValues: [])
        do {
            _ = try gate.seal(draft)
            Issue.record("expected a block")
        } catch {
            let dump = String(describing: error)
            #expect(!dump.contains("Maya") && !dump.contains("example.com"), "INV-8: \(dump)")
            #expect(error.checks.isSuperset(of: [.g1VaultTerms, .g3Patterns]))
        }
    }

    @Test func outboundHashCoversTextAndLegend() throws {
        let gate = EgressGate(patterns: fixturePatterns, vault: [])
        let e = Entity(
            id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: [], sources: [.llm],
            confidence: .high)
        let legend = [LegendLine(placeholder: e.id, description: "the user's landlord")]
        let draft = SealDraft(
            text: "Hi [[PERSON_1]].", legend: legend, replacements: [], entities: EntityMap([e]), secretWarnings: [], revealedVaultIDs: [],
            keptValues: [])
        let sealed = try gate.seal(draft)
        #expect(sealed.gateReport.outboundSha256 == sha256Hex("Hi [[PERSON_1]].\n\n[[PERSON_1]] — the user's landlord"))
        #expect(sealed.gateReport.counts["person"] == 1)
    }

    @Test func storedTurnRegatesAndFailsOnceVaultChanges() throws {
        let raj = Entity(
            id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: ["Raj Patel", "Raj"],
            sources: [.llm], confidence: .high)
        let legend = [LegendLine(placeholder: raj.id, description: "the user's landlord")]
        let stored = SealDraft(
            storedText: "My neighbour Dana says [[PERSON_1]] still hasn't fixed the heater.", legend: legend, entities: EntityMap([raj]),
            revealedVaultIDs: [], keptValues: [])
        #expect(stored.replacements.isEmpty && stored.secretWarnings.isEmpty)

        // Passes the gate again with the Vault it was sealed under.
        let sealed = try EgressGate(patterns: fixturePatterns, vault: []).seal(stored)
        #expect(sealed.value == stored.text)

        // The user later adds "Dana" to the Vault: the stored turn must no longer leave (G1).
        let vault = [VaultEntry(id: "v-dana", canonical: "Dana", category: .person, roleHint: "my neighbour")]
        do {
            _ = try EgressGate(patterns: fixturePatterns, vault: vault).seal(stored)
            Issue.record("expected G1 to block the stored turn")
        } catch {
            #expect(error.checks.contains(.g1VaultTerms))
        }

        // Revealing that Vault entry this time is honoured on reload too.
        let revealed = SealDraft(
            storedText: stored.text, legend: legend, entities: EntityMap([raj]), revealedVaultIDs: ["v-dana"], keptValues: [])
        #expect(throws: Never.self) { try EgressGate(patterns: fixturePatterns, vault: vault).seal(revealed) }
    }

    #if DEBUG
        @Test func debugBypassIsMarked() {
            let gate = EgressGate(patterns: fixturePatterns, vault: [])
            let draft = SealDraft(
                text: "card 4111 1111 1111 1111", legend: [], replacements: [], entities: EntityMap(), secretWarnings: [],
                revealedVaultIDs: [], keptValues: [])
            let sealed = gate.sealBypassingChecks(draft)
            #expect(sealed.gateReport.bypassed && sealed.gateReport.checksPassed.isEmpty)
        }
    #endif
}

// MARK: - Property test (docs/09-TESTING.md §2): 10,000 drafts

@Suite struct EgressGatePropertyTests {
    static let people = [
        "Raj Patel", "Lena Okafor", "Tomasz Wiśniewski", "Aiko Tanaka", "Jorge Álvarez", "Priya Natarajan", "Dmitri Volkov",
        "Siobhan Kearney",
    ]
    static let orgs = ["Brightline Logistics", "Harbor View Clinic", "Northgate Academy"]
    static let filler = [
        "the", "heater", "has", "been", "broken", "for", "three", "weeks", "and", "nobody", "called", "back", "about", "repair",
        "please", "help", "me", "reply", "firmly", "landlord", "says", "it", "is", "fine", "but", "not", "cold", "apartment",
        "since", "october", "we", "talked", "yesterday", "again", "today", "kind", "of", "frustrating", "thanks", "a", "lot",
    ]
    static let confusables: [Character: Character] = ["a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "i": "і"]
    static let zeroWidth: [Character] = ["\u{200B}", "\u{200C}", "\u{200D}", "\u{2060}", "\u{FEFF}"]
    static let accents: [Character: Character] = ["a": "á", "e": "é", "i": "í", "o": "ó", "u": "ú", "n": "ñ"]
    static let ibans = ["GB82WEST12345698765432", "DE89370400440532013000", "FR1420041010050500013M02606"]

    struct Scenario {
        var entities: [Entity]
        var vault: [VaultEntry]
    }

    static func scenario(_ rng: inout SeededRNG) -> Scenario {
        var names = people.shuffled(using: &rng)
        let vaultName = names.removeFirst()
        let count = Int.random(in: 1...3, using: &rng)
        var entities = (0..<count).map { i -> Entity in
            let name = names[i]
            let first = String(name.split(separator: " ")[0])
            return Entity(
                id: PlaceholderID(category: .person, number: i + 1), category: .person, canonical: name, surfaceForms: [name, first],
                sources: [.llm], confidence: .high)
        }
        let org = orgs.randomElement(using: &rng)!
        entities.append(
            Entity(
                id: PlaceholderID(category: .org, number: 1), category: .org, canonical: org, surfaceForms: [org],
                action: .generalise(level: 2), generalisedText: "an organisation", sources: [.llm], confidence: .high))
        let vfirst = String(vaultName.split(separator: " ")[0])
        return Scenario(
            entities: entities,
            vault: [VaultEntry(id: "v1", canonical: vaultName, aliases: [vfirst], category: .person, roleHint: "my sister")])
    }

    static func cleanDraft(_ s: Scenario, _ rng: inout SeededRNG) -> (words: [String], legend: [LegendLine]) {
        var words = (0..<Int.random(in: 4...30, using: &rng)).map { _ in filler.randomElement(using: &rng)! }
        let people = s.entities.filter { $0.category == .person }
        var used: Set<PlaceholderID> = []
        for _ in 0..<Int.random(in: 1...3, using: &rng) {
            let e = people.randomElement(using: &rng)!
            used.insert(e.id)
            words.insert(e.id.token + (Bool.random(using: &rng) ? "'s" : ""), at: Int.random(in: 0...words.count, using: &rng))
        }
        if Bool.random(using: &rng) { words.insert("an organisation", at: Int.random(in: 0...words.count, using: &rng)) }
        let legend = used.sorted().map { LegendLine(placeholder: $0, description: "the user's landlord") }
        return (words, legend)
    }

    static func card(_ rng: inout SeededRNG) -> String {
        var digits = [4] + (0..<14).map { _ in Int.random(in: 0...9, using: &rng) }
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            let x = i % 2 == 0 ? d * 2 : d
            sum += x > 9 ? x - 9 : x
        }
        digits.append((10 - sum % 10) % 10)
        let s = digits.map(String.init).joined()
        guard Bool.random(using: &rng) else { return s }
        return stride(from: 0, to: 16, by: 4).map { i in String(s.dropFirst(i).prefix(4)) }.joined(separator: " ")
    }

    static func mutation(_ kind: Int, _ s: Scenario, _ rng: inout SeededRNG) -> String {
        let forms = s.entities.flatMap(\.surfaceForms).shuffled(using: &rng)
        switch kind {
        case 0:  // (a) a surface form, sometimes possessive
            return forms[0] + (Bool.random(using: &rng) ? "'s" : "")
        case 1:  // (b) a vault term with random case and diacritics
            let term = s.vault[0].allTerms.randomElement(using: &rng)!
            return String(
                term.map { ch -> Character in
                    var c = ch
                    if let a = accents[Character(c.lowercased())], Int.random(in: 0..<3, using: &rng) == 0 { c = a }
                    return Bool.random(using: &rng) ? Character(c.uppercased()) : Character(c.lowercased())
                })
        case 2:  // (c) a D2 pattern instance
            switch Int.random(in: 0..<5, using: &rng) {
            case 0: return card(&rng)
            case 1: return ibans.randomElement(using: &rng)!
            case 2: return "user\(Int.random(in: 1...9999, using: &rng))@mail.example.org"
            case 3: return "312-555-\(String(format: "%04d", Int.random(in: 0...9999, using: &rng)))"
            default:
                return
                    "\(Int.random(in: 100...665, using: &rng))-\(Int.random(in: 10...99, using: &rng))-\(Int.random(in: 1000...9999, using: &rng))"
            }
        case 3:  // (d) zero-width joined into a surface form
            var chars = Array(forms[0])
            chars.insert(zeroWidth.randomElement(using: &rng)!, at: Int.random(in: 1..<chars.count, using: &rng))
            return String(chars)
        case 5:  // (f) a partial organisation name ("Harbor View" from "Harbor View Clinic")
            let org = s.entities.first { $0.category == .org }!.canonical.split(separator: " ")
            return Bool.random(using: &rng) ? org.prefix(2).joined(separator: " ") : String(org[0])
        default:  // (e) homoglyph substitution
            let form = forms.first { $0.contains(where: { confusables[$0] != nil }) } ?? forms[0]
            var chars = Array(form)
            let idx = chars.indices.filter { confusables[chars[$0]] != nil }
            if let i = idx.randomElement(using: &rng) { chars[i] = confusables[chars[i]]! }
            return String(chars)
        }
    }

    @Test func tenThousandMutationsAlwaysBlockAndCleanAlwaysPasses() {
        var rng = SeededRNG(seed: 20261116)
        let patterns: PatternDetector = {
            guard let p = try? PatternDetector.bundled(useDataDetectors: true) else { fatalError("packs") }
            return p
        }()
        var falseBlocks = 0, misses = 0
        for i in 0..<10_000 {
            let s = Self.scenario(&rng)
            let gate = EgressGate(patterns: patterns, vault: s.vault)
            let map = EntityMap(s.entities)
            let (words, legend) = Self.cleanDraft(s, &rng)

            if i % 2 == 0 {
                let clean = SealDraft(
                    text: words.joined(separator: " "), legend: legend, replacements: [], entities: map, secretWarnings: [],
                    revealedVaultIDs: [], keptValues: [])
                do { _ = try gate.seal(clean) } catch {
                    falseBlocks += 1
                    if falseBlocks <= 3 { Issue.record("false block on clean draft: \(clean.text) → \(error.hits.map(\.check.rawValue))") }
                }
            }

            var mutated = words
            let kind = i % 6
            mutated.insert(Self.mutation(kind, s, &rng), at: Int.random(in: 0...mutated.count, using: &rng))
            let draft = SealDraft(
                text: mutated.joined(separator: " "), legend: legend, replacements: [], entities: map, secretWarnings: [],
                revealedVaultIDs: [], keptValues: [])
            if (try? gate.seal(draft)) != nil {
                misses += 1
                if misses <= 5 { Issue.record("mutation kind \(kind) passed the gate: \(draft.text)") }
            }
        }
        #expect(falseBlocks == 0)
        #expect(misses == 0)
    }
}

// MARK: - End to end: seal → (mock Gemini) → restore

@Suite struct EndToEndTests {
    @Test func mayaLandlordRoundTrip() throws {
        let raw = "Hi Raj, the heater at 14 Elm St, Apt 3B has been broken since Oct 28. Thanks, Maya Chen"
        let vault = [
            VaultEntry(id: "v-me", canonical: "Maya Chen", aliases: ["Maya"], category: .person, roleHint: "me", isUser: true),
            VaultEntry(id: "v-raj", canonical: "Raj Patel", aliases: ["Raj"], category: .person, roleHint: "my landlord"),
        ]
        let run = runPipeline(raw, vault: vault, llm: [], dial: .balanced, today: utcDate("2026-11-21"))
        let sealed = try EgressGate(patterns: fixturePatterns, vault: vault).seal(run.draft)
        #expect(!sealed.value.contains("Raj") && !sealed.value.contains("Maya") && !sealed.value.contains("Elm"))

        let geminiAnswer =
            "Here's a reply you can send to [[PERSON_1]]:\n\nHi [[PERSON_1]], the heater at [[LOC_1]] still isn't fixed. Please repair it this week.\n\nThanks,\n[[PERSON_ME]]"
        let ctx = RestoreContext(entities: run.draft.entities, userFirstName: "Maya", writingAsUser: true)
        let restored = Restorer.restore(geminiAnswer, context: ctx)
        #expect(restored.text.contains("send to Raj Patel"))
        #expect(restored.text.contains("Hi Raj, the heater at 14 Elm St, Apt 3B"))
        #expect(restored.text.hasSuffix("Thanks,\nMaya"))
        #expect(FidelityCheck.check(modelOutput: geminiAnswer, context: ctx).isClean)

        // A follow-up keeps the same ids.
        let follow = runPipeline(
            "Raj says next Tuesday.", vault: vault, llm: [], dial: .balanced, today: utcDate("2026-11-21"), existing: run.draft.entities)
        #expect(follow.draft.text == "[[PERSON_1]] says next Tuesday.")
    }
}
