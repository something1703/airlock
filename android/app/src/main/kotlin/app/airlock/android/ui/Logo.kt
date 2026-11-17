package app.airlock.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.airlock.android.LocalAirlock

/** Same curve as the web's `--ease-out`. */
val EaseOutExpo = CubicBezierEasing(0.22f, 1f, 0.36f, 1f)

/** True when the user turned animations off (Settings → Accessibility → Remove animations). */
@Composable
fun reduceMotion(): Boolean {
    val ctx = LocalContext.current
    return remember {
        android.provider.Settings.Global.getFloat(ctx.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
}

/**
 * The Airlock mark: two nested arcs (the doors) over a sill, on a 64-unit grid like the web SVG.
 * `animated` draws the arcs on, then lets the inner door breathe.
 */
@Composable
fun AirlockLogo(size: Dp = 32.dp, animated: Boolean = false, modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    val still = !animated || reduceMotion()
    val outer = remember { Animatable(if (still) 1f else 0f) }
    val inner = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(still) {
        if (!still) {
            outer.animateTo(1f, tween(900, easing = EaseOutExpo))
        }
    }
    LaunchedEffect(still) {
        if (!still) {
            kotlinx.coroutines.delay(180)
            inner.animateTo(1f, tween(900, easing = EaseOutExpo))
        }
    }
    val breathe = if (still) 1f else rememberInfiniteTransition(label = "breathe").animateFloat(
        initialValue = 1f, targetValue = 0.45f, animationSpec = infiniteRepeatable(tween(1800), RepeatMode.Reverse), label = "inner",
    ).value
    Canvas(modifier.size(size)) {
        val u = this.size.width / 64f
        val seal = c.seal
        // Outer arc: centre (32,42), radius 20; inner: radius 11. Sweep from 180° clockwise.
        drawArc(seal, 180f, 180f * outer.value, false, Offset(12 * u, 22 * u), Size(40 * u, 40 * u), style = Stroke(5 * u, cap = StrokeCap.Round))
        drawArc(seal.copy(alpha = if (inner.value >= 1f) breathe else 1f), 180f, 180f * inner.value, false, Offset(21 * u, 31 * u), Size(22 * u, 22 * u), style = Stroke(5 * u, cap = StrokeCap.Round))
        drawLine(c.text2.copy(alpha = 0.6f), Offset(10 * u, 50 * u), Offset((10 + 44 * outer.value) * u, 50 * u), 3 * u, StrokeCap.Round)
    }
}
