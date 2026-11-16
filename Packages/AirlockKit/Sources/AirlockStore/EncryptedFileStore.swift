import CryptoKit
import Foundation

/// A directory of AES-GCM encrypted records.
///
/// Guarantees:
/// - Every byte of content on disk is ciphertext (names, entity maps, Vault entries, raw text);
///   `EncryptedFileStoreTests` asserts that known plaintext never appears in the files.
/// - Writes are atomic; on iOS files get `.complete` protection and all files are excluded from backup.
/// - Record names are restricted to `[A-Za-z0-9._-]` (no path traversal).
/// - Modified or swapped files fail with `.decryptionFailed`.
public struct EncryptedFileStore: Sendable {
    public let directory: URL
    private let keys: any KeyProvider

    public init(directory: URL, keys: any KeyProvider) {
        self.directory = directory
        self.keys = keys
    }

    static func validName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 120 && !name.hasPrefix(".")
            && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }
    }

    private func url(_ name: String) throws(StoreError) -> URL {
        guard Self.validName(name) else { throw .invalidName }
        return directory.appendingPathComponent(name + ".enc")
    }

    private func prepare() throws(StoreError) {
        do {
            var dir = directory
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try dir.setResourceValues(values)
        } catch { throw .io }
    }

    public func write(_ data: Data, name: String) throws(StoreError) {
        let target = try url(name)
        try prepare()
        let blob = try Cipher.encrypt(data, key: try keys.key(), name: name)
        do {
            #if os(iOS) || os(visionOS)
                try blob.write(to: target, options: [.atomic, .completeFileProtection])
            #else
                try blob.write(to: target, options: .atomic)
            #endif
        } catch { throw .io }
    }

    public func read(name: String) throws(StoreError) -> Data {
        let source = try url(name)
        guard let blob = try? Data(contentsOf: source) else { throw .notFound }
        return try Cipher.decrypt(blob, key: try keys.key(), name: name)
    }

    public func exists(name: String) -> Bool {
        guard let u = try? url(name) else { return false }
        return FileManager.default.fileExists(atPath: u.path)
    }

    public func delete(name: String) throws(StoreError) {
        let target = try url(name)
        guard FileManager.default.fileExists(atPath: target.path) else { return }
        do { try FileManager.default.removeItem(at: target) } catch { throw .io }
    }

    /// Record names (without extension), sorted.
    public func list(prefix: String = "") -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "enc" }.map { $0.deletingPathExtension().lastPathComponent }
            .filter { $0.hasPrefix(prefix) }.sorted()
    }

    public func deleteAll() throws(StoreError) {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        do { try FileManager.default.removeItem(at: directory) } catch { throw .io }
    }

    public func writeJSON<T: Encodable>(_ value: T, name: String) throws(StoreError) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        guard let data = try? enc.encode(value) else { throw .io }
        try write(data, name: name)
    }

    public func readJSON<T: Decodable>(_ type: T.Type, name: String) throws(StoreError) -> T {
        let data = try read(name: name)
        guard let value = try? JSONDecoder().decode(T.self, from: data) else { throw .decryptionFailed }
        return value
    }
}
