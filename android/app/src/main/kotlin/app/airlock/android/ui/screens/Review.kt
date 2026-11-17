package app.airlock.android.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.AppMode
import app.airlock.android.session.Review
import app.airlock.android.session.State
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirSwitch
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Card
import app.airlock.android.ui.CategoryBadge
import app.airlock.android.ui.EaseOutExpo
import app.airlock.android.ui.FlowText
import app.airlock.android.ui.H1
import app.airlock.android.ui.H2
import app.airlock.android.ui.Labels
import app.airlock.android.ui.PulseDot
import app.airlock.android.ui.Segmented
import app.airlock.android.ui.Small
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Tone
import app.airlock.android.ui.Type
import app.airlock.android.ui.Wrap
import app.airlock.android.ui.card
import app.airlock.android.ui.elapsedSeconds
import app.airlock.android.ui.enter
import app.airlock.android.ui.reduceMotion
import app.airlock.android.ui.rememberLabels
import app.airlock.android.ui.sealedPreviewSegs
import app.airlock.android.ui.withChipsSegs
import app.airlock.core.Action
import app.airlock.core.Confidence
import app.airlock.core.Entity
import app.airlock.core.GateCheckId
import app.airlock.core.PhoneAvailability
import app.airlock.core.PrivacyCategory
import app.airlock.core.ReplacementKind
import app.airlock.core.ReviewReason
import app.airlock.core.SealProgress
import java.util.Locale

@Composable
fun ReviewScreen(session: AirlockSession, s: State, onSeal: () -> Unit) {
    val review = s.review ?: return
    when {
        review.failed -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
            H1(stringResource(R.string.review_title))
            Banner(Tone.RISK, stringResource(R.string.review_failed))
            AirButton(stringResource(R.string.back), { session.cancelReview() })
        }
        review.result == null -> Sealing(review, rulesOnly = session.services.mode == AppMode.LIVE && s.availability != PhoneAvailability.AVAILABLE)
        else -> Checked(session, s, review, onSeal)
    }
}

// MARK: Sealing — the wait, made legible: the user's own text (local), a scanning beam, and the steps ticking off.

private enum class Step(val label: Int) { DETECT(R.string.step_detect), GENERALISE(R.string.step_generalise), RISKS(R.string.step_risks) }

@Composable
private fun Sealing(review: Review, rulesOnly: Boolean) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val elapsed = elapsedSeconds(review.startedAtNanos)
    val at = when (val p = review.progress) {
        null, is SealProgress.Detecting -> 0
        SealProgress.Generalising -> 1
        SealProgress.CheckingRisks -> 2
        SealProgress.Done -> 3
    }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
            H1(stringResource(R.string.sealing_title))
            Sub(stringResource(R.string.sealing_sub))
        }
        val sweep = if (still) -1f else rememberInfiniteTransition(label = "scan").animateFloat(
            0f, 1f, infiniteRepeatable(tween(1800, easing = EaseOutExpo), RepeatMode.Restart), label = "sweep",
        ).value
        Column(
            Modifier
                .enter(0)
                .fillMaxWidth()
                .card(c)
                .drawWithContent {
                    drawContent()
                    if (sweep >= 0f) {
                        val w = size.width * 0.3f
                        val x = -w + (size.width + w) * sweep
                        drawRect(
                            Brush.horizontalGradient(listOf(Color.Transparent, c.seal.copy(alpha = 0.22f), Color.Transparent), startX = x, endX = x + w),
                            topLeft = Offset(x, -40f), size = Size(w, size.height + 80f),
                        )
                    }
                },
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(AirlockIcons.Phone, null, Modifier.size(16.dp), tint = c.seal)
                Text(stringResource(R.string.sealing_lock), style = Type.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = c.seal)
            }
            Text(if (review.raw.length > 900) review.raw.take(900) + "…" else review.raw, style = Type.body, color = c.text2)
        }
        Column(Modifier.enter(1).fillMaxWidth().card(c), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Step.entries.forEachIndexed { i, step ->
                    val p = review.progress
                    val label = if (step == Step.DETECT && p is SealProgress.Detecting && p.of > 1) stringResource(R.string.step_detect_part, p.section, p.of) else stringResource(step.label)
                    StepRow(label, done = i < at, active = i == at)
                }
            }
            // The ticking timer is visual only; announcing it every 100 ms would drown out the steps.
            Small(
                stringResource(if (rulesOnly) R.string.sealing_elapsed_rules else R.string.sealing_elapsed, String.format(Locale.getDefault(), "%.1f", elapsed)),
                Modifier.clearAndSetSemantics { },
            )
        }
    }
}

