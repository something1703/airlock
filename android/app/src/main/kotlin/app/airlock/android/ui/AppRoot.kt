package app.airlock.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.Screen
import app.airlock.android.ui.screens.AskScreen
import app.airlock.android.ui.screens.EvidenceScreen
import app.airlock.android.ui.screens.LedgerScreen
import app.airlock.android.ui.screens.Onboarding
import app.airlock.android.ui.screens.ReviewScreen
import app.airlock.android.ui.screens.SettingsScreen
import app.airlock.android.ui.screens.ThreadScreen
import app.airlock.android.ui.screens.VaultScreen
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

private val NAV = listOf(
    Triple(Screen.ASK, R.string.nav_ask, AirlockIcons.Ask),
    Triple(Screen.LEDGER, R.string.nav_ledger, AirlockIcons.Ledger),
    Triple(Screen.VAULT, R.string.nav_vault, AirlockIcons.Vault),
    Triple(Screen.SETTINGS, R.string.nav_settings, AirlockIcons.Settings),
)

/** The whole app: onboarding, or the four tabs with Review/Thread inside Ask, plus the seal door overlay. */
@Composable
fun AppRoot(session: AirlockSession) {
    val c = LocalAirlock.current
    val s by session.state.collectAsState()
    val still = reduceMotion()
    val haptics = LocalHapticFeedback.current
    var door by remember { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(c.bg)) {
        if (!s.loaded) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { AirlockLogo(64.dp, animated = true) }
            return@Box
        }
        if (s.screen == Screen.ONBOARDING) {
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing)) { Onboarding(session, s) }
            return@Box
        }
        BackHandler(enabled = s.screen != Screen.ASK) {
            when (s.screen) {
                Screen.REVIEW -> session.cancelReview()
                Screen.EVIDENCE -> session.go(Screen.SETTINGS)
                else -> session.go(Screen.ASK)
            }
        }
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val key = if (s.screen == Screen.THREAD) "thread:${s.currentThreadId}" else s.screen.name
                AnimatedContent(
                    targetState = key,
                    transitionSpec = {
                        if (still) fadeIn(tween(0)) togetherWith fadeOut(tween(0))
                        else (fadeIn(tween(320, easing = EaseOutExpo)) + slideInVertically(tween(320, easing = EaseOutExpo)) { it / 60 }) togetherWith
                            (fadeOut(tween(180, easing = FastOutLinearInEasing)) + slideOutVertically(tween(180)) { -it / 100 })
                    },
                    label = "screen",
                ) { k ->
                    val scroll = rememberScrollState()
                    ScreenScroll(scroll) {
                        val screen = if (k.startsWith("thread:")) Screen.THREAD else Screen.valueOf(k)
                        when (screen) {
                            Screen.ASK -> AskScreen(session, s)
                            Screen.REVIEW -> ReviewScreen(session, s) {
                                if (!door) {
                                    door = true
                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                }
                            }
                            Screen.THREAD -> ThreadScreen(session, s, scroll)
                            Screen.LEDGER -> LedgerScreen(session, s)
                            Screen.VAULT -> VaultScreen(session, s)
                            Screen.SETTINGS -> SettingsScreen(session, s)
                            Screen.EVIDENCE -> EvidenceScreen(session)
                            Screen.ONBOARDING -> {}
                        }
                    }
                }
                if (door) SealDoor()
                LaunchedEffect(door) {
                    if (!door) return@LaunchedEffect
                    session.clearBlocked()
                    delay(if (still) 150 else 950)
                    // The door has closed: send now. Fade it once the thread is showing (or the gate stopped it).
                    session.run { send() }
                    session.state.first { it.screen != Screen.REVIEW || it.review?.blocked != null || it.review?.result == null }
                    delay(if (still) 0 else 450)
                    door = false
                }
            }
            val tab = when (s.screen) {
                Screen.REVIEW, Screen.THREAD -> Screen.ASK
                Screen.EVIDENCE -> Screen.SETTINGS
                else -> s.screen
            }
            BottomBar(tab) { session.go(it) }
        }
    }
}

@Composable
private fun ScreenScroll(scroll: ScrollState, content: @Composable () -> Unit) {
    // Status-bar inset outside the scroll, so content never slides under the clock.
    Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars).imePadding(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .widthIn(max = 720.dp)
                .fillMaxSize()
                .verticalScroll(scroll)
                .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 28.dp),
        ) { content() }
    }
}

