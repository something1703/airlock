package app.airlock.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.AirlockColors
import app.airlock.android.LocalAirlock
import kotlinx.coroutines.delay

// MARK: Type

object Type {
    val h1 = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.2).sp)
    val h2 = TextStyle(fontSize = 19.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold)
    val body = TextStyle(fontSize = 16.sp, lineHeight = 26.sp)
    val bodyBold = body.copy(fontWeight = FontWeight.SemiBold)
    val small = TextStyle(fontSize = 13.sp, lineHeight = 19.sp)
    val mono = TextStyle(fontSize = 12.5.sp, lineHeight = 18.sp, fontFamily = FontFamily.Monospace)
    val hero = TextStyle(fontSize = 56.sp, lineHeight = 58.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1).sp)
}

@Composable
fun H1(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.semantics { heading() }, style = Type.h1, color = LocalAirlock.current.text)
}

@Composable
fun H2(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.semantics { heading() }, style = Type.h2, color = LocalAirlock.current.text)
}

@Composable
fun Sub(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = Type.body.copy(lineHeight = 23.sp), color = LocalAirlock.current.text2)
}

@Composable
fun Small(text: String, modifier: Modifier = Modifier, color: Color = LocalAirlock.current.text2) {
    Text(text, modifier, style = Type.small, color = color)
}

// MARK: Surfaces

/** A card: raised surface, 1 dp hairline, radius 20, one soft shadow in light mode only (docs/06 §2.3). */
fun Modifier.card(c: AirlockColors, padding: Dp = 18.dp, radius: Dp = 20.dp): Modifier =
    this.then(if (c.dark) Modifier else Modifier.shadow(2.dp, RoundedCornerShape(radius), ambientColor = Color(0x140E1726), spotColor = Color(0x140E1726)))
        .clip(RoundedCornerShape(radius)).background(c.raised).border(1.dp, c.stroke, RoundedCornerShape(radius)).padding(padding)

@Composable
fun Card(modifier: Modifier = Modifier, padding: Dp = 18.dp, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalAirlock.current
    Column(modifier.fillMaxWidth().card(c, padding), verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}

/** Staggered entrance (web `.enter`): fade + 10 dp rise; instant with reduced motion. */
@Composable
fun Modifier.enter(index: Int = 0, baseDelayMs: Int = 0): Modifier {
    val still = reduceMotion()
    val a = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!still) {
            delay((baseDelayMs + index * 60).toLong())
            a.animateTo(1f, tween(520, easing = EaseOutExpo))
        }
    }
    return this.graphicsLayer {
        alpha = a.value
        translationY = (1f - a.value) * 10.dp.toPx()
    }
}

// MARK: Buttons

enum class ButtonKind { PRIMARY, DEFAULT, GHOST, DANGER, DANGER_GHOST }

@Composable
fun AirButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.DEFAULT,
    icon: ImageVector? = null,
    trailingIcon: ImageVector? = null,
    enabled: Boolean = true,
    compact: Boolean = false,
    contentDescription: String? = null,
) {
    val c = LocalAirlock.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed && enabled && !reduceMotion()) 0.97f else 1f, tween(140, easing = EaseOutExpo), label = "press")
    val (bg, fg, border) = when (kind) {
        // Disabled primary: a neutral fill, so it never reads as an enabled (darker) seal button in dark mode.
        ButtonKind.PRIMARY -> if (enabled) Triple(c.seal, c.onSeal, c.seal) else Triple(c.stroke, c.text2, c.stroke)
        ButtonKind.DEFAULT -> Triple(c.raised, c.text, c.stroke)
        ButtonKind.GHOST -> Triple(Color.Transparent, c.text2, Color.Transparent)
        ButtonKind.DANGER -> Triple(c.raised, c.risk, c.stroke)
        ButtonKind.DANGER_GHOST -> Triple(Color.Transparent, c.risk, Color.Transparent)
    }
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier
            .scale(scale)
            .graphicsLayer { alpha = if (enabled || kind == ButtonKind.PRIMARY) 1f else 0.5f }
            .defaultMinSize(minHeight = if (compact) 40.dp else 48.dp)
            .clip(shape)
            .background(bg)
            .border(1.dp, border, shape)
            .clickable(interactionSource = interaction, indication = androidx.compose.material3.ripple(), enabled = enabled, role = Role.Button, onClick = onClick)
            .then(if (contentDescription != null) Modifier.semantics { this.contentDescription = contentDescription } else Modifier)
            .padding(horizontal = if (compact) 12.dp else 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(17.dp), tint = fg)
        if (text.isNotEmpty()) Text(text, style = Type.body.copy(fontWeight = FontWeight.SemiBold, lineHeight = 20.sp), color = fg)
        if (trailingIcon != null) Icon(trailingIcon, null, Modifier.size(17.dp), tint = fg)
    }
}