@Composable
private fun StepRow(label: String, done: Boolean, active: Boolean) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val a11y = when {
        done -> stringResource(R.string.step_done_a11y, label)
        active -> stringResource(R.string.step_active_a11y, label)
        else -> label
    }
    Row(Modifier.semantics(mergeDescendants = true) { contentDescription = a11y }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        val ping = if (active && !still) rememberInfiniteTransition(label = "ping").animateFloat(0f, 1f, infiniteRepeatable(tween(1400, easing = LinearEasing)), label = "p").value else 0f
        val pop = remember { Animatable(if (done) 1f else 0f) }
        LaunchedEffect(done) { if (done) pop.animateTo(1f, if (still) tween(0) else spring(dampingRatio = 0.45f, stiffness = 500f)) }
        Box(
            Modifier
                .size(22.dp)
                .drawBehind {
                    if (active) {
                        drawCircle(c.sealTint, radius = size.minDimension / 2 + 4.dp.toPx())
                        if (!still) drawCircle(c.seal.copy(alpha = 0.45f * (1f - ping)), radius = size.minDimension / 2 + 10.dp.toPx() * ping, style = Stroke(2.dp.toPx()))
                    }
                }
                .clip(CircleShape)
                .background(if (done) c.seal else c.raised)
                .border(1.8.dp, if (done || active) c.seal else c.stroke, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (done) Icon(AirlockIcons.Check, null, Modifier.size(13.dp).graphicsLayer { scaleX = pop.value; scaleY = pop.value }, tint = c.onSeal)
        }
        Text(label, style = Type.small.copy(fontSize = 14.sp, fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal), color = if (done || active) c.text else c.text2)
    }
}

// MARK: Checked — exactly what will leave, with every control at the border.

@Composable
private fun reasonText(r: ReviewReason): String = when (r) {
    is ReviewReason.PhoneUnavailable -> stringResource(R.string.reason_phone_unavailable)
    is ReviewReason.LlmFailed -> stringResource(R.string.reason_llm_failed)
    is ReviewReason.Refused -> stringResource(R.string.reason_refused)
    ReviewReason.LowConfidence -> stringResource(R.string.reason_low_confidence)
    ReviewReason.Ambiguous -> stringResource(R.string.reason_ambiguous)
    ReviewReason.SecretsFound -> stringResource(R.string.reason_secrets)
    is ReviewReason.Risks -> pluralStringResource(R.plurals.reason_risks, r.count, r.count)
    ReviewReason.RedTeamUnavailable -> stringResource(R.string.reason_redteam_unavailable)
}

@Composable
fun gateCheckName(id: GateCheckId): String = stringResource(
    when (id) {
        GateCheckId.G1 -> R.string.gate_g1
        GateCheckId.G2 -> R.string.gate_g2
        GateCheckId.G3 -> R.string.gate_g3
        GateCheckId.G4 -> R.string.gate_g4
        GateCheckId.G5 -> R.string.gate_g5
        GateCheckId.G6 -> R.string.gate_g6
        GateCheckId.G7 -> R.string.gate_g7
    },
)

@Composable
private fun describe(e: Entity): String = when (val a = e.action) {
    Action.Keep -> stringResource(R.string.detail_kept)
    is Action.Generalise -> stringResource(R.string.detail_general, e.generalisedText ?: stringResource(R.string.detail_general_default))
    Action.Block -> stringResource(R.string.detail_removed)
    Action.Placeholder -> stringResource(R.string.detail_replaced)
}

