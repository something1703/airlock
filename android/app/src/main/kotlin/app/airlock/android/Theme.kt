package app.airlock.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** Airlock's design tokens — the same palette as the web app (docs/06-UI-UX.md §2). Colour always carries meaning. */
@Immutable
data class AirlockColors(
    val bg: Color, val raised: Color, val text: Color, val text2: Color, val stroke: Color,
    val seal: Color, val sealTint: Color, val cloud: Color, val cloudTint: Color,
    val review: Color, val reviewTint: Color, val risk: Color, val riskTint: Color,
)

val LightAirlock = AirlockColors(
    bg = Color(0xFFF6F7F9), raised = Color.White, text = Color(0xFF0E1726), text2 = Color(0xFF4A5568), stroke = Color(0xFFE2E6EC),
    seal = Color(0xFF0FA97E), sealTint = Color(0xFFE3F7F0), cloud = Color(0xFF3366E8), cloudTint = Color(0xFFE7EEFD),
    review = Color(0xFFB7791F), reviewTint = Color(0xFFFDF3E2), risk = Color(0xFFD64545), riskTint = Color(0xFFFBE9E9),
)
val DarkAirlock = AirlockColors(
    bg = Color(0xFF0B111C), raised = Color(0xFF141C2B), text = Color(0xFFEEF2F8), text2 = Color(0xFFA3AEC2), stroke = Color(0xFF24304A),
    seal = Color(0xFF2BD9A6), sealTint = Color(0xFF123A30), cloud = Color(0xFF6E97FF), cloudTint = Color(0xFF17264A),
    review = Color(0xFFFFC062), reviewTint = Color(0xFF3A2C12), risk = Color(0xFFFF7A6E), riskTint = Color(0xFF3E1C1C),
)

val LocalAirlock = staticCompositionLocalOf { LightAirlock }

@Composable
fun AirlockTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val c = if (dark) DarkAirlock else LightAirlock
    val scheme = if (dark) darkColorScheme(primary = c.seal, background = c.bg, surface = c.raised, onBackground = c.text, onSurface = c.text, error = c.risk)
    else lightColorScheme(primary = c.seal, background = c.bg, surface = c.raised, onBackground = c.text, onSurface = c.text, error = c.risk)
    androidx.compose.runtime.CompositionLocalProvider(LocalAirlock provides c) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