@Composable
private fun BottomBar(active: Screen, onSelect: (Screen) -> Unit) {
    val c = LocalAirlock.current
    val navA11y = stringResource(R.string.nav_main)
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.raised)
            .drawBehind { drawLine(c.stroke, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
            .windowInsetsPadding(WindowInsets.navigationBars)
            .semantics { contentDescription = navA11y },
    ) {
        BoxWithConstraints(Modifier.fillMaxWidth().heightIn(min = 64.dp)) {
            val itemW = maxWidth / NAV.size
            val index = NAV.indexOfFirst { it.first == active }.coerceAtLeast(0)
            val x by animateDpAsState(itemW * index, tween(if (reduceMotion()) 0 else 320, easing = EaseOutExpo), label = "indicator")
            // A pill that slides between items (web: the nav indicator).
            Box(Modifier.offset(x = x + (itemW - 64.dp) / 2, y = 6.dp).size(width = 64.dp, height = 30.dp).clip(CircleShape).background(c.sealTint))
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                NAV.forEach { (screen, label, icon) ->
                    val on = screen == active
                    val tint by animateColorAsState(if (on) c.seal else c.text2, tween(280), label = "navTint")
                    val text = stringResource(label)
                    Column(
                        Modifier
                            .weight(1f)
                            .fillMaxHeight()
                            .heightIn(min = 64.dp)
                            .clickable(role = Role.Tab) { onSelect(screen) }
                            .padding(top = 6.dp, bottom = 8.dp)
                            .semantics { selected = on },
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        // The icon sits in a fixed 30 dp slot so the sliding pill stays behind it at any font size.
                        Box(Modifier.height(30.dp), contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(22.dp), tint = tint) }
                        Text(text, style = Type.small.copy(fontSize = 12.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal), color = if (on) c.text else c.text2)
                    }
                }
            }
        }
    }
}

/**
 * Seal & send: the airlock cycles. Two panels slide shut (380 ms), a ring pulses out and the mark appears with
 * "Sealed · leaving your phone". The caller sends once it has closed. Reduced motion: shown without movement (docs/06 §2.4).
 */
@Composable
private fun SealDoor() {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val shut = remember { Animatable(if (still) 1f else 0f) }
    val ring = remember { Animatable(0f) }
    val glyph = remember { Animatable(if (still) 1f else 0f) }
    val label = stringResource(R.string.door_label)
    LaunchedEffect(Unit) {
        if (!still) {
            launch { shut.animateTo(1f, tween(380, easing = FastOutLinearInEasing)) }
            launch { delay(360); ring.animateTo(1f, tween(700, easing = EaseOutExpo)) }
            launch { delay(300); glyph.animateTo(1f, tween(760, easing = EaseOutExpo)) }
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize().clearAndSetSemantics { contentDescription = label }) {
        val half = maxWidth / 2
        val panel = lerp(c.bg, c.seal, 0.04f)
        Box(Modifier.offset(x = -half * (1f - shut.value)).width(half).fillMaxHeight().background(panel).drawBehind {
            drawLine(c.seal, Offset(size.width, 0f), Offset(size.width, size.height), 2.dp.toPx())
        })
        Box(Modifier.offset(x = half + half * (1f - shut.value)).width(half).fillMaxHeight().background(panel).drawBehind {
            drawLine(c.seal, Offset(0f, 0f), Offset(0f, size.height), 2.dp.toPx())
        })
        Box(
            Modifier.align(Alignment.Center).size(120.dp).graphicsLayer {
                val k = 0.6f + 1.8f * ring.value
                scaleX = k; scaleY = k
                alpha = if (ring.value == 0f) 0f else 0.9f * (1f - ring.value)
            }.clip(CircleShape).drawBehind { drawCircle(c.seal, style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx() / (0.6f + 1.8f * ring.value))) },
        )
        Column(
            Modifier.align(Alignment.Center).graphicsLayer {
                val g = glyph.value
                alpha = (g * 2.5f).coerceAtMost(1f)
                val k = if (g < 0.4f) 0.85f + (1.04f - 0.85f) * (g / 0.4f) else 1.04f - 0.04f * ((g - 0.4f) / 0.6f)
                scaleX = k; scaleY = k
            },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AirlockLogo(84.dp, animated = true)
            Text(label, style = Type.bodyBold.copy(letterSpacing = 0.3.sp), color = c.seal)
        }
    }
}
