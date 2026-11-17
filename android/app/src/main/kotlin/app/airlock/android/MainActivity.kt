package app.airlock.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.Firebase
import com.google.firebase.ai.InferenceMode
import com.google.firebase.ai.OnDeviceConfig
import com.google.firebase.ai.ai
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.PublicPreviewAPI

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { AirlockTheme { Probe() } }
    }
}

/** Temporary first screen: brand + the on-device model status straight from the SDK. Replaced by the full app. */
@OptIn(PublicPreviewAPI::class)
@Composable
private fun Probe() {
    val c = LocalAirlock.current
    var status by remember { mutableStateOf("Checking the on-device model…") }
    LaunchedEffect(Unit) {
        status = runCatching {
            val model = Firebase.ai(backend = GenerativeBackend.googleAI())
                .generativeModel(modelName = "unused-on-device-only", onDeviceConfig = OnDeviceConfig(mode = InferenceMode.ONLY_ON_DEVICE))
            model.onDeviceExtension?.checkStatus()?.toString() ?: "On-device AI isn't available in this build"
        }.getOrElse { "On-device AI unavailable on this phone (${it.javaClass.simpleName})" }
    }
    Column(
        Modifier.fillMaxSize().background(c.bg).safeDrawingPadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Airlock", color = c.text, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        Text("AI is great. Oversharing isn’t.", color = c.text2, fontSize = 16.sp)
        Text("On-device model: $status", color = c.seal, fontSize = 14.sp)
    }
}
