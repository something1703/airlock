package app.airlock.android.store

import java.io.File
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Why a store call failed. Never carries record contents. */
class StoreError(val code: Code) : Exception("Store error: ${code.name}") {
    enum class Code { DECRYPTION_FAILED, NOT_FOUND, INVALID_NAME, IO, UNSUPPORTED_VERSION }
}

/** Supplies the AES-256 key. Production: a non-exportable Android Keystore key; tests: an in-memory key. */
interface KeyProvider {
    /** The key, created on first use. */
    fun key(): SecretKey

    /** Destroys the key, so any leftover ciphertext becomes unreadable. A new key is created on next use. */
    fun destroy()

    /** Keystore keys generate their own IVs (randomized encryption is enforced). */
    val generatesIv: Boolean
}

/**
 * The master key lives in the Android Keystore: generated inside it (hardware-backed where available), never
 * exportable, never backed up (the manifest disables backups) — the Android analogue of a Keychain item with
 * `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` (INV-6).
 */
class AndroidKeystoreKeyProvider(private val alias: String) : KeyProvider {
    private val ks: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    override val generatesIv = true

    @Synchronized
    override fun key(): SecretKey {
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(android.security.keystore.KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            android.security.keystore.KeyGenParameterSpec.Builder(
                alias,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT or android.security.keystore.KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return gen.generateKey()
    }

    @Synchronized
    override fun destroy() {
        runCatching { ks.deleteEntry(alias) }
    }
}

/** In-memory key (unit tests). */
class SoftwareKeyProvider : KeyProvider {
    private var k: SecretKey? = null
    override val generatesIv = false

    @Synchronized
    override fun key(): SecretKey = k ?: KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { k = it }

    @Synchronized
    override fun destroy() { k = null }
}

/**
 * On-device encrypted records (port of web/src/store/encryptedStore.ts and Swift `EncryptedFileStore`, INV-6).
 * Each record is one file: `[version][12-byte IV][AES-256-GCM ciphertext + tag]`. The record's name is the GCM
 * associated data, so records can't be swapped between slots. Writes are atomic (temp file + rename).
 */
class EncryptedStore(val dir: File, private val keys: KeyProvider) {
    init {
        dir.mkdirs()
    }

    private fun file(name: String): File {
        if (!validName(name)) throw StoreError(StoreError.Code.INVALID_NAME)
        return File(dir, "$name.rec")
    }

    @Synchronized
    fun write(name: String, data: ByteArray) {
        val f = file(name)
        val blob = try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            if (keys.generatesIv) cipher.init(Cipher.ENCRYPT_MODE, keys.key())
            else cipher.init(Cipher.ENCRYPT_MODE, keys.key(), GCMParameterSpec(128, ByteArray(12).also { SecureRandom().nextBytes(it) }))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            val ct = cipher.doFinal(data)
            val iv = cipher.iv
            byteArrayOf(VERSION) + iv + ct
        } catch (e: Exception) {
            throw StoreError(StoreError.Code.IO)
        }
        try {
            val tmp = File(dir, ".$name.tmp")
            tmp.writeBytes(blob)
            if (!tmp.renameTo(f)) {
                f.delete()
                if (!tmp.renameTo(f)) throw StoreError(StoreError.Code.IO)
            }
        } catch (e: StoreError) {
            throw e
        } catch (e: Exception) {
            throw StoreError(StoreError.Code.IO)
        }
    }

    @Synchronized
    fun read(name: String): ByteArray {
        val f = file(name)
        if (!f.exists()) throw StoreError(StoreError.Code.NOT_FOUND)
        val blob = try {
            f.readBytes()
        } catch (e: Exception) {
            throw StoreError(StoreError.Code.IO)
        }
        if (blob.isEmpty() || blob[0] != VERSION) throw StoreError(StoreError.Code.UNSUPPORTED_VERSION)
        if (blob.size < 1 + 12 + 16) throw StoreError(StoreError.Code.DECRYPTION_FAILED)
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, keys.key(), GCMParameterSpec(128, blob, 1, 12))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            cipher.doFinal(blob, 13, blob.size - 13)
        } catch (e: Exception) {
            throw StoreError(StoreError.Code.DECRYPTION_FAILED)
        }
    }

    fun writeText(name: String, text: String) = write(name, text.toByteArray(Charsets.UTF_8))
    fun readText(name: String): String = read(name).toString(Charsets.UTF_8)

    @Synchronized
    fun list(prefix: String = ""): List<String> =
        dir.listFiles().orEmpty().map { it.name }.filter { it.endsWith(".rec") && !it.startsWith(".") }.map { it.removeSuffix(".rec") }
            .filter { it.startsWith(prefix) }.sorted()

    @Synchronized
    fun delete(name: String) {
        file(name).delete()
    }

    /** Settings → Delete everything: every record (overwritten, then removed), then the key itself. */
    @Synchronized
    fun deleteEverything() {
        for (f in dir.listFiles().orEmpty()) {
            runCatching { if (f.isFile) f.writeBytes(ByteArray(f.length().toInt().coerceAtMost(1 shl 20))) }
            f.deleteRecursively()
        }
        keys.destroy()
        dir.mkdirs()
    }

    /** Raw file bytes (tests and tamper checks only). */
    internal fun rawRecord(name: String): ByteArray = file(name).readBytes()
    internal fun putRawRecord(name: String, bytes: ByteArray) = file(name).writeBytes(bytes)

    companion object {
        private const val VERSION: Byte = 1
        private val NAME = Regex("^[A-Za-z0-9._-]+$")
        fun validName(n: String): Boolean = n.isNotEmpty() && n.length <= 120 && !n.startsWith(".") && NAME.matches(n)
    }
}
