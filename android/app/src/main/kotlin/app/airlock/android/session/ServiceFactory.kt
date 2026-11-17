package app.airlock.android.session

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import app.airlock.android.AppConfig
import app.airlock.android.engines.DemoEngines
import app.airlock.android.engines.FirebaseEngines
import app.airlock.android.store.AirlockStores
import app.airlock.android.store.AndroidKeystoreKeyProvider
import app.airlock.android.store.EncryptedStore
import app.airlock.core.AnswerPreference
import app.airlock.core.DialPreset
import app.airlock.core.PatternDetector
import app.airlock.core.PhoneAvailability
import app.airlock.core.PromptLibrary
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.FirebaseRemoteConfigSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import kotlin.coroutines.resume

/** Builds [Services] on a device: live (Firebase AI Logic) or demo (scripted, separate encrypted store). */
object ServiceFactory {
    /** The CI placeholder `google-services.json` (android/ci) is not a real project. */
    private const val PLACEHOLDER_PROJECT = "airlock-ci-placeholder"

    fun firebaseConfigured(ctx: Context): Boolean {
        val app = FirebaseApp.getApps(ctx).firstOrNull() ?: return false
        return app.options.projectId != null && app.options.projectId != PLACEHOLDER_PROJECT
    }

    suspend fun create(ctx: Context, demoRequested: Boolean): Services = withContext(Dispatchers.IO) {
        val app = ctx.applicationContext
        val demo = demoRequested || !firebaseConfigured(app)
        // Demo mode gets its own directory, key and preferences so scripted receipts never mix with real ones.
        val name = if (demo) "airlock-demo" else "airlock"
        val stores = AirlockStores(EncryptedStore(File(app.noBackupFilesDir, name), AndroidKeystoreKeyProvider("$name-master-v1")))
        val prefs = SharedPrefsStore(app, "$name.prefs")
        if (demo) {
            val config = AppConfig()
            return@withContext Services(
                config, PromptLibrary(config.promptOverridesJson), PatternDetector(disabled = config.disabledPatternPacks), DemoEngines.provider(),
                stores, prefs, AppMode.DEMO, if (demoRequested) DemoReason.REQUESTED else DemoReason.NO_FIREBASE,
                availability = { PhoneAvailability.AVAILABLE },
            )
        }
        val config = AppConfig(loadRemoteConfig())
        val prompts = PromptLibrary(config.promptOverridesJson)
        val engines = FirebaseEngines(FirebaseApp.getInstance(), config, prompts) { isOnline(app) }
        Services(
            config, prompts, PatternDetector(disabled = config.disabledPatternPacks), engines, stores, prefs, AppMode.LIVE,
            availability = { engines.phone.availability() },
            download = { engines.caller.download() },
            warmUp = { engines.caller.warmUp() },
        )
    }

    fun isOnline(ctx: Context): Boolean {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /** Remote Config (model names, thresholds, prompt overrides) over the bundled defaults; 4 s budget, else defaults. */
    private suspend fun loadRemoteConfig(): Map<String, String> = try {
        val rc = FirebaseRemoteConfig.getInstance()
        rc.setConfigSettingsAsync(FirebaseRemoteConfigSettings.Builder().setMinimumFetchIntervalInSeconds(3600).setFetchTimeoutInSeconds(4).build()).awaitOrNull()
        rc.setDefaultsAsync(AppConfig.REMOTE_DEFAULTS).awaitOrNull()
        withTimeoutOrNull(4500) { rc.fetchAndActivate().awaitOrNull() }
        rc.all.mapValues { it.value.asString() }
    } catch (_: Exception) {
        emptyMap()
    }

    private suspend fun <T> Task<T>.awaitOrNull(): T? = suspendCancellableCoroutine { c ->
        addOnCompleteListener { t -> if (c.isActive) c.resume(if (t.isSuccessful) t.result else null) }
    }
}

/** Preferences in SharedPreferences (dial, answer preference, onboarded — nothing sensitive). */
class SharedPrefsStore(ctx: Context, file: String) : PrefsStore {
    private val sp = ctx.getSharedPreferences(file, Context.MODE_PRIVATE)

    override fun load(): Prefs? {
        if (!sp.contains("onboarded")) return null
        return Prefs(
            dial = DialPreset.entries.firstOrNull { it.wire == sp.getString("dial", null) } ?: DialPreset.BALANCED,
            preference = AnswerPreference.entries.firstOrNull { it.wire == sp.getString("preference", null) } ?: AnswerPreference.AUTO,
            onboarded = sp.getBoolean("onboarded", false),
        )
    }

    override fun save(p: Prefs) {
        sp.edit().putString("dial", p.dial.wire).putString("preference", p.preference.wire).putBoolean("onboarded", p.onboarded).apply()
    }

    override fun clear() {
        sp.edit().clear().apply()
    }
}
