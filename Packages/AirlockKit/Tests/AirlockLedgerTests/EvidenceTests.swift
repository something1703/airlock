import Foundation
import Testing

@testable import AirlockLedger

/// Mirrors web/tests/evidence.test.ts, so both apps accept and pick the same runs.
@Suite struct EvidenceTests {
    static var base: [String: Any] {
        [
        "schemaVersion": 1, "runId": "r", "createdAt": "2026-11-20T00:00:00Z", "dataset": "synth-v1", "split": "test", "n": 10,
        "languages": ["en"],
        "leakRate": ["value": 0.1, "low": 0.05, "high": 0.2, "n": 10],
        "namesCaught": ["value": 0.9, "low": 0.8, "high": 0.95, "n": 20],
        "quality": ["value": 0.8, "low": 0.7, "high": 0.9, "n": 10],
        "ablation": [["config": "B", "label": "Rules", "leak": ["value": 0.5, "low": 0.4, "high": 0.6, "n": 10]]],
        "misses": [String](), "method": "https://example.org",
        ]
    }

    static func json(_ overrides: [String: Any]) -> Data {
        let merged = base.merging(overrides) { _, new in new }
        return (try? JSONSerialization.data(withJSONObject: merged)) ?? Data()
    }

    static let bundled: [Data] = {
        let reports = repoRoot.appendingPathComponent("eval/reports")
        let runs = (try? FileManager.default.contentsOfDirectory(at: reports, includingPropertiesForKeys: nil)) ?? []
        return runs.compactMap { try? Data(contentsOf: $0.appendingPathComponent("evidence.json")) }
    }()

    @Test func neverAcceptsAMockRunWithoutItsLabelOrMalformedData() {
        #expect(Evidence.parse(Self.json(["mock": true])) == nil)
        #expect(Evidence.parse(Self.json(["mock": true, "label": NSNull()])) == nil)
        #expect(Evidence.parse(Self.json(["mock": true, "label": "MOCK RUN — not real model results"])) != nil)
        #expect(Evidence.parse(Self.json(["mock": false, "leakRate": ["value": "x"]])) == nil)
        #expect(Evidence.parse(Self.json(["mock": false, "schemaVersion": 2])) == nil)
        #expect(Evidence.parse(Self.json(["mock": "yes"])) == nil)
        #expect(Evidence.parse(Self.json(["mock": false, "runId": 7])) == nil)
        #expect(Evidence.parse(Self.json(["mock": false, "ablation": [["config": "B", "leak": ["value": 0.5, "low": 0.4, "high": 0.6, "n": 10]]]])) == nil)
        #expect(Evidence.parse(Self.json(["mock": false, "misses": [1]])) == nil)
        #expect(Evidence.parse(Data("null".utf8)) == nil)
        #expect(Evidence.parse(Data("{}".utf8)) == nil)
        #expect(Evidence.parse(Data("not json".utf8)) == nil)
    }

    @Test func optionalFieldsDoNotRejectARun() throws {
        // As on the web: a real run's label may be null, and unmeasured rates are null.
        let e = try #require(Evidence.parse(Self.json(["mock": false, "label": NSNull(), "onDevice": NSNull(), "reidTwoAttrs": ["value": "x"]])))
        #expect(e.label == nil)
        #expect(e.onDevice == nil)
        #expect(e.reidTwoAttrs == nil)
        #expect(e.ablation.first?.config == "B")
        #expect(e.leakRate == .init(value: 0.1, low: 0.05, high: 0.2, n: 10))
    }

    @Test func prefersRealRunsOverMockRunsThenTheNewest() {
        let mockNew = Self.json(["mock": true, "label": "MOCK", "runId": "mock", "createdAt": "2026-11-30T00:00:00Z"])
        let realOld = Self.json(["mock": false, "runId": "real-old", "createdAt": "2026-11-20T00:00:00Z"])
        let realNew = Self.json(["mock": false, "runId": "real-new", "createdAt": "2026-11-25T00:00:00Z"])
        #expect(Evidence.pick([mockNew, realOld, realNew])?.runId == "real-new")
        #expect(Evidence.pick([realNew, realOld, mockNew])?.runId == "real-new")
        #expect(Evidence.pick([mockNew])?.runId == "mock")
        #expect(Evidence.pick([Data("{}".utf8)]) == nil)
        #expect(Evidence.pick([]) == nil)
    }

    @Test func remoteConfigWinsOtherwiseTheBundledReports() throws {
        let remote = String(decoding: Self.json(["mock": false, "runId": "from-rc"]), as: UTF8.self)
        #expect(Evidence.load(remoteJSON: remote, bundled: Self.bundled)?.runId == "from-rc")
        let bundled = try #require(Evidence.load(remoteJSON: "{}", bundled: Self.bundled))
        #expect(!bundled.mock || bundled.label?.isEmpty == false)
        #expect(Evidence.load(remoteJSON: "not json", bundled: Self.bundled)?.runId == bundled.runId)
    }

    @Test func committedMockSampleParsesWithItsLabel() throws {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent("eval/reports/mock-sample/evidence.json"))
        let e = try #require(Evidence.parse(data))
        #expect(e.mock)
        #expect(e.label == "MOCK RUN — not real model results")
        #expect(e.languages == ["de", "en", "es"])
        #expect(e.onDevice?.n == 46)
        #expect(e.ablation.map(\.label) == ["Rules", "+On-device model", "+Red-team", "+Your Vault"])
        #expect(e.misses.count == 3)
    }
}