@Composable
private fun Checked(session: AirlockSession, s: State, review: Review, onSeal: () -> Unit) {
    val c = LocalAirlock.current
    val labels = rememberLabels()
    val haptics = LocalHapticFeedback.current
    val result = review.result ?: return
    var raw by rememberSaveable { mutableStateOf(false) }
    val draft = result.draft
    val entities = draft.entities.sorted()
    val sealedCount = entities.count { it.action != Action.Keep }
    val kept = entities.count { it.action == Action.Keep }
    val generalised = draft.replacements.count { it.kind == ReplacementKind.GENERALISED || it.kind == ReplacementKind.BUCKETED || it.kind == ReplacementKind.REDTEAM }
    val risks = session.pendingRisks(review)
    val pending = result.redTeamPending == true

    LaunchedEffect(review.blocked) { if (review.blocked != null) haptics.performHapticFeedback(HapticFeedbackType.Reject) }

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
            H1(stringResource(R.string.review_title))
            Sub(stringResource(R.string.review_sub))
        }
        Segmented(
            listOf(false to stringResource(R.string.review_view_sealed), true to stringResource(R.string.review_view_raw)), raw, { raw = it },
            Modifier.fillMaxWidth(), a11y = stringResource(R.string.review_view_a11y), icons = listOf(AirlockIcons.Shield, AirlockIcons.Eye),
        )

        if (result.requiresReview) result.reasons.forEach { r ->
            Banner(if (r is ReviewReason.SecretsFound || r is ReviewReason.PhoneUnavailable) Tone.RISK else Tone.WARN, reasonText(r))
        }

        review.blocked?.let { hits ->
            val names = hits.map { it.check }.distinct().map { gateCheckName(it) }
            Banner(Tone.RISK, stringResource(R.string.blocked_title), body = stringResource(R.string.blocked_body, names.joinToString(", ")))
        }

        Column(Modifier.enter(0).fillMaxWidth().card(c), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            AnimatedContent(
                raw,
                transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(120)) },
                label = "view",
            ) { showRaw ->
                if (showRaw) Text(result.normalised.text, style = Type.body, color = c.text)
                else FlowText(sealedPreviewSegs(draft, labels) { e -> toggle(session, e, haptics) }, popIn = true)
            }
            SummaryBar(sealedCount, generalised, kept, result.sealMs)
        }

        AnimatedVisibility(pending, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Row(
                Modifier.fillMaxWidth().card(c).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PulseDot(c.seal)
                Column {
                    Text(stringResource(R.string.redteam_pending_title), style = Type.bodyBold, color = c.text)
                    Small(stringResource(R.string.redteam_pending_body))
                }
            }
        }

        if (risks.isNotEmpty()) {
            LaunchedEffect(risks.size) { haptics.performHapticFeedback(HapticFeedbackType.ContextClick) }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                H2(stringResource(R.string.risks_title))
                risks.forEachIndexed { i, r ->
                    Column(
                        Modifier
                            .enter(i, baseDelayMs = 300)
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(16.dp))
                            .background(c.reviewTint)
                            .border(1.dp, c.review, RoundedCornerShape(16.dp))
                            .padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Box(Modifier.size(30.dp).clip(RoundedCornerShape(10.dp)).background(c.review.copy(alpha = 0.22f)), contentAlignment = Alignment.Center) {
                                Icon(AirlockIcons.Eye, null, Modifier.size(16.dp), tint = c.review)
                            }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                FlowText(listOf(app.airlock.android.ui.Seg.Txt(stringResource(R.string.risk_guess))) + withChipsSegs(r.guess, draft.entities, labels), style = Type.bodyBold)
                                FlowText(
                                    listOf(app.airlock.android.ui.Seg.Txt(stringResource(R.string.risk_because_prefix) + "“")) + withChipsSegs(r.evidence, draft.entities, labels) + app.airlock.android.ui.Seg.Txt("”"),
                                    style = Type.small, color = c.text2,
                                )
                                r.suggestion?.let { sug ->
                                    FlowText(
                                        listOf(app.airlock.android.ui.Seg.Txt(stringResource(R.string.risk_suggestion_prefix) + "“")) + withChipsSegs(sug, draft.entities, labels) + app.airlock.android.ui.Seg.Txt("”"),
                                        style = Type.small, color = c.text2,
                                    )
                                }
                            }
                        }
                        Wrap {
                            if (r.suggestion != null) AirButton(stringResource(R.string.risk_use), { session.acceptRisk(r) }, kind = ButtonKind.PRIMARY, compact = true)
                            AirButton(stringResource(R.string.risk_keep), { session.dismissRisk(r) }, compact = true)
                        }
                    }
                }
            }
        }

        if (entities.isNotEmpty()) {
            Card(Modifier.enter(2)) {
                H2(stringResource(R.string.details_title))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    entities.forEach { e -> EntityRow(e, labels) { toggle(session, e, haptics) } }
                }
            }
        }

        TaskPills(review.task) { session.setReviewTask(it) }
        Wrap {
            AirButton(
                stringResource(if (pending) R.string.seal_finishing else R.string.seal_send), onSeal,
                kind = ButtonKind.PRIMARY, icon = AirlockIcons.Shield, enabled = !pending,
            )
            AirButton(stringResource(R.string.cancel), { session.cancelReview() }, kind = ButtonKind.GHOST)
        }
        Small(stringResource(R.string.review_note))
    }
}

