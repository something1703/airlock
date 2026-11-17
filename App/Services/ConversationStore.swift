import AirlockCore
import AirlockStore
import Foundation

/// A sealed turn as saved: the draft text and legend that passed the gate, plus the user's
/// "reveal this time" / "send as written" choices. Never trusted on load — it is re-gated (INV-2).
struct StoredSealed: Codable, Sendable, Hashable {
    let text: String
    let legend: [LegendLine]
    let revealedVaultIDs: [String]
    let keptValues: [String]
}

struct StoredOutcome: Codable, Sendable, Hashable {
    let route: Route
    let modelVersion: String
    let ranOnDevice: Bool
    let fellBackToPhone: Bool
    let latencyMs: Int
    let receiptID: String?
}

enum StoredTurn: Codable, Sendable {
    /// `raw` is what the user wrote — encrypted at rest, local only.
    case user(raw: String, sealed: StoredSealed)
    /// `modelText` is the model's placeholder text (never restored text).
    case assistant(task: TaskOption, status: AssistantTurn.Status, modelText: String, failure: AnswerFailure?, outcome: StoredOutcome?)
}

struct StoredThread: Codable, Sendable {
    var v = 1
    let id: String
    let title: String
    let task: TaskOption
    let createdAt: Date
    let updatedAt: Date
    let turns: [StoredTurn]
}

/// Saved conversations and receipts, AES-GCM encrypted with the same Keychain key as
/// `AirlockStores` (INV-6). Local only; nothing here syncs.
///
/// Guarantees: `deleteAll()` removes every file; the app calls it **before**
/// `AirlockStores.deleteEverything()` destroys the key.
actor ConversationStore {
    private let store: EncryptedFileStore

    init(directory: URL, keys: any KeyProvider) {
        store = EncryptedFileStore(directory: directory, keys: keys)
    }

    func save(_ thread: StoredThread) throws(StoreError) {
        try store.writeJSON(thread, name: "thread-" + Self.safe(thread.id))
    }

    func threads() -> [StoredThread] {
        store.list(prefix: "thread-").compactMap { try? store.readJSON(StoredThread.self, name: $0) }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func deleteThread(_ id: String) throws(StoreError) {
        try store.delete(name: "thread-" + Self.safe(id))
    }

    func saveReceipts(_ receipts: [Receipt]) throws(StoreError) {
        try store.writeJSON(receipts, name: "receipts")
    }

    func receipts() -> [Receipt] {
        (try? store.readJSON([Receipt].self, name: "receipts")) ?? []
    }

    func deleteAll() throws(StoreError) {
        try store.deleteAll()
    }

    private static func safe(_ id: String) -> String {
        String(id.map { ($0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-")) ? $0 : "_" }.prefix(100))
    }
}