/** Selectable pill (task choices). */
@Composable
fun Pill(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    val bg by animateColorAsState(if (selected) c.text else c.raised, tween(280), label = "pill")
    val fg by animateColorAsState(if (selected) c.bg else c.text, tween(280), label = "pillText")
    Box(
        modifier
            .defaultMinSize(minHeight = 40.dp)
            .clip(CircleShape)
            .background(bg)
            .border(1.dp, if (selected) c.text else c.stroke, CircleShape)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .semantics { this.selected = selected }
            .padding(horizontal = 14.dp, vertical = 9.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.small.copy(fontSize = 14.sp), color = fg) }
}

/** Segmented control; each option is a radio button for accessibility. */
@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier, a11y: String, icons: List<ImageVector?>? = null) {
    val c = LocalAirlock.current
    Row(
        modifier.clip(RoundedCornerShape(12.dp)).border(1.dp, c.stroke, RoundedCornerShape(12.dp)).semantics { contentDescription = a11y },
    ) {
        options.forEachIndexed { i, (value, label) ->
            val on = value == selected
            val bg by animateColorAsState(if (on) c.text else Color.Transparent, tween(280), label = "seg")
            val fg by animateColorAsState(if (on) c.bg else c.text, tween(280), label = "segText")
            Row(
                Modifier
                    .weight(1f, fill = true)
                    .defaultMinSize(minHeight = 42.dp)
                    .background(bg)
                    .clickable(role = Role.RadioButton) { onSelect(value) }
                    .semantics { this.selected = on }
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
            ) {
                icons?.getOrNull(i)?.let { Icon(it, null, Modifier.size(15.dp), tint = fg) }
                Text(label, style = Type.small.copy(fontSize = 14.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = fg, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
    }
}

/** On/off switch with a springy knob (web `.switch`). */
@Composable
fun AirSwitch(checked: Boolean, onToggle: () -> Unit, contentDescription: String, enabled: Boolean = true) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val knob by animateDpAsState(if (checked) 21.dp else 3.dp, if (still) tween(0) else spring(dampingRatio = 0.55f, stiffness = 500f), label = "knob")
    val track by animateColorAsState(if (checked) c.seal else c.stroke, tween(if (still) 0 else 280), label = "track")
    Box(
        Modifier
            .size(width = 56.dp, height = 48.dp)
            .clickable(enabled = enabled, role = Role.Switch, onClick = onToggle)
            .semantics {
                this.contentDescription = contentDescription
                toggleableState = ToggleableState(checked)
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.graphicsLayer { alpha = if (enabled) 1f else 0.45f }.size(width = 46.dp, height = 28.dp).clip(CircleShape).background(track)) {
            Box(Modifier.offset(x = knob, y = 3.dp).size(22.dp).clip(CircleShape).background(Color.White))
        }
    }
}

/** Text field styled like the web's `.field` / `.compose`. */
@Composable
fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    a11y: String,
    modifier: Modifier = Modifier,
    minHeight: Dp = 48.dp,
    singleLine: Boolean = true,
) {
    val c = LocalAirlock.current
    BasicTextField(
        value = value,
        onValueChange = onChange,
        singleLine = singleLine,
        textStyle = Type.body.copy(color = c.text, lineHeight = 24.sp),
        cursorBrush = SolidColor(c.seal),
        modifier = modifier.semantics { contentDescription = a11y },
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .defaultMinSize(minHeight = minHeight)
                    .clip(RoundedCornerShape(if (singleLine) 12.dp else 16.dp))
                    .background(c.raised)
                    .border(1.dp, c.stroke, RoundedCornerShape(if (singleLine) 12.dp else 16.dp))
                    .padding(horizontal = 14.dp, vertical = if (singleLine) 12.dp else 14.dp),
            ) {
                if (value.isEmpty()) Text(placeholder, style = Type.body.copy(lineHeight = 24.sp), color = c.muted)
                inner()
            }
        },
    )
}

// MARK: Banners

enum class Tone { INFO, OK, WARN, RISK }

