package app.airlock.android

import android.app.Application
import android.content.Context
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.ServiceFactory
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Boots Firebase and App Check before any AI call. Debug builds use the App Check debug provider
 * (its token prints to logcat once; register it in the console, never commit it); release builds
 * use Play Integrity. Holds the session for the process, so rotation and backgrounding keep state.
 */
class AirlockApp : Application() {
    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)
        FirebaseAppCheck.getInstance().installAppCheckProviderFactory(
            if (BuildConfig.DEBUG) DebugAppCheckProviderFactory.getInstance() else PlayIntegrityAppCheckProviderFactory.getInstance(),
        )
    }

    companion object {
        /** Sealing and answering run off the main thread; the UI collects state. */
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val lock = Mutex()
        private val sessions = HashMap<Boolean, AirlockSession>()

        /** The live or demo session (each with its own encrypted store), created and loaded once. */
        suspend fun session(ctx: Context, demo: Boolean): AirlockSession = lock.withLock {
            sessions[demo] ?: AirlockSession(ServiceFactory.create(ctx, demo), scope).also {
                it.run { load() } // The UI shows the logo until `loaded`.
                sessions[demo] = it
            }
        }
    }
}
