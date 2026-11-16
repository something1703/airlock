import Foundation

/// Repo root, found from this file's location (…/Packages/AirlockKit/Tests/<Target>/Support.swift).
let repoRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

/// Loads and decodes `spec/fixtures/<name>` (the cross-platform conformance suite).
func fixture<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
    let data = try Data(contentsOf: repoRoot.appendingPathComponent("spec/fixtures/\(name)"))
    return try JSONDecoder().decode(T.self, from: data)
}

/// Deterministic RNG for property tests (SplitMix64), so failures reproduce.
struct SeededRNG: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}
