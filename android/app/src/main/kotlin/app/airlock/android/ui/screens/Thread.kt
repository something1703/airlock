package app.airlock.android.ui.screens

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.State
import app.airlock.android.session.Thread
import app.airlock.android.session.Turn
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Field
import app.airlock.android.ui.FlowText
import app.airlock.android.ui.H1
import app.airlock.android.ui.Labels
import app.airlock.android.ui.PulseDot
import app.airlock.android.ui.Small
import app.airlock.android.ui.Tone
import app.airlock.android.ui.Type
import app.airlock.android.ui.TypingDots
import app.airlock.android.ui.Wrap
import app.airlock.android.ui.enter
import app.airlock.android.ui.reduceMotion
import app.airlock.android.ui.rememberLabels
import app.airlock.android.ui.restoredSegs
import app.airlock.android.ui.sealedTextSegs
import app.airlock.core.AnswerOutcome
import app.airlock.core.EngineErrorCode
import app.airlock.core.ON_DEVICE_MODEL
import app.airlock.core.TaskKind
import java.util.Locale

/** "gemini-3.8-flash" → "3.8 Flash". */
fun prettyModel(m: String): String =
    if (m == ON_DEVICE_MODEL) "Gemini Nano" else m.removePrefix("gemini-").replace('-', ' ').split(' ').joinToString(" ") { w -> w.replaceFirstChar { it.uppercase() } }

@Composable
fun errorText(code: EngineErrorCode?): String = stringResource(
    when (code) {
        EngineErrorCode.OFFLINE -> R.string.err_offline
        EngineErrorCode.QUOTA, EngineErrorCode.SERVICE_UNAVAILABLE -> R.string.err_busy
        EngineErrorCode.ARMOR_BLOCKED -> R.string.err_armor
        EngineErrorCode.CLOUD_BLOCKED -> R.string.err_cloud_blocked
        EngineErrorCode.APP_CHECK -> R.string.err_appcheck
        EngineErrorCode.UNAVAILABLE -> R.string.err_unavailable
        else -> R.string.err_other
    },
)

@Composable
fun ThreadScreen(session: AirlockSession, s: State, scroll: ScrollState) {
    val c = LocalAirlock.current
    val labels = rememberLabels()
    val thread = s.threads.firstOrNull { it.id == s.currentThreadId }
    if (thread == null) {
        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            H1(stringResource(R.string.thread_not_found))
            AirButton(stringResource(R.string.thread_back_to_ask), { session.go(app.airlock.android.session.Screen.ASK) })
        }
        return
    }
    var confirmDelete by rememberSaveable(thread.id) { mutableStateOf(false) }
    var followUp by rememberSaveable(thread.id) { mutableStateOf("") }
    val last = thread.turns.lastOrNull() as? Turn.Assistant
    // Keep the newest words in view while the answer streams in.
    LaunchedEffect(thread.turns.size, last?.text?.length, last?.status) {
        if (last != null) scroll.animateScrollTo(scroll.maxValue)
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            H1(thread.title, Modifier.weight(1f).padding(top = 4.dp))
            AirButton("", { confirmDelete = true }, kind = ButtonKind.DANGER_GHOST, icon = AirlockIcons.Trash, compact = true, contentDescription = stringResource(R.string.thread_delete_a11y))
        }
        AirButton(stringResource(R.string.thread_new), { session.go(app.airlock.android.session.Screen.ASK) }, kind = ButtonKind.DEFAULT, icon = AirlockIcons.Plus, compact = true)
        AnimatedVisibility(confirmDelete, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Banner(
                Tone.RISK, stringResource(R.string.thread_delete_title), body = stringResource(R.string.thread_delete_body),
                action = {
                    Wrap {
                        AirButton(stringResource(R.string.delete), { session.deleteThread(thread.id) }, kind = ButtonKind.DANGER, compact = true)
                        AirButton(stringResource(R.string.cancel), { confirmDelete = false }, kind = ButtonKind.GHOST, compact = true)
                    }
                },
            )
        }
        thread.turns.forEach { t ->
            when (t) {
                is Turn.User -> UserBubble(t, thread, labels)
                is Turn.Assistant -> AssistantBubble(t, labels)
            }
        }
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.raised).border(1.dp, c.stroke, RoundedCornerShape(20.dp)).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Field(followUp, { followUp = it }, stringResource(R.string.followup_hint), stringResource(R.string.followup_a11y), Modifier.fillMaxWidth(), minHeight = 84.dp, singleLine = false)
            AirButton(
                stringResource(R.string.followup_send),
                {
                    val text = followUp
                    followUp = ""
                    session.run { startReview(text, TaskKind.Help, thread.id) }
                },
                kind = ButtonKind.PRIMARY, icon = AirlockIcons.Shield, enabled = followUp.isNotBlank() && !thread.busy,
            )
            Small(stringResource(R.string.thread_note))
        }
    }
}

