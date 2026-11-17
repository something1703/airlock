import AirlockCore
import AirlockDetect
import CryptoKit
import Foundation
import Testing

@testable import AirlockStore

func tempDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("airlock-store-test-\(UUID().uuidString)")
}

/// All bytes of every file under `dir`.
func allBytes(_ dir: URL) -> Data {
    var all = Data()
    let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
    for f in files { all += (try? Data(contentsOf: f)) ?? Data() }
    for f in files { all += Data(f.lastPathComponent.utf8) }
    return all
}

@Suite struct EncryptedFileStoreTests {
    @Test func roundTripAndNoPlaintextOnDisk() throws {
        let dir = tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = EncryptedFileStore(directory: dir, keys: InMemoryKeyProvider())
        let secret = "Raj Patel, 14 Elm St, mercy general hospital"
        try store.write(Data(secret.utf8), name: "note")
        #expect(try store.read(name: "note") == Data(secret.utf8))
        let bytes = allBytes(dir)
        #expect(!bytes.isEmpty)
        for needle in ["Raj", "Patel", "Elm", "mercy"] { #expect(bytes.range(of: Data(needle.utf8)) == nil, "\(needle) found on disk") }
    }

    @Test func wrongKeyAndTamperingFail() throws {
        let dir = tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let keys = InMemoryKeyProvider()
        let store = EncryptedFileStore(directory: dir, keys: keys)
        try store.write(Data("hello".utf8), name: "a")

        #expect(throws: StoreError.decryptionFailed) { try EncryptedFileStore(directory: dir, keys: InMemoryKeyProvider()).read(name: "a") }

        let file = dir.appendingPathComponent("a.enc")
        var blob = try Data(contentsOf: file)
        blob[blob.count - 1] ^= 0x01
        try blob.write(to: file)
        #expect(throws: StoreError.decryptionFailed) { try store.read(name: "a") }
    }

    /// The record name is authenticated: copying one record over another can't swap data.
    @Test func recordsCannotBeSwapped() throws {
        let dir = tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = EncryptedFileStore(directory: dir, keys: InMemoryKeyProvider())
        try store.write(Data("one".utf8), name: "one")
        try store.write(Data("two".utf8), name: "two")
        try FileManager.default.removeItem(at: dir.appendingPathComponent("two.enc"))
        try FileManager.default.copyItem(at: dir.appendingPathComponent("one.enc"), to: dir.appendingPathComponent("two.enc"))
        #expect(throws: StoreError.decryptionFailed) { try store.read(name: "two") }
    }

    @Test func nameValidationBlocksTraversal() {
        let store = EncryptedFileStore(directory: tempDirectory(), keys: InMemoryKeyProvider())
        for bad in ["../x", "a/b", ".hidden", "", "a b", "é", String(repeating: "a", count: 121)] {
            #expect(throws: StoreError.invalidName) { try store.write(Data(), name: bad) }
        }
    }

    @Test func missingAndEmpty() throws {
        let store = EncryptedFileStore(directory: tempDirectory(), keys: InMemoryKeyProvider())
        #expect(throws: StoreError.notFound) { try store.read(name: "nope") }
        #expect(store.list().isEmpty && !store.exists(name: "nope"))
        try store.delete(name: "nope")
    }

    @Test func versionByteIsChecked() throws {
        let dir = tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = EncryptedFileStore(directory: dir, keys: InMemoryKeyProvider())
        try store.write(Data("x".utf8), name: "v")
        let file = dir.appendingPathComponent("v.enc")
        var blob = try Data(contentsOf: file)
        blob[0] = 9
        try blob.write(to: file)
        #expect(throws: StoreError.unsupportedVersion) { try store.read(name: "v") }
    }
}

@Suite struct AirlockStoresTests {
    func make() -> (AirlockStores, URL, InMemoryKeyProvider) {
        let dir = tempDirectory()
        let keys = InMemoryKeyProvider()
        return (AirlockStores(directory: dir, keys: keys), dir, keys)
    }

