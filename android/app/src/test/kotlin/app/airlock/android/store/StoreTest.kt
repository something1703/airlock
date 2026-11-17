package app.airlock.android.store

import app.airlock.core.Confidence
import app.airlock.core.DetectorId
import app.airlock.core.Entity
import app.airlock.core.EntityMap
import app.airlock.core.PrivacyCategory
import app.airlock.core.VaultEntry
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** INV-6: records are AES-256-GCM encrypted at rest, bound to their name, and unreadable once the key is destroyed. */
class StoreTest {
    private fun store() = EncryptedStore(Files.createTempDirectory("airlock-store").toFile(), SoftwareKeyProvider())

    @Test fun roundTripsAndNeverWritesPlaintext() {
        val s = store()
        s.writeText("vault", "Maya Chen lives at 14 Elm St")
        assertEquals("Maya Chen lives at 14 Elm St", s.readText("vault"))
        val raw = String(s.rawRecord("vault"), Charsets.ISO_8859_1)
        assertFalse(raw.contains("Maya"), "ciphertext only on disk")
    }

    @Test fun aRecordCannotBeMovedToAnotherName() {
        val s = store()
        s.writeText("thread-a", "secret a")
        s.putRawRecord("thread-b", s.rawRecord("thread-a"))
        assertEquals(StoreError.Code.DECRYPTION_FAILED, assertFailsWith<StoreError> { s.read("thread-b") }.code)
    }

    @Test fun tamperingIsDetected() {
        val s = store()
        s.writeText("vault", "x".repeat(40))
        val bytes = s.rawRecord("vault")
        bytes[bytes.size - 3] = (bytes[bytes.size - 3].toInt() xor 1).toByte()
        s.putRawRecord("vault", bytes)
        assertEquals(StoreError.Code.DECRYPTION_FAILED, assertFailsWith<StoreError> { s.read("vault") }.code)
    }

    @Test fun deleteEverythingRemovesFilesAndTheKey() {
        val dir = Files.createTempDirectory("airlock-store").toFile()
        val keys = SoftwareKeyProvider()
        val s = EncryptedStore(dir, keys)
        s.writeText("vault", "Maya")
        val old = s.rawRecord("vault")
        s.deleteEverything()
        assertTrue(s.list().isEmpty())
        s.putRawRecord("vault", old)
        assertFailsWith<StoreError> { s.read("vault") } // the old key is gone
    }

    @Test fun invalidNamesAreRejected() {
        val s = store()
        for (bad in listOf("", "../x", ".hidden", "a/b", "x".repeat(121))) assertFailsWith<StoreError> { s.write(bad, ByteArray(1)) }
    }

    @Test fun typedRecordsRoundTrip() {
        val stores = AirlockStores(store())
        val vault = listOf(VaultEntry("me", "Maya Chen", listOf("Maya"), PrivacyCategory.PERSON, "me", true))
        stores.saveVault(vault)
        assertEquals(vault, stores.loadVault())
        val e = Entity.make("PERSON_1", PrivacyCategory.PERSON, "Raj Patel", setOf(DetectorId.VAULT, DetectorId.LLM), Confidence.HIGH, surfaceForms = setOf("Raj"), roleHint = "my landlord", vaultEntryId = "raj")
        stores.saveEntities("t1", EntityMap(listOf(e)))
        assertEquals(e, stores.loadEntities("t1")["PERSON_1"])
        assertEquals(0, stores.loadEntities("missing").size)
    }

    @Test fun capturesArePurgedAfterTheirRetention() {
        val stores = AirlockStores(store())
        val now = 10L * 86_400_000
        stores.saveCapture("old raw text", "paste", null, now = now - 31L * 86_400_000)
        stores.saveCapture("fresh raw text", "paste", null, now = now)
        assertEquals(1, stores.purgeCaptures(30, now))
        assertContentEquals(listOf("fresh raw text"), stores.captures().map { it.text })
    }
}
