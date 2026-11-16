import CryptoKit
import Foundation

/// Lowercase hex SHA-256 of a string's UTF-8 bytes.
///
/// Guarantees: matches Python `hashlib.sha256(s.encode()).hexdigest()` and the web/Android
/// implementations (pinned by `spec/fixtures/hashchain.json`).
public func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}
