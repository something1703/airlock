package app.airlock.android.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.State
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.AirlockLogo
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Card
import app.airlock.android.ui.EaseOutExpo
import app.airlock.android.ui.Field
import app.airlock.android.ui.H1
import app.airlock.android.ui.Small
import app.airlock.android.ui.StandaloneChip
import app.airlock.android.ui.StepDots
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Type
import app.airlock.android.ui.Wrap
import app.airlock.android.ui.card
import app.airlock.android.ui.enter
import app.airlock.android.ui.reduceMotion
import app.airlock.core.DialPreset
import app.airlock.core.Js
import app.airlock.core.PrivacyCategory
import app.airlock.core.VaultEntry
import java.util.UUID

/** "Raj Patel" → ["Raj"]: people are usually written by first name. */
fun firstNameAlias(name: String): List<String> {
    val parts = name.trim().split(Regex("\\s+"))
    return if (parts.size > 1 && Js.codePointLength(parts[0]) > 1) listOf(parts[0]) else emptyList()
}

@Composable
fun Onboarding(session: AirlockSession, s: State) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    BackHandler(enabled = step > 0) { step-- }
    val still = reduceMotion()
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        AnimatedContent(
            targetState = step,
            transitionSpec = {
                if (still) fadeIn(tween(0)) togetherWith fadeOut(tween(0))
                else (fadeIn(tween(320, easing = EaseOutExpo)) + slideInVertically(tween(320, easing = EaseOutExpo)) { it / 40 }) togetherWith fadeOut(tween(180))
            },
            label = "onboarding",
            modifier = Modifier.widthIn(max = 640.dp),
        ) { st ->
            Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                when (st) {
                    0 -> Welcome { step = 1 }
                    1 -> VaultStep(session, onDone = { step = 2 })
                    else -> DialStep(session, s)
                }
            }
        }
    }
}

@Composable
private fun Welcome(next: () -> Unit) {
    val c = LocalAirlock.current
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        AirlockLogo(40.dp, animated = true)
        StepDots(0, 3, stringResource(R.string.onb_step, 1, 3))
    }
    H1(stringResource(R.string.onb1_title), Modifier.enter(0))
    Sub(stringResource(R.string.onb1_sub), Modifier.enter(1))
    HeroAnimation(Modifier.enter(2))
    Card(Modifier.enter(3)) {
        for ((b, t) in listOf(R.string.onb1_p1_b to R.string.onb1_p1, R.string.onb1_p2_b to R.string.onb1_p2, R.string.onb1_p3_b to R.string.onb1_p3)) {
            val bold = stringResource(b)
            val rest = stringResource(t)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(bold) }
                    append(" ")
                    append(rest)
                },
                style = Type.body.copy(lineHeight = 23.sp), color = c.text,
            )
        }
    }
    Small(stringResource(R.string.onb1_honest), Modifier.enter(4))
    AirButton(stringResource(R.string.onb_get_started), next, kind = ButtonKind.PRIMARY, trailingIcon = AirlockIcons.Arrow, modifier = Modifier.enter(5))
}

