import AirlockCore
import Foundation
import Testing

@testable import AirlockLedger

struct ChainFixture: Decodable {
    struct FReceipt: Decodable {
        struct Gate: Decodable { let passed: Bool; let checks: [String] }
        let id: String; let seq: Int; let createdAt, threadId, route, modelVersion, outboundSha256: String
        let outboundChars: Int; let counts: [String: Int]; let gate: Gate; let armor: String
        let latencyMs: [String: Int]; let prevHash: String
    }
    struct Link: Decodable { let receipt: FReceipt; let canonical: String; let hash: String }
    let genesis: String
    let chain: [Link]
}

extension ChainFixture.Link {
    var receipt_: Receipt {
        let r = receipt
        return Receipt(
            id: r.id, seq: r.seq, createdAt: r.createdAt, threadId: r.threadId, route: Route(rawValue: r.route)!,
            modelVersion: r.modelVersion, outboundSha256: r.outboundSha256, outboundChars: r.outboundChars,
            counts: r.counts, gate: .init(passed: r.gate.passed, checks: r.gate.checks),
            armor: Receipt.ArmorStatus(rawValue: r.armor)!, latencyMs: r.latencyMs, prevHash: r.prevHash,
            hash: hash, outboundText: "[[PERSON_1]] local only")
    }
}

func makeChain(_ n: Int) -> [Receipt] {
    var out: [Receipt] = []
    var prev = HashChain.genesis
    for i in 1...n {
        let r = HashChain.sealed(
            Receipt(
                id: "rcpt_\(i)", seq: i, createdAt: "2026-11-2\(i % 10)T10:00:00Z", threadId: "thr_\(i % 7)",
                route: Route.allCases[i % 4], modelVersion: "m\(i % 3)", outboundSha256: sha256Hex("\(i)"),
                outboundChars: i * 10, counts: ["person": i % 5, "org": i % 2], gate: .init(passed: true, checks: ["G1", "G2"]),
                armor: .notConfigured, latencyMs: ["seal": i], prevHash: prev))
        out.append(r)
        prev = r.hash
    }
    return out
}

@Suite struct HashChainTests {
    /// Byte-identical to the independent Python implementation (spec/tools/make_fixtures.py).
    @Test func matchesSharedFixture() throws {
        let f = try fixture("hashchain.json", as: ChainFixture.self)
        #expect(f.genesis == HashChain.genesis)
        for link in f.chain {
            let r = link.receipt_
            #expect(CanonicalJSON.encode(HashChain.hashedFields(r)) == link.canonical, "canonical JSON for \(r.id)")
            #expect(HashChain.computeHash(r) == link.hash, "hash for \(r.id)")
        }
        #expect(HashChain.verify(f.chain.map(\.receipt_)) == .valid(count: 3))
    }

    @Test func outboundTextIsNotHashed() throws {
        let r = makeChain(1)[0]
        var withText = r
        withText.outboundText = "anything at all"
        #expect(HashChain.computeHash(withText) == r.hash)
    }

    @Test func verifiesThousandReceipts() {
        #expect(HashChain.verify(makeChain(1000)) == .valid(count: 1000))
    }

    /// docs/09-TESTING.md §2: a single changed byte is caught at the right index.
    @Test(arguments: [0, 1, 17, 499, 999])
    func tamperDetectedAtIndex(_ index: Int) {
        var chain = makeChain(1000)
        let r = chain[index]
        chain[index] = Receipt(
            id: r.id, seq: r.seq, createdAt: r.createdAt, threadId: r.threadId, route: r.route,
            modelVersion: r.modelVersion, outboundSha256: r.outboundSha256, outboundChars: r.outboundChars + 1,
            counts: r.counts, gate: r.gate, armor: r.armor, latencyMs: r.latencyMs, prevHash: r.prevHash, hash: r.hash)
        #expect(HashChain.verify(chain) == .broken(index: index, seq: index + 1, reason: .hashMismatch))
    }

    @Test func rehashedTamperBreaksNextLink() {
        var chain = makeChain(10)
        var r = chain[4]
        r = Receipt(
            id: r.id, seq: r.seq, createdAt: r.createdAt, threadId: r.threadId, route: r.route, modelVersion: "forged",
            outboundSha256: r.outboundSha256, outboundChars: r.outboundChars, counts: r.counts, gate: r.gate,
            armor: r.armor, latencyMs: r.latencyMs, prevHash: r.prevHash)
        chain[4] = HashChain.sealed(r)
        #expect(HashChain.verify(chain) == .broken(index: 5, seq: 6, reason: .prevHashMismatch))
    }

    @Test func genesisAndSeqGaps() {
        var chain = makeChain(3)
        chain.remove(at: 1)
        #expect(HashChain.verify(chain) == .broken(index: 1, seq: 3, reason: .seqGap))
        #expect(HashChain.verify(Array(makeChain(3).dropFirst())) == .broken(index: 0, seq: 2, reason: .genesisMismatch))
        #expect(HashChain.verify([]) == .valid(count: 0))
    }
}

@Suite struct CanonicalJSONTests {
    @Test func escapingAndOrdering() {
        let v: JSONValue = .object(["b": .int(-1), "a": .array([.string("q\"\\\n\t\u{01}é"), .bool(true), .null])])
        #expect(CanonicalJSON.encode(v) == #"{"a":["q\"\\\n\t\u0001é",true,null],"b":-1}"#)
    }

    @Test func sha256KnownVector() {
        #expect(sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}