@Composable
fun Banner(tone: Tone, title: String, modifier: Modifier = Modifier, body: String? = null, action: (@Composable () -> Unit)? = null) {
    val c = LocalAirlock.current
    val (bg, fg, icon) = when (tone) {
        Tone.INFO -> Triple(c.cloudTint, c.cloud, AirlockIcons.Sparkle)
        Tone.OK -> Triple(c.sealTint, c.seal, AirlockIcons.Shield)
        Tone.WARN -> Triple(c.reviewTint, c.review, AirlockIcons.Alert)
        Tone.RISK -> Triple(c.riskTint, c.risk, AirlockIcons.Alert)
    }
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(bg)
            .semantics { liveRegion = if (tone == Tone.RISK) LiveRegionMode.Assertive else LiveRegionMode.Polite }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, null, Modifier.padding(top = 2.dp).size(20.dp), tint = fg)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = Type.body.copy(fontWeight = FontWeight.SemiBold, lineHeight = 22.sp), color = c.text)
                if (body != null) Text(body, style = Type.small, color = c.text)
            }
        }
        if (action != null) Box(Modifier.padding(start = 32.dp)) { action() }
    }
}

// MARK: Small pieces

@Composable
fun StepDots(step: Int, of: Int, a11y: String) {
    val c = LocalAirlock.current
    Row(Modifier.clearAndSetSemantics { contentDescription = a11y }, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(of) { i ->
            val w by animateDpAsState(if (i == step) 24.dp else 8.dp, tween(280, easing = EaseOutExpo), label = "dot")
            Box(Modifier.size(width = w, height = 8.dp).clip(CircleShape).background(if (i == step) c.seal else c.stroke))
        }
    }
}

/** Three bouncing dots while the first chunk is on its way. */
@Composable
fun TypingDots(a11y: String) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val t = rememberInfiniteTransition(label = "typing")
    Row(Modifier.padding(vertical = 8.dp).semantics { contentDescription = a11y }, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(3) { i ->
            val y = if (still) 0f else t.animateFloat(
                0f, 0f,
                infiniteRepeatable(keyframes { durationMillis = 1100; 0f at 0; -5f at 440 using FastOutSlowInEasing; 0f at 880 }, initialStartOffset = androidx.compose.animation.core.StartOffset(i * 150)),
                label = "dot$i",
            ).value
            Box(Modifier.offset(y = y.dp).size(7.dp).clip(CircleShape).background(c.text2.copy(alpha = if (still) 0.6f else 0.4f + (-y / 5f) * 0.6f)))
        }
    }
}

/** A pulsing dot (red-team pending, live badge). */
@Composable
fun PulseDot(color: Color, size: Dp = 10.dp) {
    val still = reduceMotion()
    val t = rememberInfiniteTransition(label = "pulse")
    val k = if (still) 1f else t.animateFloat(0.3f, 1f, infiniteRepeatable(tween(500), RepeatMode.Reverse), label = "k").value
    Box(Modifier.size(size).scale(0.8f + 0.2f * k).graphicsLayer { alpha = k }.clip(CircleShape).background(color))
}

/** Elapsed seconds since a `System.nanoTime()` mark, ticking every 100 ms. */
@Composable
fun elapsedSeconds(sinceNanos: Long): Double {
    var now by remember { mutableLongStateOf(System.nanoTime()) }
    LaunchedEffect(sinceNanos) {
        while (true) {
            now = System.nanoTime()
            delay(100)
        }
    }
    return maxOf(0.0, (now - sinceNanos) / 1e9)
}

/** Animated count from the previous value to [value] (cubic ease-out); instant with reduced motion. */
@Composable
fun countUp(value: Int, ms: Int = 900): Int {
    val still = reduceMotion()
    val a = remember { Animatable(0f) }
    LaunchedEffect(value) {
        if (still) a.snapTo(value.toFloat()) else a.animateTo(value.toFloat(), tween(ms, easing = androidx.compose.animation.core.CubicBezierEasing(0.33f, 1f, 0.68f, 1f)))
    }
    return Math.round(a.value)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Wrap(modifier: Modifier = Modifier, spacing: Dp = 8.dp, content: @Composable () -> Unit) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(spacing), verticalArrangement = Arrangement.spacedBy(spacing)) { content() }
}

@Composable
fun RowScope.Fill() = Spacer(Modifier.weight(1f))

@Composable
fun Gap(h: Dp) = Spacer(Modifier.height(h))

@Composable
fun HGap(w: Dp) = Spacer(Modifier.width(w))

/** Small rounded square with a category icon (Review details list, Vault). */
@Composable
fun CategoryBadge(color: Color, icon: ImageVector, size: Dp = 32.dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(9.dp)).background(color.copy(alpha = 0.16f)), contentAlignment = Alignment.Center) {
        Icon(icon, null, Modifier.size(size * 0.55f), tint = color)
    }
}

/** A thin hairline divider. */
@Composable
fun Hairline(modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    Box(modifier.fillMaxWidth().height(1.dp).background(c.stroke))
}

/** Draws a hairline under a row. */
fun Modifier.bottomHairline(color: Color): Modifier = drawBehind {
    drawLine(color, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx())
}

/** State description helper. */
fun Modifier.state(desc: String): Modifier = semantics { stateDescription = desc }