private fun toggle(session: AirlockSession, e: Entity, haptics: androidx.compose.ui.hapticfeedback.HapticFeedback) {
    haptics.performHapticFeedback(if (e.action == Action.Keep) HapticFeedbackType.ToggleOn else HapticFeedbackType.ToggleOff)
    session.toggleEntity(e.id)
}

@Composable
private fun SummaryBar(sealedCount: Int, generalised: Int, kept: Int, sealMs: Double) {
    val c = LocalAirlock.current
    Wrap(spacing = 14.dp) {
        for ((n, label) in listOf(sealedCount to R.string.summary_protected, generalised to R.string.summary_general, kept to R.string.summary_kept)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                AnimatedContent(
                    n,
                    transitionSpec = { (slideInVertically { it / 2 } + fadeIn()) togetherWith (slideOutVertically { -it / 2 } + fadeOut()) },
                    label = "count",
                ) { v -> Text("$v", style = Type.small.copy(fontSize = 14.sp, fontWeight = FontWeight.Bold), color = c.text) }
                Text(stringResource(label), style = Type.small.copy(fontSize = 14.sp), color = c.text2)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Icon(AirlockIcons.Phone, null, Modifier.size(14.dp), tint = c.seal)
            Text(stringResource(R.string.summary_sealed_in, String.format(Locale.getDefault(), "%.1f", sealMs / 1000)), style = Type.small.copy(fontSize = 14.sp), color = c.text2)
        }
    }
}

@Composable
private fun EntityRow(e: Entity, labels: Labels, onToggle: () -> Unit) {
    val c = LocalAirlock.current
    val isProtected = e.action != Action.Keep
    val locked = e.category == PrivacyCategory.SECRET
    val label = labels.chip(e)
    var role = "$label · ${describe(e)}"
    if (e.vaultEntryId != null) role += stringResource(R.string.detail_from_vault)
    if (e.confidence != Confidence.HIGH) role += stringResource(R.string.detail_low)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, c.stroke, RoundedCornerShape(12.dp)).padding(start = 12.dp, top = 4.dp, bottom = 4.dp, end = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CategoryBadge(c.category(e.category), app.airlock.android.ui.AirlockIcons.forCategory(e.category))
        Column(Modifier.weight(1f).padding(vertical = 6.dp)) {
            Text(e.canonical, style = Type.bodyBold.copy(lineHeight = 22.sp), color = c.text)
            Text(role, style = Type.small.copy(fontSize = 14.sp), color = c.text2)
        }
        AirSwitch(isProtected, onToggle, stringResource(R.string.detail_switch_a11y, label), enabled = !locked)
    }
}
