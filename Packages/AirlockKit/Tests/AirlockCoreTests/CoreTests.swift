import Foundation
import Testing

@testable import AirlockCore

@Suite struct PlaceholderIDTests {
    @Test(arguments: ["PERSON_1", "ORG_12", "LOC_3", "CONTACT_1", "ID_7", "DATE_2", "HEALTH_1", "SECRET_4", "PERSON_ME"])
    func roundTrip(_ s: String) throws {
        let id = try #require(PlaceholderID(string: s))
        #expect(id.description == s)
        #expect(id.token == "[[\(s)]]")
    }

    @Test(arguments: ["ORG_ME", "PERSON_0", "PERSON_01", "QUASI_1", "PERSON", "PERSON_", "_1", "PERSON_-1", "PERSON_١"])
    func rejectsInvalid(_ s: String) {
        #expect(PlaceholderID(string: s) == nil)
    }

    @Test func caseInsensitivePrefix() {
        #expect(PlaceholderID(string: "person_2") == PlaceholderID(category: .person, number: 2))
        #expect(PlaceholderID(string: "Person_me") == .me)
    }

    @Test func entityMapNumbering() {
        var map = EntityMap()
        #expect(map.nextID(for: .person).description == "PERSON_1")
        map.upsert(Entity(id: .me, category: .person, canonical: "Maya", surfaceForms: [], sources: [.vault], confidence: .high))
        #expect(map.nextID(for: .person).description == "PERSON_1", "PERSON_ME does not consume a number")
        map.upsert(
            Entity(id: map.nextID(for: .person), category: .person, canonical: "Raj", surfaceForms: [], sources: [.llm], confidence: .high))
        #expect(map.nextID(for: .person).description == "PERSON_2")
        #expect(map.nextID(for: .org).description == "ORG_1")
    }
}

@Suite struct CategoryTests {
    @Test func priorityOrderMatchesSpec() {
        let order: [PrivacyCategory] = [.secret, .id, .contact, .person, .org, .location, .date, .health, .quasi]
        #expect(PrivacyCategory.allCases.sorted { $0.priority < $1.priority } == order)
    }

    @Test func prefixRoundTrip() {
        for c in PrivacyCategory.allCases {
            if let p = c.placeholderPrefix { #expect(PrivacyCategory(placeholderPrefix: p) == c) }
        }
        #expect(PrivacyCategory.quasi.placeholderPrefix == nil)
    }
}

@Suite struct CodableTests {
    func roundTrip<T: Codable & Equatable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        #expect(try JSONDecoder().decode(T.self, from: data) == value)
    }

    @Test func entityAndCandidate() throws {
        try roundTrip(
            Entity(
                id: PlaceholderID(category: .org, number: 1), category: .org, canonical: "Mercy General",
                surfaceForms: ["Mercy"], roleHint: "the user's employer", action: .generalise(level: 2),
                generalisedText: "a large hospital", sources: [.vault, .llm], confidence: .medium, subtype: nil))
        try roundTrip(
            Candidate(
                span: TextSpan(start: 3, end: 9), text: "Raj P.", category: .person, detector: .llm,
                confidence: .low, roleHint: "landlord", sameAs: "Raj"))
        try roundTrip(
            EntityMap([Entity(id: .me, category: .person, canonical: "Maya", surfaceForms: [], sources: [.vault], confidence: .high)]))
    }

    @Test func receipt() throws {
        try roundTrip(
            Receipt(
                id: "rcpt_1", seq: 1, createdAt: "2026-11-21T10:14:03Z", threadId: "thr_1", route: .cloudFirst,
                modelVersion: "m", outboundSha256: "00", outboundChars: 3, counts: ["person": 1],
                gate: .init(passed: true, checks: ["G1"]), armor: .notConfigured, latencyMs: ["seal": 1],
                prevHash: "0", hash: "h", outboundText: "[[PERSON_1]]"))
    }

    @Test func spanBasics() {
        let a = TextSpan(start: 0, end: 5), b = TextSpan(start: 4, end: 8), c = TextSpan(start: 5, end: 6)
        #expect(a.overlaps(b) && !a.overlaps(c))
        #expect(TextSpan(start: 0, end: 10).contains(b))
        #expect("héllo wörld".substring(utf16: TextSpan(start: 6, end: 11)) == "wörld")
    }
}

