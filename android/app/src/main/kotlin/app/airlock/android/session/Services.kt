package app.airlock.android.session

import app.airlock.android.AppConfig
import app.airlock.android.engines.DownloadEvent
import app.airlock.android.store.AirlockStores
import app.airlock.core.AnswerPreference
import app.airlock.core.DialPreset
import app.airlock.core.EngineProvider
import app.airlock.core.PatternDetector
import app.airlock.core.PhoneAvailability
import app.airlock.core.PromptLibrary
import kotlinx.coroutines.flow.Flow

/** Which engines are behind the UI. */
enum class AppMode {
    /** Firebase AI Logic: Gemini Nano on device + Gemini in the cloud. */
    LIVE,

    /** Scripted engines; labelled in every screen that shows AI output. */
    DEMO,
}

/** Why demo mode is on (the banner says which). */
enum class DemoReason { REQUESTED, NO_FIREBASE }

/** User preferences (not sensitive; kept outside the encrypted store). */
data class Prefs(val dial: DialPreset = DialPreset.BALANCED, val preference: AnswerPreference = AnswerPreference.AUTO, val onboarded: Boolean = false)

/** Where [Prefs] live. */
interface PrefsStore {
    fun load(): Prefs?
    fun save(p: Prefs)
    fun clear()
}

class MemoryPrefsStore(private var p: Prefs? = null) : PrefsStore {
    override fun load() = p
    override fun save(p: Prefs) { this.p = p }
    override fun clear() { p = null }
}

/** Everything the session needs; built by `ServiceFactory` on device and by hand in tests. */
class Services(
    val config: AppConfig,
    val prompts: PromptLibrary,
    val patterns: PatternDetector,
    val engines: EngineProvider,
    val stores: AirlockStores,
    val prefs: PrefsStore,
    val mode: AppMode,
    val demoReason: DemoReason? = null,
    /** On-device model state (live: `OnDeviceExtension.checkStatus`). */
    val availability: suspend () -> PhoneAvailability,
    /** Gemini Nano download (live only). */
    val download: (() -> Flow<DownloadEvent>)? = null,
    /** Loads Gemini Nano before the first seal (live only). */
    val warmUp: (suspend () -> Unit)? = null,
)