    @Test func entityMapAndVaultAreEncryptedAtRest() async throws {
        let (stores, dir, _) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        let raj = Entity(
            id: PlaceholderID(category: .person, number: 1), category: .person, canonical: "Raj Patel", surfaceForms: ["Raj"],
            roleHint: "the user's landlord",
            sources: [.vault], confidence: .high, vaultEntryID: "v1")
        try await stores.saveEntities(EntityMap([raj]), thread: "thr_1")
        try await stores.saveVault([
            VaultEntry(id: "v1", canonical: "Raj Patel", aliases: ["Raj"], category: .person, roleHint: "my landlord")
        ])

        let loaded = try await stores.loadEntities(thread: "thr_1")
        #expect(loaded[raj.id]?.canonical == "Raj Patel" && loaded[raj.id]?.vaultEntryID == "v1")
        #expect(try await stores.loadVault().first?.aliases == ["Raj"])
        #expect(try await stores.loadEntities(thread: "unknown").entities.isEmpty)

        let bytes = allBytes(dir)
        for needle in ["Raj", "Patel", "landlord", "PERSON_1"] { #expect(bytes.range(of: Data(needle.utf8)) == nil, "\(needle) on disk") }
    }

    @Test func capturesSaveListAndPurge() async throws {
        let (stores, dir, _) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let day: TimeInterval = 86_400
        try await stores.saveCapture(RawText("old lease text about Mercy General", source: .paste), now: now - 40 * day, id: "old")
        try await stores.saveCapture(RawText("recent text", source: .photo), thread: "thr_1", now: now - 5 * day, id: "recent")
        try await stores.saveCapture(RawText("today", source: .pdf), now: now, id: "today")

        #expect(await stores.captures().map(\.id) == ["today", "recent", "old"], "newest first")
        #expect(try await stores.loadCapture(id: "recent").text.source == .photo)
        #expect(allBytes(dir).range(of: Data("Mercy".utf8)) == nil, "raw text is encrypted too")

        #expect(await stores.purgeCaptures(olderThanDays: 30, now: now) == 1)
        #expect(await stores.captures().map(\.id) == ["today", "recent"])
        #expect(await stores.purgeCaptures(olderThanDays: 30, now: now) == 0)
        #expect(await stores.purgeCaptures(olderThanDays: 0, now: now + 1) == 2)
    }

    @Test func purgeRemovesUnreadableRecords() async throws {
        let dir = tempDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        try await AirlockStores(directory: dir, keys: InMemoryKeyProvider()).saveCapture(RawText("x", source: .paste), id: "a")
        // A new key can't read it; purge clears it rather than letting it linger.
        let other = AirlockStores(directory: dir, keys: InMemoryKeyProvider())
        #expect(await other.captures().isEmpty)
        #expect(await other.purgeCaptures(olderThanDays: 30) == 1)
    }

    @Test func deleteThreadRemovesItsEntitiesAndCaptures() async throws {
        let (stores, dir, _) = make()
        defer { try? FileManager.default.removeItem(at: dir) }
        try await stores.saveEntities(EntityMap(), thread: "t1")
        try await stores.saveCapture(RawText("a", source: .paste), thread: "t1", id: "c1")
        try await stores.saveCapture(RawText("b", source: .paste), thread: "t2", id: "c2")
        try await stores.deleteThread("t1")
        #expect(await stores.captures().map(\.id) == ["c2"])
    }

    @Test func deleteEverythingDestroysFilesAndKey() async throws {
        let (stores, dir, keys) = make()
        let keyBefore = try keys.key()
        try await stores.saveVault([VaultEntry(id: "v", canonical: "Maya Chen", category: .person)])
        let leftover = try Data(contentsOf: dir.appendingPathComponent("vault.enc"))

        try await stores.deleteEverything()
        #expect(!FileManager.default.fileExists(atPath: dir.path))
        // Even a copied-away ciphertext is unreadable: the key is gone and a new one differs.
        let newKey = try keys.key()
        #expect(newKey.withUnsafeBytes { Data($0) } != keyBefore.withUnsafeBytes { Data($0) })
        #expect(throws: StoreError.decryptionFailed) { try Cipher.decrypt(leftover, key: newKey, name: "vault") }
    }

    @Test func threadIdsAreMadeFilenameSafe() {
        #expect(AirlockStores.safe("thr/../etc") == "thr____etc")
        #expect(AirlockStores.safe(String(repeating: "a", count: 300)).count == 100)
    }
}

@Suite struct KeychainKeyProviderTests {
    /// Uses the real Keychain. Skips quietly where the test host lacks Keychain entitlements.
    @Test func createsPersistsAndDeletesKey() throws {
        let provider = KeychainKeyProvider(service: "app.airlock.tests.\(UUID().uuidString)", account: "k")
        // Written without `catch … where` + definite initialisation: that shape crashes the Swift 6.3
        // compiler (signal 10 in SIL passes; GitHub's macOS runner has 6.3.3).
        let firstResult = Result { () throws(StoreError) -> SymmetricKey in try provider.key() }
        if case .failure(.keyUnavailable(let status)) = firstResult, status == errSecMissingEntitlement || status == -25308 {
            // Unsigned test hosts have no Keychain entitlement (-34018). Report as skipped, not passed;
            // the real path is verified in the signed app (docs/09-TESTING.md §5).
            try Test.cancel("Keychain unavailable in this test host (status \(status))")
        }
        let first = try firstResult.get()
        defer { try? provider.deleteKey() }
        let again = try provider.key()
        #expect(first.withUnsafeBytes { Data($0) } == again.withUnsafeBytes { Data($0) }, "same key on every read")
        #expect(first.bitCount == 256)
        try provider.deleteKey()
        let fresh = try provider.key()
        #expect(fresh.withUnsafeBytes { Data($0) } != first.withUnsafeBytes { Data($0) })
        try provider.deleteKey()
    }
}
