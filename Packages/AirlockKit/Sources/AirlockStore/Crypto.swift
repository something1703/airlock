import CryptoKit
import Foundation
import Security

/// Storage failures. No case carries content or key material (INV-8).
public enum StoreError: Error, Sendable, Hashable {
    /// The encryption key couldn't be read or created (`status` is the Keychain OSStatus).
    case keyUnavailable(status: Int32)
    /// Wrong key, a modified file, or a record moved to another name.
    case decryptionFailed
    case notFound
    case invalidName
    case io
    case unsupportedVersion
}

/// Supplies the AES-256 key that protects everything sensitive on disk.
public protocol KeyProvider: Sendable {
    func key() throws(StoreError) -> SymmetricKey
    /// Destroys the key — everything encrypted with it becomes unreadable ("Delete everything").
    func deleteKey() throws(StoreError)
}

/// A key held in memory only (tests, previews).
public final class InMemoryKeyProvider: KeyProvider, @unchecked Sendable {
    private let lock = NSLock()
    private var current: SymmetricKey?

    public init(key: SymmetricKey? = nil) {
        current = key
    }

    public func key() throws(StoreError) -> SymmetricKey {
        lock.withLock {
            if let current { return current }
            let k = SymmetricKey(size: .bits256)
            current = k
            return k
        }
    }

    public func deleteKey() throws(StoreError) { lock.withLock { current = nil } }
}

/// The real key provider: a random 256-bit key in the Keychain (INV-6).
///
/// Guarantees: `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (readable only while the device is
/// unlocked, never in a backup or iCloud Keychain) and `kSecAttrSynchronizable = false`.
public struct KeychainKeyProvider: KeyProvider {
    public let service: String
    public let account: String

    public init(service: String = "app.airlock.store", account: String = "master-key-v1") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false, kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func key() throws(StoreError) -> SymmetricKey {
        if let data = try read() { return SymmetricKey(data: data) }
        let fresh = SymmetricKey(size: .bits256)
        var add = baseQuery
        add[kSecValueData as String] = fresh.withUnsafeBytes { Data($0) }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem, let data = try read() { return SymmetricKey(data: data) }  // lost a race
        guard status == errSecSuccess else { throw .keyUnavailable(status: status) }
        return fresh
    }

    private func read() throws(StoreError) -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data, data.count == 32 else { throw .keyUnavailable(status: status) }
        return data
    }

    public func deleteKey() throws(StoreError) {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw .keyUnavailable(status: status) }
    }
}

/// AES-256-GCM with the record name bound in as authenticated data.
///
/// Format: `0x01 || nonce(12) || ciphertext || tag(16)`. Because the name is authenticated,
/// copying one encrypted record over another fails to decrypt instead of silently swapping data.
enum Cipher {
    static let version: UInt8 = 1

    static func encrypt(_ plaintext: Data, key: SymmetricKey, name: String) throws(StoreError) -> Data {
        do {
            let box = try AES.GCM.seal(plaintext, using: key, authenticating: Data(name.utf8))
            guard let combined = box.combined else { throw StoreError.io }
            return Data([version]) + combined
        } catch { throw .io }
    }

    static func decrypt(_ blob: Data, key: SymmetricKey, name: String) throws(StoreError) -> Data {
        guard let first = blob.first else { throw .decryptionFailed }
        guard first == version else { throw .unsupportedVersion }
        do {
            let box = try AES.GCM.SealedBox(combined: blob.dropFirst())
            return try AES.GCM.open(box, using: key, authenticating: Data(name.utf8))
        } catch { throw .decryptionFailed }
    }
}
