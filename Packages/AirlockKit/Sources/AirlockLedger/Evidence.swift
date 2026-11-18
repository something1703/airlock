import Foundation

// Evidence (docs/06-UI-UX.md §5.12): what AirlockBench measured, shown in the app. Sources, in order:
//   1. Remote Config `evidence_json` (so the final run can go live without a release),
//   2. the newest NON-mock run bundled from eval/reports/<run>/evidence.json,
//   3. the newest mock run — always shown with its "MOCK RUN" label, never as real results.
// Schema: eval/schemas/evidence.schema.json. Same rules as web/src/app/evidence.ts.
//
// It lives in AirlockLedger because both answer "what can you prove?": the Ledger proves what left
// this device, Evidence reports how often the engine let something through. It touches no user data.

/// One AirlockBench run, as the Evidence screen shows it.
///
/// Guarantees: a value only exists if it passed the same structural check as the web app
/// (`schemaVersion == 1`, the three headline rates, a well-formed ablation and misses list, and a
/// `label` on every mock run). Anything malformed is ignored rather than shown.
public struct Evidence: Sendable, Hashable, Decodable {
    /// A rate in [0, 1] with its 95% interval and sample size.
    public struct Measure: Sendable, Hashable, Decodable {
        public let value: Double
        public let low: Double
        public let high: Double
        public let n: Int

        public init(value: Double, low: Double, high: Double, n: Int) {
            self.value = value
            self.low = low
            self.high = high
            self.n = n
        }

        private enum CodingKeys: String, CodingKey { case value, low, high, n }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            value = try c.decode(Double.self, forKey: .value)
            low = try c.decode(Double.self, forKey: .low)
            high = try c.decode(Double.self, forKey: .high)
            // Any JSON number, as on the web; shown as a whole count.
            guard let count = Evidence.wholeCount(try c.decode(Double.self, forKey: .n)) else {
                throw DecodingError.dataCorruptedError(forKey: .n, in: c, debugDescription: "n out of range")
            }
            n = count
        }
    }

    /// Leak rate with one more layer switched on.
    public struct AblationRow: Sendable, Hashable, Decodable {
        /// Config id (`B_rules`, …). Not validated on the web, so optional here.
        public let config: String?
        public let label: String
        public let leak: Measure

        private enum CodingKeys: String, CodingKey { case config, label, leak }

        public init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            config = try? c.decodeIfPresent(String.self, forKey: .config)
            label = try c.decode(String.self, forKey: .label)
            leak = try c.decode(Measure.self, forKey: .leak)
        }
    }

    public let schemaVersion: Int
    public let mock: Bool
    /// "MOCK RUN — not real model results" on every mock run; `nil` on a real one.
    public let label: String?
    public let runId: String
    /// ISO 8601. Newer runs win (`pick`).
    public let createdAt: String
    public let dataset: String
    public let split: String
    /// Distinct documents scored.
    public let n: Int
    /// Language codes (`en`, `de`, …).
    public let languages: [String]
    public let onDeviceModel: String?
    public let headlineConfig: String?
    public let leakRate: Measure
    public let leakRateWithVault: Measure?
    public let namesCaught: Measure
    public let quality: Measure
    /// Quick tasks answered entirely on the device.
    public let onDevice: Measure?
    public let restoreFidelity: Measure?
    public let reidTwoAttrs: Measure?
    public let gateBlockRate: Measure?
    public let ablation: [AblationRow]
    public let misses: [String]
    /// Link to the method and code.
    public let method: String

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, mock, label, runId, createdAt, dataset, split, n, languages, onDeviceModel, headlineConfig
        case leakRate, leakRateWithVault, namesCaught, quality, onDevice, restoreFidelity, reidTwoAttrs, gateBlockRate
        case ablation, misses, method
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Checked, exactly as parseEvidence on the web.
        schemaVersion = try c.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == 1 else {
            throw DecodingError.dataCorruptedError(forKey: .schemaVersion, in: c, debugDescription: "unsupported schemaVersion")
        }
        mock = try c.decode(Bool.self, forKey: .mock)
        runId = try c.decode(String.self, forKey: .runId)
        leakRate = try c.decode(Measure.self, forKey: .leakRate)
        namesCaught = try c.decode(Measure.self, forKey: .namesCaught)
        quality = try c.decode(Measure.self, forKey: .quality)
        ablation = try c.decode([AblationRow].self, forKey: .ablation)
        misses = try c.decode([String].self, forKey: .misses)
        let label = try? c.decodeIfPresent(String.self, forKey: .label)
        if mock && label == nil {
            // A mock run must carry its label, so it can never pass for real results.
            throw DecodingError.dataCorruptedError(forKey: .label, in: c, debugDescription: "mock run without label")
        }
        self.label = label
        // Display-only fields: the web does not reject on these, so a missing or mistyped one falls
        // back to a neutral value instead of hiding the whole run.
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
        dataset = (try? c.decodeIfPresent(String.self, forKey: .dataset)) ?? ""
        split = (try? c.decodeIfPresent(String.self, forKey: .split)) ?? ""
        n = (try? c.decodeIfPresent(Double.self, forKey: .n)).flatMap(Self.wholeCount) ?? 0
        languages = (try? c.decodeIfPresent([String].self, forKey: .languages)) ?? []
        onDeviceModel = try? c.decodeIfPresent(String.self, forKey: .onDeviceModel)
        headlineConfig = try? c.decodeIfPresent(String.self, forKey: .headlineConfig)
        method = (try? c.decodeIfPresent(String.self, forKey: .method)) ?? ""
        leakRateWithVault = try? c.decodeIfPresent(Measure.self, forKey: .leakRateWithVault)
        onDevice = try? c.decodeIfPresent(Measure.self, forKey: .onDevice)
        restoreFidelity = try? c.decodeIfPresent(Measure.self, forKey: .restoreFidelity)
        reidTwoAttrs = try? c.decodeIfPresent(Measure.self, forKey: .reidTwoAttrs)
        gateBlockRate = try? c.decodeIfPresent(Measure.self, forKey: .gateBlockRate)
    }

    /// A JSON number as a whole count, or `nil` when it cannot be one.
    static func wholeCount(_ d: Double) -> Int? {
        d.isFinite && abs(d) < Double(Int32.max) ? Int(d.rounded()) : nil
    }

    // MARK: Loading

    /// Structural check: the run, or `nil` for anything malformed.
    public static func parse(_ data: Data) -> Evidence? {
        try? JSONDecoder().decode(Evidence.self, from: data)
    }

    /// Real runs beat mock runs; newer beats older.
    public static func pick(_ candidates: [Data]) -> Evidence? {
        candidates.compactMap(parse).min { a, b in
            if a.mock != b.mock { return !a.mock }
            return a.createdAt > b.createdAt
        }
    }

    /// `remoteJSON` is AppConfig's `evidence_json` ("{}" when unset); it wins when it parses.
    /// Otherwise the best of the `bundled` reports.
    public static func load(remoteJSON: String, bundled: [Data]) -> Evidence? {
        if let remote = parse(Data(remoteJSON.utf8)) { return remote }
        return pick(bundled)
    }
}