@Suite struct EngineResultTests {
    @Test func ranOnDeviceDerivedFromModelVersion() {
        #expect(EngineResult(text: "", modelVersion: EngineResult.appleOnDeviceModelVersion, latency: .zero).ranOnDevice)
        #expect(!EngineResult(text: "", modelVersion: "cloud-model", latency: .zero).ranOnDevice)
    }

    @Test func routeModes() {
        #expect(Route.allCases.map(\.inferenceModeName) == ["ONLY_ON_DEVICE", "PREFER_ON_DEVICE", "PREFER_IN_CLOUD", "ONLY_IN_CLOUD"])
        #expect(!Route.phoneOnly.mayUseCloud)
    }
}

@Suite struct AppConfigTests {
    struct Template: Decodable {
        struct Param: Decodable {
            struct DefaultValue: Decodable { let value: String }
            let defaultValue: DefaultValue
            let valueType: String
        }
        let parameters: [String: Param]
    }

    /// AGENTS.md §10: `AppConfig.defaults` and `firebase/remoteconfig.template.json` change together.
    @Test func defaultsMatchRemoteConfigTemplate() throws {
        let data = try Data(contentsOf: repoRoot.appendingPathComponent("firebase/remoteconfig.template.json"))
        let template = try JSONDecoder().decode(Template.self, from: data)
        #expect(Set(template.parameters.keys) == Set(AppConfig.defaults.keys))
        for (key, value) in AppConfig.defaults {
            let p = try #require(template.parameters[key], "missing \(key)")
            #expect(p.defaultValue.value == value.remoteConfigString, "value mismatch for \(key)")
            #expect(p.valueType == value.remoteConfigType, "type mismatch for \(key)")
        }
    }

    @Test func remoteOverridesAndFallbacks() {
        let config = AppConfig(remote: ["redteam_rounds": "1", "dial_default": "strict", "detect_chunk_tokens": "oops", "unknown_key": "x"])
        #expect(config.redTeamRounds == 1)
        #expect(config.dialDefault == .strict)
        #expect(config.detectChunkTokens == 1400, "unparseable number falls back to default")
        #expect(AppConfig(remote: ["redteam_rounds": "9"]).redTeamRounds == 2, "clamped to max 2")
        #expect(AppConfig(remote: ["pattern_packs_disabled": "[\"national\"]"]).disabledPatternPacks == ["national"])
    }

    @Test func noPreviewOrLatestModels() {
        for (key, value) in AppConfig.defaults where key.hasPrefix("model_") {
            let name = value.remoteConfigString
            #expect(!name.contains("preview") && !name.contains("latest"), "AGENTS.md §3: stable models only (\(key))")
        }
    }
}

/// INV-2: only the egress gate may construct `SealedText`.
@Suite struct SealedTextConstructionTests {
    /// Files allowed to mention the SPI.
    static let allowed: Set<String> = [
        "Packages/AirlockKit/Sources/AirlockCore/Sealed.swift",
        "Packages/AirlockKit/Sources/AirlockSeal/EgressGate.swift",
    ]

    @Test func onlyEgressGateImportsTheSPI() throws {
        let fm = FileManager.default
        var offenders: [String] = []
        for dir in ["Packages/AirlockKit/Sources", "App", "Bench"] {
            let root = repoRoot.appendingPathComponent(dir)
            guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: nil) else { continue }
            for case let url as URL in walker where url.pathExtension == "swift" {
                let rel = String(url.path.dropFirst(repoRoot.path.count + 1))
                let source = try String(contentsOf: url, encoding: .utf8)
                if source.contains("@_spi(EgressGate)"), !Self.allowed.contains(rel) { offenders.append(rel) }
            }
        }
        #expect(offenders.isEmpty, "Files using @_spi(EgressGate): \(offenders)")
    }
}

@Suite struct FoldedSearchTests {
    @Test func wordBoundariesAndFolding() {
        #expect(FoldedSearch.ranges(of: "Raj", in: "Raj's car, not Rajesh").map(\.start) == [0])
        #expect(FoldedSearch.contains("José", in: "jose said"))
        #expect(FoldedSearch.contains("Raj Patel", in: "RAJ\n  PATEL"))
        #expect(!FoldedSearch.contains("Raj Patel", in: "Raj Patelson"))
        #expect(FoldedSearch.ranges(of: "  ", in: "a  b").isEmpty)
    }
}
