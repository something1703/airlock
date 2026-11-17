package app.airlock.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.airlock.android.session.AirlockSession
import app.airlock.android.ui.AirlockLogo
import app.airlock.android.ui.AppRoot
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The single activity. `demo=true` (intent extra, or the "Try the demo" launcher shortcut) opens demo mode; text shared
 * from another app (ACTION_SEND) lands in Ask's box — nothing is read until the user taps Seal.
 */
class MainActivity : ComponentActivity() {
    private val shared = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val demo = intent.getBooleanExtra(EXTRA_DEMO, false) || intent.extras?.getString(EXTRA_DEMO) == "true"
        if (savedInstanceState == null) handleShare(intent)
        setContent { AirlockTheme { Root(demo) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    private fun handleShare(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND && intent.type?.startsWith("text/") == true) {
            intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }?.let { shared.value = it }
        }
    }

    @Composable
    private fun Root(demo: Boolean) {
        val ctx = LocalContext.current
        val session by produceState<AirlockSession?>(null, demo) { value = AirlockApp.session(ctx.applicationContext, demo) }
        val pending by shared.collectAsState()
        val s = session
        if (s == null) {
            Box(Modifier.fillMaxSize().background(LocalAirlock.current.bg), contentAlignment = Alignment.Center) { AirlockLogo(64.dp, animated = true) }
            return
        }
        LaunchedEffect(pending) {
            pending?.let {
                s.receiveShared(it)
                shared.value = null
            }
        }
        AppRoot(s)
    }

    companion object {
        const val EXTRA_DEMO = "demo"
    }
}