/** Fictional details flow left → right through the airlock and come out as chips. */
@Composable
private fun HeroAnimation(modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val lanes = listOf(
        Triple(stringResource(R.string.hero_person_before), stringResource(R.string.hero_person_after), PrivacyCategory.PERSON),
        Triple(stringResource(R.string.hero_place_before), stringResource(R.string.hero_place_after), PrivacyCategory.LOCATION),
        Triple(stringResource(R.string.hero_contact_before), stringResource(R.string.hero_contact_after), PrivacyCategory.CONTACT),
    )
    val a11y = stringResource(R.string.hero_a11y)
    BoxWithConstraints(modifier.fillMaxWidth().height(156.dp).card(c, padding = 0.dp).clearAndSetSemantics { contentDescription = a11y }) {
        val w = maxWidth
        if (still) {
            Column(Modifier.align(Alignment.TopEnd).padding(top = 18.dp, end = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalAlignment = Alignment.End) {
                lanes.forEach { (_, after, cat) -> StandaloneChip(cat, after) }
            }
        } else {
            val t = rememberInfiniteTransition(label = "hero")
            val phase by t.animateFloat(0f, 1f, infiniteRepeatable(tween(6000, easing = LinearEasing), RepeatMode.Restart), label = "phase")
            lanes.forEachIndexed { i, (before, after, cat) ->
                val p = (phase + i / 3f) % 1f
                val x = (-140).dp + (w + 160.dp) * p
                val beforeA = when {
                    p < 0.46f -> 1f
                    p < 0.50f -> (0.50f - p) / 0.04f
                    else -> 0f
                }
                val afterA = when {
                    p < 0.46f -> 0f
                    p < 0.52f -> (p - 0.46f) / 0.06f
                    else -> 1f
                }
                Box(Modifier.offset(x = x, y = 22.dp + 36.dp * i)) {
                    if (beforeA > 0f) Text(
                        before,
                        Modifier.graphicsLayer { alpha = beforeA }.blur(((1f - beforeA) * 4f).dp).clip(RoundedCornerShape(8.dp)).background(c.reviewTint).padding(horizontal = 10.dp, vertical = 3.dp),
                        style = Type.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = c.text, maxLines = 1, softWrap = false,
                    )
                    if (afterA > 0f) StandaloneChip(cat, after, Modifier.graphicsLayer { alpha = afterA; val k = 0.7f + 0.3f * afterA; scaleX = k; scaleY = k })
                }
            }
        }
        // The gate, drawn over the lanes so details pass *through* it: two seal-green rails and the mark.
        Box(Modifier.align(Alignment.TopCenter).padding(top = 14.dp).width(64.dp).height(118.dp)) {
            val rail = Brush.verticalGradient(listOf(c.seal, Color.Transparent))
            Box(Modifier.align(Alignment.CenterStart).padding(start = 6.dp).width(2.dp).fillMaxHeight().background(rail))
            Box(Modifier.align(Alignment.CenterEnd).padding(end = 6.dp).width(2.dp).fillMaxHeight().background(rail))
            Box(Modifier.align(Alignment.Center).size(48.dp).clip(androidx.compose.foundation.shape.CircleShape).background(c.raised), contentAlignment = Alignment.Center) {
                AirlockLogo(40.dp, animated = true)
            }
        }
        Row(Modifier.align(Alignment.BottomStart).padding(start = 14.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(AirlockIcons.Phone, null, Modifier.size(14.dp), tint = c.text2)
            Text(stringResource(R.string.hero_device), style = Type.small.copy(fontSize = 12.sp), color = c.text2)
        }
        Row(Modifier.align(Alignment.BottomEnd).padding(end = 14.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.hero_cloud), style = Type.small.copy(fontSize = 12.sp), color = c.text2)
            Icon(AirlockIcons.Cloud, null, Modifier.size(14.dp), tint = c.text2)
        }
    }
}

@Composable
private fun VaultStep(session: AirlockSession, onDone: () -> Unit) {
    var me by rememberSaveable { mutableStateOf("") }
    val others = remember { mutableStateListOf(Pair("", "")) }
    StepDots(1, 3, stringResource(R.string.onb_step, 2, 3))
    H1(stringResource(R.string.onb2_title))
    Sub(stringResource(R.string.onb2_sub))
    Card {
        Small(stringResource(R.string.onb2_your_name))
        Field(me, { me = it }, stringResource(R.string.onb2_your_name_hint), stringResource(R.string.onb2_your_name), Modifier.fillMaxWidth())
        others.forEachIndexed { i, (name, role) ->
            Field(name, { others[i] = it to others[i].second }, stringResource(R.string.onb2_other_hint), stringResource(R.string.onb2_other_a11y), Modifier.fillMaxWidth())
            Field(role, { others[i] = others[i].first to it }, stringResource(R.string.onb2_role_hint), stringResource(R.string.onb2_role_a11y), Modifier.fillMaxWidth().padding(start = 24.dp))
        }
        AirButton(stringResource(R.string.onb2_add), { others.add("" to "") }, kind = ButtonKind.GHOST, icon = AirlockIcons.Plus, compact = true)
        Small(stringResource(R.string.onb2_alias_note))
    }
    Wrap {
        AirButton(stringResource(R.string.continue_), {
            val entries = ArrayList<VaultEntry>()
            if (me.isNotBlank()) entries.add(VaultEntry(UUID.randomUUID().toString(), me.trim(), firstNameAlias(me), PrivacyCategory.PERSON, "me", true))
            for ((name, role) in others) {
                if (name.isNotBlank()) {
                    entries.add(VaultEntry(UUID.randomUUID().toString(), name.trim(), firstNameAlias(name), PrivacyCategory.PERSON, role.trim().takeIf { it.isNotEmpty() }?.let { "my $it" }, false))
                }
            }
            if (entries.isNotEmpty()) session.saveVault(session.current.vault + entries)
            onDone()
        }, kind = ButtonKind.PRIMARY)
        AirButton(stringResource(R.string.skip), onDone, kind = ButtonKind.GHOST)
    }
}

@Composable
private fun DialStep(session: AirlockSession, s: State) {
    StepDots(2, 3, stringResource(R.string.onb_step, 3, 3))
    H1(stringResource(R.string.onb3_title))
    Sub(stringResource(R.string.onb3_sub))
    DialCards(s.prefs.dial) { d -> session.setPrefs { it.copy(dial = d) } }
    OnDeviceStatus(session, s)
    AirButton(stringResource(R.string.start), { session.finishOnboarding() }, kind = ButtonKind.PRIMARY, trailingIcon = AirlockIcons.Arrow)
}

/** Strict / Balanced / Open as cards with a three-bar strength meter. */
@Composable
fun DialCards(selected: DialPreset, onSelect: (DialPreset) -> Unit) {
    val c = LocalAirlock.current
    val haptics = LocalHapticFeedback.current
    val dials = listOf(
        Triple(DialPreset.STRICT, R.string.dial_strict to R.string.dial_strict_line, 3),
        Triple(DialPreset.BALANCED, R.string.dial_balanced to R.string.dial_balanced_line, 2),
        Triple(DialPreset.OPEN, R.string.dial_open to R.string.dial_open_line, 1),
    )
    val groupA11y = stringResource(R.string.dial_a11y)
    Column(Modifier.semantics { contentDescription = groupA11y }, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        dials.forEachIndexed { i, (d, text, level) ->
            val on = d == selected
            val border by animateColorAsState(if (on) c.seal else c.stroke, tween(280), label = "dialBorder")
            val title = stringResource(text.first)
            val strength = stringResource(R.string.dial_strength, level)
            Row(
                Modifier
                    .enter(i)
                    .fillMaxWidth()
                    .then(if (on) Modifier.border(3.dp, c.sealTint, RoundedCornerShape(22.dp)).padding(2.dp) else Modifier.padding(2.dp))
                    .clip(RoundedCornerShape(20.dp))
                    .background(c.raised)
                    .border(1.dp, border, RoundedCornerShape(20.dp))
                    .clickable(role = Role.RadioButton) {
                        haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        onSelect(d)
                    }
                    .semantics(mergeDescendants = true) {
                        this.selected = on
                        contentDescription = "$title. $strength"
                    }
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.Bottom) {
                    for (n in 1..3) {
                        val lit by animateColorAsState(if (on && n <= level) c.seal else if (n <= level) c.text2.copy(alpha = 0.45f) else c.stroke, tween(280), label = "bar")
                        Box(Modifier.size(width = 6.dp, height = (10 + n * 4).dp).clip(RoundedCornerShape(3.dp)).background(lit))
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(title, style = Type.bodyBold, color = c.text)
                    Small(stringResource(text.second))
                }
            }
        }
    }
}
