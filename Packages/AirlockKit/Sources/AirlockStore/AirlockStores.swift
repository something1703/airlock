import AirlockCore
import AirlockDetect
import CryptoKit
import Foundation

/// One saved raw capture (local only, auto-purged; `docs/02-ARCHITECTURE.md` §7).
public struct CaptureRecord: Sendable, Hashable, Identifiable {
    public let id: String
    public let createdAt: Date
    public let threadID: String?
    public let text: RawText
}

/// All on-device persistence for sensitive data. Nothing here ever syncs (INV-6, ADR-09).
///
/// Guarantees:
/// - The per-thread entity map, the Vault and raw captures are AES-256-GCM encrypted with a
///   Keychain key (`KeychainKeyProvider`); no plaintext name or raw text reaches disk.
/// - `purgeCaptures(olderThan:)` deletes raw captures older than N days (`raw_purge_days`).
/// - `deleteEverything()` removes every file **and** destroys the key, so even a leftover copy
///   of the files is unreadable.
public actor AirlockStores {
    private let store: EncryptedFileStore
    private let keys: any KeyProvider

    public init(directory: URL, keys: any KeyProvider) {
        store = EncryptedFileStore(directory: directory, keys: keys)
        self.keys = keys
    }

    // MARK: Entity maps (per thread)

    public func saveEntities(_ map: EntityMap, thread: String) throws(StoreError) {
        try store.writeJSON(map, name: "entities-" + Self.safe(thread))
    }

    public func loadEntities(thread: String) throws(StoreError) -> EntityMap {
        do { return try store.readJSON(EntityMap.self, name: "entities-" + Self.safe(thread)) } catch .notFound { return EntityMap() }
    }

    public func deleteThread(_ thread: String) throws(StoreError) {
        try store.delete(name: "entities-" + Self.safe(thread))
        for c in store.list(prefix: "capture-") {
            if let rec = try? loadCapture(named: c), rec.threadID == thread { try store.delete(name: c) }
        }
    }

    // MARK: Vault

    public func saveVault(_ entries: [VaultEntry]) throws(StoreError) { try store.writeJSON(entries, name: "vault") }

    public func loadVault() throws(StoreError) -> [VaultEntry] {
        do { return try store.readJSON([VaultEntry].self, name: "vault") } catch .notFound { return [] }
    }

    // MARK: Raw captures

    struct StoredCapture: Codable {
        let id: String
        let createdAt: Date
        let threadID: String?
        let source: CaptureSource
        let text: String
    }

    @discardableResult
    public func saveCapture(_ raw: RawText, thread: String? = nil, now: Date = Date(), id: String = UUID().uuidString) throws(StoreError)
        -> CaptureRecord
    {
        let stored = StoredCapture(id: id, createdAt: now, threadID: thread, source: raw.source, text: raw.value)
        try store.writeJSON(stored, name: "capture-" + Self.safe(id))
        return CaptureRecord(id: id, createdAt: now, threadID: thread, text: raw)
    }

    private func loadCapture(named name: String) throws(StoreError) -> CaptureRecord {
        let s = try store.readJSON(StoredCapture.self, name: name)
        return CaptureRecord(id: s.id, createdAt: s.createdAt, threadID: s.threadID, text: RawText(s.text, source: s.source))
    }

    public func loadCapture(id: String) throws(StoreError) -> CaptureRecord { try loadCapture(named: "capture-" + Self.safe(id)) }

    public func captures() -> [CaptureRecord] {
        store.list(prefix: "capture-").compactMap { try? loadCapture(named: $0) }.sorted { $0.createdAt > $1.createdAt }
    }

    public func deleteCapture(id: String) throws(StoreError) { try store.delete(name: "capture-" + Self.safe(id)) }

    /// Deletes captures older than `days` days; returns how many were removed. Unreadable
    /// records (wrong key / corrupted) are removed too — they're useless and would linger forever.
    @discardableResult
    public func purgeCaptures(olderThanDays days: Int, now: Date = Date()) -> Int {
        let cutoff = now.addingTimeInterval(-Double(max(0, days)) * 86_400)
        var removed = 0
        for name in store.list(prefix: "capture-") {
            let keep = (try? loadCapture(named: name)).map { $0.createdAt >= cutoff } ?? false
            if !keep, (try? store.delete(name: name)) != nil { removed += 1 }
        }
        return removed
    }

    // MARK: Everything

    /// Settings → Delete everything: files first, then the key.
    public func deleteEverything() throws(StoreError) {
        try store.deleteAll()
        try keys.deleteKey()
    }

    /// Record ids are ours (UUIDs / thread ids); anything else is made filename-safe.
    static func safe(_ id: String) -> String {
        let cleaned = id.map { ($0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")) ? $0 : "_" }
        return String(cleaned.prefix(100))
    }
}
