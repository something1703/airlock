import AirlockCore
import Foundation
import Testing

@testable import AirlockRestore

struct PlaceholderFixture: Decodable {
    struct Expect: Decodable { let original: String; let id: String; let canonical: Bool }
    struct Case: Decodable { let text: String; let expect: [Expect] }
    let known: [String]
    let cases: [Case]
}

struct RestoreFixture: Decodable {
    struct FEntity: Decodable { let id, category, canonical: String; let surfaceForms: [String]; let action: String }
    struct Case: Decodable {
        let name, output, expected: String
        let writingAsUser: Bool?
        let userFirstName: String?
        let unknown: [String]?
    }
    struct Group: Decodable { let entities: [FEntity]; let cases: [Case] }
    let secretDisplay: String
    let groups: [Group]
}

extension RestoreFixture.FEntity {
    var entity: Entity {
        let action: Action = action == "block" ? .block : action == "keep" ? .keep : .placeholder
        return Entity(
            id: PlaceholderID(string: id)!, category: PrivacyCategory(rawValue: category)!, canonical: canonical,
            surfaceForms: Set(surfaceForms), action: action, sources: [.llm], confidence: .high)
    }
}

@Suite struct PlaceholderParserTests {
    @Test func regexesCompile() {
        #expect(PlaceholderParser.regexes != nil)
    }

    @Test func sharedFixture() throws {
        let f = try fixture("placeholders.json", as: PlaceholderFixture.self)
        let parser = PlaceholderParser(knownIDs: Set(f.known.compactMap(PlaceholderID.init(string:))))
        for c in f.cases {
            let got = parser.tokens(in: c.text)
            #expect(got.map(\.original) == c.expect.map(\.original), "\(c.text)")
            #expect(got.map(\.id.description) == c.expect.map(\.id), "\(c.text)")
            #expect(got.map(\.isCanonical) == c.expect.map(\.canonical), "\(c.text)")
            for t in got {
                #expect(t.original.utf16.count <= PlaceholderParser.maxTokenLength)
                #expect(c.text.substring(utf16: t.span) == t.original)
            }
        }
    }
}

@Suite struct RestorerTests {
    let fx: RestoreFixture

    init() throws {
        fx = try fixture("restore.json", as: RestoreFixture.self)
    }

    func context(_ g: RestoreFixture.Group, _ c: RestoreFixture.Case) -> RestoreContext {
        RestoreContext(
            entities: EntityMap(g.entities.map(\.entity)), userFirstName: c.userFirstName,
            writingAsUser: c.writingAsUser ?? false, secretDisplay: fx.secretDisplay)
    }

    @Test func sharedFixture() {
        for g in fx.groups {
            for c in g.cases {
                let r = Restorer.restore(c.output, context: context(g, c))
                #expect(r.text == c.expected, "[\(c.name)]")
                #expect(r.unknownIDs.map(\.description) == (c.unknown ?? []), "[\(c.name)] unknown ids")
            }
        }
    }

    /// docs/09-TESTING.md §2: split at every boundary, delta and cumulative → identical to unary.
    @Test func streamingEqualsUnaryAtEverySplit() {
        for g in fx.groups {
            for c in g.cases {
                let ctx = context(g, c)
                let unary = Restorer.restore(c.output, context: ctx)
                let ns = c.output as NSString
                for split in 0...ns.length {
                    let head = ns.substring(to: split), tail = ns.substring(from: split)
                    var delta = StreamingRestorer(context: ctx)
                    delta.append(delta: head)
                    delta.append(delta: tail)
                    delta.finish()
                    #expect(delta.segments == unary.segments, "[\(c.name)] delta split \(split)")

                    var cumulative = StreamingRestorer(context: ctx)
                    cumulative.update(cumulative: head)
                    cumulative.update(cumulative: head + tail)
                    cumulative.finish()
                    #expect(cumulative.segments == unary.segments, "[\(c.name)] cumulative split \(split)")
                }
            }
        }
    }

    /// Random multi-chunk streaming of long, placeholder-dense answers.
    @Test func randomChunkFuzz() {
        let g = fx.groups[0]
        let ctx = RestoreContext(entities: EntityMap(g.entities.map(\.entity)), secretDisplay: fx.secretDisplay)
        var rng = SeededRNG(seed: 2026)
        let parts = [
            "[[PERSON_1]]", "[[ORG_1]]", "[[LOC_1]]", "[[SECRET_1]]", "[[PERSON_ME]]", "[[PERSON_9]]", "PERSON_1", "[Person_1]",
            "【PERSON_1】", "[[", "]]", "[", "PERSON", "_", "1", "'s ", " the ", "heater ", "\n", "é", "👩‍👧", "[[PERSON_1",
        ]
        for _ in 0..<500 {
            let answer = (0..<Int.random(in: 1...40, using: &rng)).map { _ in parts.randomElement(using: &rng)! }.joined()
            let unary = Restorer.restore(answer, context: ctx)
            var s = StreamingRestorer(context: ctx)
            let units = Array(answer.utf16)
            var i = 0
            while i < units.count {
                let n = Int.random(in: 1...12, using: &rng)
                let j = min(units.count, i + n)
                // Never split inside a surrogate pair (real SDK chunks are valid strings).
                var end = j
                if end < units.count, UTF16.isTrailSurrogate(units[end]) { end += 1 }
                s.append(delta: String(decoding: units[i..<end], as: UTF16.self))
                i = end
            }
            s.finish()
            #expect(s.segments == unary.segments, "answer: \(answer)")
        }
    }

    @Test func secretNeverRestored() {
        let g = fx.groups[0]
        let ctx = RestoreContext(entities: EntityMap(g.entities.map(\.entity)))
        for variant in ["[[SECRET_1]]", "[SECRET_1]", "SECRET_1", "[[ SECRET_1 ]]", "【SECRET_1】", "[[Secret_1]]"] {
            let r = Restorer.restore("code: \(variant)", context: ctx)
            #expect(!r.text.contains("482913"), "\(variant)")
            #expect(r.secretsHidden == 1)
        }
    }

    @Test func restoredRangesPointAtValues() {
        let g = fx.groups[0]
        let ctx = RestoreContext(entities: EntityMap(g.entities.map(\.entity)))
        let r = Restorer.restore("Hi [[PERSON_1]], see [[ORG_1]].", context: ctx)
        let pieces = r.restoredRanges.keys.sorted().map { r.text.substring(utf16: $0) }
        #expect(pieces == ["Raj Patel", "Mercy General Hospital"])
    }

    @Test func holdBackIsBounded() {
        let ctx = RestoreContext(entities: EntityMap())
        var s = StreamingRestorer(context: ctx)
        let emitted = s.append(delta: String(repeating: "word ", count: 20))
        let out = emitted.map { $0.output(secretDisplay: "") }.joined()
        #expect(out.utf16.count == 100 - StreamingRestorer.holdBack)
    }
}

@Suite struct FidelityTests {
    @Test func detectsGuessedRealName() {
        let map = EntityMap([
            Entity(
                id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel",
                surfaceForms: ["Raj"], sources: [.vault], confidence: .high)
        ])
        let ctx = RestoreContext(entities: map)
        #expect(FidelityCheck.check(modelOutput: "Tell [[PERSON_1]] politely.", context: ctx).isClean)
        let guessed = FidelityCheck.check(modelOutput: "Tell Raj politely.", context: ctx)
        #expect(guessed.guessedEntities.map(\.description) == ["PERSON_1"])
        #expect(FidelityCheck.check(modelOutput: "Ask [[ORG_4]].", context: ctx).unknownIDs.map(\.description) == ["ORG_4"])
    }
}
