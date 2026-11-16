import AirlockCore
import Foundation

/// Builds receipts for things that left the phone (`docs/03-PRIVACY-ENGINE.md` §12).
///
/// Guarantees: a receipt contains only the outbound hash, counts and metadata (INV-7); the
/// sealed outbound text is kept locally in `outboundText` and is not part of the hash.
public enum ReceiptBuilder {
    /// ISO-8601 UTC with seconds, e.g. `2026-11-21T10:14:03Z` (sortable as a string).
    public static func timestamp(_ date: Date) -> String { date.formatted(Date.ISO8601FormatStyle(timeZone: .gmt)) }

    public static func make(
        sealed: SealedText, seq: Int, prevHash: String, threadId: String, route: Route, modelVersion: String,
        armor: Receipt.ArmorStatus, sealLatency: Duration, networkLatency: Duration, at date: Date
    ) -> Receipt {
        let outbound = sealed.legend.isEmpty ? sealed.value : sealed.value + "\n\n" + sealed.renderedLegend
        func ms(_ d: Duration) -> Int { Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000) }
        return HashChain.sealed(
            Receipt(
                id: String(format: "rcpt_%04d", seq), seq: seq, createdAt: timestamp(date), threadId: threadId, route: route,
                modelVersion: modelVersion, outboundSha256: sealed.gateReport.outboundSha256, outboundChars: outbound.count,
                counts: sealed.gateReport.counts,
                gate: .init(passed: !sealed.gateReport.bypassed, checks: sealed.gateReport.checksPassed.map(\.rawValue)), armor: armor,
                latencyMs: ["seal": ms(sealLatency), "network": ms(networkLatency)], prevHash: prevHash, outboundText: outbound))
    }
}

/// Weekly numbers for the Ledger hero ("182 details stayed on your phone").
public struct LedgerStats: Sendable, Hashable {
    public let requests: Int
    public let sealedDetails: Int
    public let generalised: Int
    public let onDeviceAnswers: Int
    public let cloudAnswers: Int
    public let blocked: Int
    public let byCategory: [String: Int]
}

/// The local, append-only receipt chain (persistence lives in the app; this is the logic).
///
/// Guarantees: receipts are appended in order with consecutive `seq` and correct `prevHash`;
/// `verify()` recomputes every hash from genesis; on-device answers (nothing left the phone)
/// are counted but create no receipt (`docs/02-ARCHITECTURE.md` §6.2).
public actor ReceiptLedger {
    public private(set) var receipts: [Receipt]
    private var onDeviceAnswers: [Date] = []

    public init(receipts: [Receipt] = []) {
        self.receipts = receipts
    }

    @discardableResult
    public func append(
        sealed: SealedText, threadId: String, route: Route, modelVersion: String, armor: Receipt.ArmorStatus, sealLatency: Duration,
        networkLatency: Duration, at date: Date = Date()
    ) -> Receipt {
        let r = ReceiptBuilder.make(
            sealed: sealed, seq: (receipts.last?.seq ?? 0) + 1, prevHash: receipts.last?.hash ?? HashChain.genesis, threadId: threadId,
            route: route, modelVersion: modelVersion, armor: armor, sealLatency: sealLatency, networkLatency: networkLatency, at: date)
        receipts.append(r)
        return r
    }

    /// An answer produced entirely on the phone — counted for the weekly report, no receipt.
    public func recordOnDeviceAnswer(at date: Date = Date()) {
        onDeviceAnswers.append(date)
    }

    public func verify() -> ChainVerification { HashChain.verify(receipts) }

    public func stats(since start: Date) -> LedgerStats {
        let iso = ReceiptBuilder.timestamp(start)
        let recent = receipts.filter { $0.createdAt >= iso }
        var byCategory: [String: Int] = [:]
        let categories = Set(PrivacyCategory.allCases.map(\.rawValue))
        for r in recent {
            for (k, v) in r.counts where categories.contains(k) { byCategory[k, default: 0] += v }
        }
        let generalised = recent.reduce(0) { $0 + ($1.counts["generalised"] ?? 0) }
        return LedgerStats(
            requests: recent.count, sealedDetails: byCategory.values.reduce(0, +) + generalised, generalised: generalised,
            onDeviceAnswers: onDeviceAnswers.filter { $0 >= start }.count
                + recent.filter { $0.modelVersion == EngineResult.appleOnDeviceModelVersion }.count,
            cloudAnswers: recent.filter { $0.modelVersion != EngineResult.appleOnDeviceModelVersion && $0.armor != .blocked }.count,
            blocked: recent.filter { $0.armor == .blocked }.count, byCategory: byCategory)
    }
}
