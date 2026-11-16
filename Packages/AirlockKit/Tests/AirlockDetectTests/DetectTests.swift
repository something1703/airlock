import AirlockCore
import Foundation
import Testing

@testable import AirlockDetect

// MARK: - Fixture shapes

struct ValidatorCase: Decodable { let input: String; let valid: Bool }
struct NormaliseFixture: Decodable {
    struct Case: Decodable { let name: String; let input: String; let expected: String }
    let cases: [Case]
}
struct PatternFixture: Decodable {
    struct Expect: Decodable { let text: String; let category: String; let subtype: String }
    struct Absent: Decodable { let text: String; let subtype: String? }
    struct Case: Decodable { let name: String; let text: String; let expect: [Expect]; let absent: [Absent] }
    let templates: [String: [String]]
    let cases: [Case]

    /// Fake secrets are stored in parts so no key-shaped string exists in the repo; join them here.
    func expand(_ s: String) -> String {
        templates.reduce(s) { acc, t in acc.replacingOccurrences(of: "{{\(t.key)}}", with: t.value.joined()) }
    }
}
struct VaultFixture: Decodable {
    struct Entry: Decodable {
        let id, canonical: String; let aliases: [String]; let category: String; let roleHint: String?; let isUser: Bool
    }
    struct Expect: Decodable { let text: String; let entryId: String }
    struct Case: Decodable { let name: String; let text: String; let expect: [Expect]; let absent: [String] }
    let entries: [Entry]
    let cases: [Case]
}

// MARK: - Validators

@Suite struct ValidatorTests {
    @Test func sharedFixture() throws {
        let all = try fixture("validators.json", as: [String: AnyCases].self)
        var checked = 0
        for (name, cases) in all {
            guard let cases = cases.cases else { continue }
            let validator = try #require(Validators.named(name), "no validator named \(name)")
            for c in cases {
                #expect(validator(c.input) == c.valid, "\(name)(\(c.input)) should be \(c.valid)")
                checked += 1
            }
        }
        #expect(checked > 40)
    }

    /// `validators.json` mixes a description string with case arrays.
    struct AnyCases: Decodable {
        let cases: [ValidatorCase]?
        init(from decoder: Decoder) throws {
            cases = try? decoder.singleValueContainer().decode([ValidatorCase].self)
        }
    }

    @Test func entropy() {
        #expect(Validators.shannonEntropy("aaaa") == 0)
        #expect(abs(Validators.shannonEntropy("abcd") - 2) < 1e-9)
    }
}

// MARK: - Normaliser

@Suite struct NormaliserTests {
    @Test func sharedFixture() throws {
        for c in try fixture("normalise.json", as: NormaliseFixture.self).cases {
            #expect(Normaliser.normalise(c.input).text == c.expected, "\(c.name)")
        }
    }

    @Test func idempotentAndOffsetMapProperty() {
        var rng = SeededRNG(seed: 7)
        let pieces = [
            "Raj", " ", "  ", "\u{200B}", "“", "”", "Ｒ", "ﬁ", "\r\n", "é", "e\u{301}", "👩‍👩‍👧", "\t", "14 Elm St", "\u{202E}", "@", "x",
        ]
        for _ in 0..<500 {
            let input = (0..<Int.random(in: 1...30, using: &rng)).map { _ in pieces.randomElement(using: &rng)! }.joined()
            let n = Normaliser.normalise(input)
            #expect(n.originalOffsets.count == n.text.utf16.count + 1)
            #expect(n.originalOffsets.last == input.utf16.count)
            #expect(zip(n.originalOffsets, n.originalOffsets.dropFirst()).allSatisfy { $0 <= $1 }, "offsets monotonic")
            #expect(Normaliser.normalise(n.text).text == n.text, "idempotent")
        }
    }

    @Test func mapsSpanBackToOriginal() {
        let original = "Hi\u{200B}  “Raj Patel”"
        let n = Normaliser.normalise(original)
        let span = FoldedSearch.ranges(of: "Raj Patel", in: n.text)[0]
        #expect(original.substring(utf16: n.toOriginal(span)) == "Raj Patel")
    }
}

// MARK: - Pattern detector

@Suite struct PatternDetectorTests {
    let detector: PatternDetector

    init() throws {
        detector = try PatternDetector.bundled(useDataDetectors: false)
    }

