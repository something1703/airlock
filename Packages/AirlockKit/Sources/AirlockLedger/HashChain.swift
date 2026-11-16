import AirlockCore
import Foundation

/// Result of "Verify chain".
public enum ChainVerification: Sendable, Hashable {
    case valid(count: Int)
    /// The first receipt (by position) that doesn't match. UI: "Receipt #seq doesn't match."
    case broken(index: Int, seq: Int, reason: Reason)

    public enum Reason: String, Sendable, Hashable {
        case hashMismatch, prevHashMismatch, seqGap, genesisMismatch
    }

    public var isValid: Bool { if case .valid = self { true } else { false } }
}

/// The receipt hash chain (`docs/03-PRIVACY-ENGINE.md` §12, F-41).
///
/// Guarantees: `hash = sha256Hex(prevHash + CanonicalJSON(receiptFields))`, where
/// the fields exclude `hash` and the local-only `outboundText`. The first receipt's
/// `prevHash` is 64 zeros. Changing any hashed byte of any receipt makes
/// `verify` report that receipt (or its successor's link) as broken.
public enum HashChain {
    public static let genesis = String(repeating: "0", count: 64)

    /// The fields that are hashed, as canonical JSON input.
    public static func hashedFields(_ r: Receipt) -> JSONValue {
        .object([
            "armor": .string(r.armor.rawValue),
            "counts": .object(r.counts.mapValues { .int($0) }),
            "createdAt": .string(r.createdAt),
            "gate": .object(["checks": .array(r.gate.checks.map { .string($0) }), "passed": .bool(r.gate.passed)]),
            "id": .string(r.id),
            "latencyMs": .object(r.latencyMs.mapValues { .int($0) }),
            "modelVersion": .string(r.modelVersion),
            "outboundChars": .int(r.outboundChars),
            "outboundSha256": .string(r.outboundSha256),
            "prevHash": .string(r.prevHash),
            "route": .string(r.route.rawValue),
            "seq": .int(r.seq),
            "threadId": .string(r.threadId),
        ])
    }

    public static func computeHash(_ r: Receipt) -> String {
        sha256Hex(r.prevHash + CanonicalJSON.encode(hashedFields(r)))
    }

    /// Returns the receipt with its `hash` filled in.
    public static func sealed(_ r: Receipt) -> Receipt {
        var copy = r
        copy.hash = computeHash(r)
        return copy
    }

    /// Verifies receipts in chain order (ascending `seq`).
    public static func verify(_ receipts: [Receipt]) -> ChainVerification {
        var expectedPrev = genesis
        var expectedSeq: Int?
        for (i, r) in receipts.enumerated() {
            if i == 0, r.prevHash != genesis {
                return .broken(index: i, seq: r.seq, reason: .genesisMismatch)
            }
            if let s = expectedSeq, r.seq != s {
                return .broken(index: i, seq: r.seq, reason: .seqGap)
            }
            if r.prevHash != expectedPrev {
                return .broken(index: i, seq: r.seq, reason: .prevHashMismatch)
            }
            if computeHash(r) != r.hash {
                return .broken(index: i, seq: r.seq, reason: .hashMismatch)
            }
            expectedPrev = r.hash
            expectedSeq = r.seq + 1
        }
        return .valid(count: receipts.count)
    }
}