@Composable
private fun UserBubble(turn: Turn.User, thread: Thread, labels: Labels) {
    val c = LocalAirlock.current
    var showRaw by rememberSaveable { mutableStateOf(false) }
    Column(
        Modifier.enter(0).padding(start = 36.dp).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(c.raised).border(1.dp, c.stroke, RoundedCornerShape(18.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(if (showRaw) AirlockIcons.Eye else AirlockIcons.Shield, null, Modifier.size(14.dp), tint = if (showRaw) c.review else c.seal)
            Small(stringResource(if (showRaw) R.string.bubble_raw_label else R.string.bubble_sealed_label), Modifier.weight(1f))
            AirButton(stringResource(if (showRaw) R.string.bubble_show_sealed else R.string.bubble_show_raw), { showRaw = !showRaw }, kind = ButtonKind.GHOST, compact = true)
        }
        AnimatedContent(showRaw, transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(120)) }, label = "bubble") { raw ->
            if (raw) Text(turn.raw, style = Type.body, color = c.text)
            else FlowText(sealedTextSegs(turn.display, thread.entities, labels))
        }
    }
}

@Composable
private fun AssistantBubble(turn: Turn.Assistant, labels: Labels) {
    val c = LocalAirlock.current
    val o = turn.outcome
    val streaming = turn.status == Turn.Status.STREAMING
    Column(
        Modifier.enter(0).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(c.raised).border(1.dp, c.stroke, RoundedCornerShape(18.dp))
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RouteBadge(o, streaming, turn.status == Turn.Status.ERROR)
        when {
            turn.status == Turn.Status.ERROR -> Banner(Tone.RISK, errorText(turn.error))
            turn.segments.isNotEmpty() -> Column {
                FlowText(restoredSegs(turn.segments, labels))
                if (streaming) Caret()
            }
            else -> TypingDots(stringResource(R.string.typing_a11y))
        }
        if (o != null) ReceiptLine(o, turn.text)
    }
}

@Composable
private fun Caret() {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val a = if (still) 1f else rememberInfiniteTransition(label = "caret").animateFloat(1f, 0f, infiniteRepeatable(tween(1000, easing = Easing { if (it < 0.5f) 0f else 1f }), RepeatMode.Restart), label = "blink").value
    Box(Modifier.padding(top = 2.dp).width(2.dp).height(18.dp).graphicsLayer { alpha = a }.background(c.seal))
}

/** Capsule: where the answer was made, with the model and time (built from the outcome, never assumed). */
@Composable
fun RouteBadge(o: AnswerOutcome?, streaming: Boolean, error: Boolean) {
    val c = LocalAirlock.current
    val secs = o?.let { String.format(Locale.getDefault(), "%.1f", it.latencyMs / 1000) } ?: ""
    data class Look(val bg: androidx.compose.ui.graphics.Color, val fg: androidx.compose.ui.graphics.Color, val icon: androidx.compose.ui.graphics.vector.ImageVector?, val text: String)
    val look = when {
        o == null && streaming -> Look(c.cloudTint, c.cloud, null, stringResource(R.string.badge_answering))
        o == null -> Look(if (error) c.riskTint else c.cloudTint, if (error) c.risk else c.cloud, AirlockIcons.Alert, stringResource(R.string.badge_error))
        o.fellBackToPhone -> Look(c.reviewTint, c.review, AirlockIcons.Phone, stringResource(R.string.badge_fallback, secs))
        o.ranOnDevice || o.modelVersion == ON_DEVICE_MODEL -> Look(c.sealTint, c.seal, AirlockIcons.Phone, stringResource(R.string.badge_phone, secs))
        else -> Look(c.cloudTint, c.cloud, AirlockIcons.Cloud, stringResource(R.string.badge_cloud, prettyModel(o.modelVersion), secs))
    }
    val bg by animateColorAsState(look.bg, tween(280), label = "badgeBg")
    val fg by animateColorAsState(look.fg, tween(280), label = "badgeFg")
    Row(
        Modifier.clip(CircleShape).background(bg).padding(horizontal = 12.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (look.icon != null) Icon(look.icon, null, Modifier.size(14.dp), tint = fg) else PulseDot(fg, 7.dp)
        Text(look.text, style = Type.small.copy(fontWeight = FontWeight.SemiBold), color = fg)
    }
}

@Composable
private fun ReceiptLine(o: AnswerOutcome, restoredText: String) {
    val c = LocalAirlock.current
    val ctx = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            kotlinx.coroutines.delay(1600)
            copied = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.stroke))
        Wrap(spacing = 10.dp) {
            val r = o.receipt
            if (r != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(AirlockIcons.Ledger, null, Modifier.size(14.dp), tint = c.text2)
                    Small(stringResource(R.string.receipt_line, r.id))
                }
                Text(r.outboundSha256.take(12) + "…", style = Type.mono, color = c.text2)
                Small(stringResource(R.string.receipt_chars, r.outboundChars))
            } else {
                Small(stringResource(R.string.receipt_none))
            }
            if (o.fidelity.guessedEntities.isNotEmpty()) Small(stringResource(R.string.fidelity_guessed), color = c.review)
            if (o.fidelity.unknownIds.isNotEmpty()) Small(stringResource(R.string.fidelity_unknown), color = c.review)
        }
        AirButton(
            stringResource(if (copied) R.string.copied else R.string.copy),
            {
                copyRestored(ctx, restoredText)
                copied = true
            },
            kind = ButtonKind.GHOST, icon = if (copied) AirlockIcons.Check else null, compact = true, contentDescription = stringResource(R.string.copy_a11y),
        )
    }
}

/** Copies the restored answer, flagged sensitive so Android doesn't preview it in the clipboard overlay (API 33+). */
private fun copyRestored(ctx: Context, text: String) {
    val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    val clip = ClipData.newPlainText("Airlock", text)
    if (Build.VERSION.SDK_INT >= 33) clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
    cm.setPrimaryClip(clip)
}