    @Test func sharedFixture() throws {
        let fx = try fixture("patterns.json", as: PatternFixture.self)
        for raw in fx.cases {
            let c = PatternFixture.Case(
                name: raw.name, text: fx.expand(raw.text),
                expect: raw.expect.map { .init(text: fx.expand($0.text), category: $0.category, subtype: $0.subtype) },
                absent: raw.absent.map { .init(text: fx.expand($0.text), subtype: $0.subtype) })
            let found = detector.detect(in: c.text)
            for e in c.expect {
                #expect(
                    found.contains { $0.text == e.text && $0.category.rawValue == e.category && $0.subtype == e.subtype },
                    "[\(c.name)] expected \(e.text) as \(e.category)/\(e.subtype); got \(found.map { "\($0.text)=\($0.category)/\($0.subtype ?? "-")" })"
                )
            }
            for a in c.absent {
                #expect(
                    !found.contains { $0.text == a.text && (a.subtype == nil || $0.subtype == a.subtype) },
                    "[\(c.name)] \(a.text) must not be detected as \(a.subtype ?? "anything")")
            }
            for f in found { #expect(c.text.substring(utf16: f.span) == f.text, "span/text agree") }
        }
    }

    @Test func noOverlapsInOutput() {
        let text = "Card 4111 1111 1111 1111, SSN 123-45-6789, call 312-555-0147, mail a@b.co, code 4821, Order #ZX81234."
        let found = detector.detect(in: text)
        for (i, a) in found.enumerated() {
            for b in found[(i + 1)...] { #expect(!a.span.overlaps(b.span), "\(a.text) overlaps \(b.text)") }
        }
    }

    /// Property (docs/09-TESTING.md §2): valid IDs inserted anywhere in filler text are always found with the right span.
    @Test func randomInsertionAlwaysDetected() {
        var rng = SeededRNG(seed: 42)
        let filler = "the heater has been broken for three weeks and nobody has called back about the repair yet".split(separator: " ").map(
            String.init)
        let secrets: [(String, PrivacyCategory, String)] = [
            ("4111 1111 1111 1111", .id, "card"), ("5555555555554444", .id, "card"), ("GB82WEST12345698765432", .id, "iban"),
            ("maya.chen@example.com", .contact, "email"), ("r.patel+rent@mail.example.org", .contact, "email"),
            ("123-45-6789", .id, "ssn"), ("+44 20 7946 0958", .contact, "phone"), ("312-555-0147", .contact, "phone"),
            ("sk-" + "abcdefghijklmnopqrstuv12", .secret, "api_key"),
        ]
        for _ in 0..<1000 {
            var words = (0..<Int.random(in: 3...25, using: &rng)).map { _ in filler.randomElement(using: &rng)! }
            let (value, category, subtype) = secrets.randomElement(using: &rng)!
            words.insert(value, at: Int.random(in: 0...words.count, using: &rng))
            let punct = [".", ",", "", "!", ";"].randomElement(using: &rng)!
            let text = words.joined(separator: " ") + punct
            let found = detector.detect(in: text)
            #expect(
                found.contains { $0.text == value && $0.category == category && $0.subtype == subtype },
                "\(value) not found in: \(text) → \(found.map(\.text))")
        }
    }

    @Test func disabledPackIsSkipped() throws {
        let d = try PatternDetector.bundled(disabledPacks: ["national"], useDataDetectors: false)
        #expect(!d.detect(in: "PAN ABCPE1234F").contains { $0.subtype == "national_id" })
    }

    @Test func badRegexIsReported() {
        let pack = PatternPack(
            id: "x", description: "",
            rules: [
                PatternRule(
                    id: "bad", category: .id, subtype: "x", confidence: .low, regex: "(", caseInsensitive: nil, group: nil, validator: nil,
                    shrink: nil, context: nil)
            ])
        #expect(throws: PatternError.badRegex(ruleID: "bad")) { try PatternDetector(packs: [pack]) }
    }

    @Test func dataDetectorsAddRecallOnApple() throws {
        let d = try PatternDetector.bundled(useDataDetectors: true)
        let found = d.detect(in: "Meet me at 1 Infinite Loop, Cupertino, CA 95014 tomorrow.")
        #expect(found.contains { $0.category == .location })
    }
}

// MARK: - Vault

@Suite struct VaultMatcherTests {
    @Test func sharedFixture() throws {
        let f = try fixture("vault.json", as: VaultFixture.self)
        let matcher = VaultMatcher(
            entries: f.entries.map {
                VaultEntry(
                    id: $0.id, canonical: $0.canonical, aliases: $0.aliases, category: PrivacyCategory(rawValue: $0.category)!,
                    roleHint: $0.roleHint, isUser: $0.isUser)
            })
        for c in f.cases {
            let found = matcher.detect(in: c.text)
            for e in c.expect {
                #expect(
                    found.contains { $0.text == e.text && $0.vaultEntryID == e.entryId },
                    "[\(c.name)] expected \(e.text); got \(found.map(\.text))")
            }
            for a in c.absent { #expect(!found.contains { $0.text == a }, "[\(c.name)] \(a) must not match") }
            #expect(found.allSatisfy { $0.detector == .vault && $0.confidence == .high })
        }
    }

    @Test func userEntryGetsSelfRole() {
        let m = VaultMatcher(entries: [VaultEntry(id: "me", canonical: "Maya Chen", category: .person, roleHint: "me", isUser: true)])
        let hit = m.detect(in: "Sincerely, Maya Chen")
        #expect(hit.first?.roleHint == "the user")
        #expect(hit.first?.subtype == "self")
    }
}
