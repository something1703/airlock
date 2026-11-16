import AirlockCore
import Foundation
import Testing

@testable import AirlockDetect

struct MergeFixture: Decodable {
    struct FCandidate: Decodable {
        let start, end: Int
        let text, category, detector: String
        let subtype, sameAs, vaultEntryId, roleHint: String?
        var candidate: Candidate {
            Candidate(
                span: TextSpan(start: start, end: end), text: text, category: PrivacyCategory(rawValue: category)!, subtype: subtype,
                detector: DetectorID(rawValue: detector)!, confidence: .high, roleHint: roleHint, sameAs: sameAs, vaultEntryID: vaultEntryId
            )
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
    struct FEntity: Decodable {
        let id, category, canonical: String
        let surfaceForms: [String]
        let action: String
        var entity: Entity {
            Entity(
                id: PlaceholderID(string: id)!, category: PrivacyCategory(rawValue: category)!, canonical: canonical,
                surfaceForms: Set(surfaceForms), sources: [.llm], confidence: .high)
        }
    }
    struct ExpectEntity: Decodable {
        let id, canonical: String
        let formsInclude: [String]?
        let confidence: String?
        let vaultEntryId: String?
    }
    struct Expect: Decodable {
        let entities: [ExpectEntity]
        let mentions: [[String]]
        let ambiguous: [[String]]
    }
    struct Case: Decodable {
        let name, text: String
        let vault: [FVault]
        let candidates: [FCandidate]
        let existing: [FEntity]
        let expect: Expect
    }
    let cases: [Case]
}

@Suite struct MergerTests {
    @Test func sharedFixture() throws {
        for c in try fixture("merge.json", as: MergeFixture.self).cases {
            let r = Merger.merge(
                c.candidates.map(\.candidate), in: c.text, existing: EntityMap(c.existing.map(\.entity)), vault: c.vault.map(\.entry))
            for e in c.expect.entities {
                let id = try #require(PlaceholderID(string: e.id))
                let got = try #require(r.entities[id], "[\(c.name)] missing \(e.id); have \(r.entities.sorted.map(\.id))")
                #expect(got.canonical == e.canonical, "[\(c.name)] canonical of \(e.id)")
                for f in e.formsInclude ?? [] {
                    #expect(got.surfaceForms.contains(f), "[\(c.name)] \(e.id) forms lack \(f): \(got.surfaceForms)")
                }
                if let conf = e.confidence { #expect(got.confidence.rawValue == conf, "[\(c.name)] confidence") }
                if let v = e.vaultEntryId { #expect(got.vaultEntryID == v, "[\(c.name)] vault id") }
            }
            #expect(r.entities.entities.count == c.expect.entities.count, "[\(c.name)] entity count: \(r.entities.sorted.map(\.id))")
            #expect(r.mentions.map { [$0.text, $0.entityID.description] } == c.expect.mentions, "[\(c.name)] mentions")
            let amb = Set(r.ambiguous.map { [$0.entity.description, $0.possiblySameAs.description] })
            #expect(amb == Set(c.expect.ambiguous), "[\(c.name)] ambiguous")
            for (i, a) in r.mentions.enumerated() {
                for b in r.mentions[(i + 1)...] { #expect(!a.span.overlaps(b.span), "[\(c.name)] mentions overlap") }
            }
        }
    }

    @Test func idsFollowFirstAppearance() {
        let text = "Lena met Omar and Lena left."
        let cands = [("Omar", 9), ("Lena", 0), ("Lena", 18)].map {
            Candidate(span: TextSpan(start: $0.1, end: $0.1 + 4), text: $0.0, category: .person, detector: .llm, confidence: .high)
        }
        let r = Merger.merge(cands, in: text)
        #expect(r.mentions.map(\.entityID.description) == ["PERSON_1", "PERSON_2", "PERSON_1"])
    }

    @Test func quasiCandidatesIgnored() {
        let r = Merger.merge(
            [Candidate(span: TextSpan(start: 0, end: 3), text: "abc", category: .quasi, detector: .redteam, confidence: .high)], in: "abc")
        #expect(r.mentions.isEmpty)
    }
}
