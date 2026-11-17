package app.airlock.android.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.State
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.Card
import app.airlock.android.ui.H1
import app.airlock.android.ui.H2
import app.airlock.android.ui.Small
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Tone
import app.airlock.android.ui.Type
import app.airlock.android.ui.bottomHairline
import app.airlock.android.ui.countUp
import app.airlock.android.ui.enter
import app.airlock.android.ui.reduceMotion
import app.airlock.core.ChainVerification
import app.airlock.core.ON_DEVICE_MODEL
import app.airlock.core.PrivacyCategory
import app.airlock.core.Receipt
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

@Composable
private fun categoryCount(wire: String, n: Int): String = pluralStringResource(
    when (PrivacyCategory.fromWire(wire)) {
        PrivacyCategory.PERSON -> R.plurals.cat_count_person
        PrivacyCategory.ORG -> R.plurals.cat_count_org
        PrivacyCategory.LOCATION -> R.plurals.cat_count_location
        PrivacyCategory.CONTACT -> R.plurals.cat_count_contact
        PrivacyCategory.ID -> R.plurals.cat_count_id
        PrivacyCategory.DATE -> R.plurals.cat_count_date
        PrivacyCategory.HEALTH -> R.plurals.cat_count_health
        PrivacyCategory.SECRET -> R.plurals.cat_count_secret
        else -> R.plurals.cat_count_quasi
    },
    n, n,
)

@Composable
fun LedgerScreen(session: AirlockSession, s: State) {
    val c = LocalAirlock.current
    val haptics = LocalHapticFeedback.current
    val stats = remember(s.receipts) { session.stats(7) }
    val receipts = s.receipts.asReversed()
    val hero = countUp(stats.sealedDetails)
    var verifyRun by rememberSaveable { mutableIntStateOf(0) }
    val chain = s.chain
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
            H1(stringResource(R.string.ledger_title))
            Sub(stringResource(R.string.ledger_sub))
        }
        Card(Modifier.enter(0)) {
            val heroA11y = stringResource(R.string.ledger_hero_a11y, stats.sealedDetails)
            Column(Modifier.clearAndSetSemantics { contentDescription = heroA11y }) {
                Text("$hero", style = Type.hero, color = c.seal)
                Small(pluralStringResource(R.plurals.ledger_hero_label, stats.sealedDetails))
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                StatLine(stats.requests, pluralStringResource(R.plurals.ledger_requests, stats.requests))
                StatLine(stats.onDeviceAnswers, pluralStringResource(R.plurals.ledger_on_device, stats.onDeviceAnswers))
                val parts = stats.byCategory.filter { it.value > 0 }.map { (k, v) -> categoryCount(k, v) }
                Small(if (parts.isEmpty()) stringResource(R.string.ledger_none_sealed) else parts.joinToString(" · "))
            }
        }
        AirButton(stringResource(R.string.ledger_verify), {
            val result = session.verifyChain()
            verifyRun++
            haptics.performHapticFeedback(if (result is ChainVerification.Valid) HapticFeedbackType.Confirm else HapticFeedbackType.Reject)
        }, icon = AirlockIcons.Link)
        when (chain) {
            is ChainVerification.Valid -> Banner(Tone.OK, pluralStringResource(R.plurals.ledger_chain_ok, chain.count, chain.count))
            is ChainVerification.Invalid -> Banner(Tone.RISK, stringResource(R.string.ledger_chain_broken, chain.seq), body = stringResource(R.string.ledger_chain_reason, chain.reason.name.lowercase().replace('_', ' ')))
            null -> {}
        }
        Card(Modifier.enter(1), padding = 16.dp) {
            H2(stringResource(R.string.ledger_receipts))
            if (receipts.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(AirlockIcons.Ledger, null, Modifier.size(36.dp), tint = c.seal.copy(alpha = 0.8f))
                    Text(stringResource(R.string.ledger_empty), style = Type.body, color = c.text2)
                    Small(stringResource(R.string.ledger_empty_sub))
                }
            } else {
                Column {
                    receipts.forEachIndexed { i, r ->
                        val chainIndex = receipts.size - 1 - i
                        ReceiptRow(r, chainIndex, lit = verifyRun > 0 && chain is ChainVerification.Valid, verifyRun = verifyRun, broken = chain is ChainVerification.Invalid && chain.seq == r.seq)
                    }
                }
            }
        }
    }
}

@Composable
private fun StatLine(n: Int, label: String) {
    val c = LocalAirlock.current
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("$n", style = Type.bodyBold, color = c.text)
        Text(label, style = Type.body, color = c.text)
    }
}

private val DATE: DateTimeFormatter = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT)

@Composable
private fun ReceiptRow(r: Receipt, index: Int, lit: Boolean, verifyRun: Int, broken: Boolean) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    var open by rememberSaveable(r.id) { mutableStateOf(false) }
    // Verify chain: rows light up in chain order (oldest first), each link icon appearing as its row checks out.
    val glow = remember { Animatable(0f) }
    var linked by remember { mutableStateOf(false) }
    LaunchedEffect(verifyRun, lit) {
        if (!lit) {
            linked = false
            return@LaunchedEffect
        }
        if (still) {
            linked = true
            return@LaunchedEffect
        }
        linked = false
        delay(index * 120L)
        linked = true
        glow.snapTo(0f)
        glow.animateTo(1f, tween(315))
        glow.animateTo(0f, tween(585))
    }
    val linkAlpha by animateFloatAsState(if (linked) 1f else 0f, tween(if (still) 0 else 300), label = "link")
    val when_ = runCatching { DATE.format(Instant.parse(r.createdAt).atZone(ZoneId.systemDefault())) }.getOrDefault(r.createdAt)
    val onDevice = r.modelVersion == ON_DEVICE_MODEL
    val model = if (onDevice) stringResource(R.string.ledger_on_device_model) else prettyModel(r.modelVersion)
    val summary = stringResource(R.string.ledger_row, model, r.outboundChars, when_)
    val a11y = stringResource(R.string.ledger_row_a11y, r.seq, summary)
    val gate = stringResource(if (r.gatePassed) R.string.ledger_gate_ok else R.string.ledger_gate_bypassed)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (broken) c.riskTint else c.sealTint.copy(alpha = glow.value)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(role = Role.Button) { open = !open }
                .semantics(mergeDescendants = true) {
                    contentDescription = a11y
                    stateDescription = gate
                }
                .bottomHairline(c.stroke)
                .padding(vertical = 12.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(Modifier.width(58.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(AirlockIcons.Link, null, Modifier.size(14.dp).graphicsLayer { alpha = linkAlpha }, tint = c.seal)
                Text("#${r.seq}", style = Type.mono, color = c.text)
            }
            Icon(if (onDevice) AirlockIcons.Phone else AirlockIcons.Cloud, null, Modifier.size(14.dp), tint = if (onDevice) c.seal else c.cloud)
            Text(summary, Modifier.weight(1f), style = Type.small, color = c.text)
            Box(Modifier.size(10.dp).clip(CircleShape).background(if (r.gatePassed) c.seal else c.risk))
        }
        AnimatedVisibility(open, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
            Column(
                Modifier.padding(vertical = 10.dp).fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(c.bg).padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Small(stringResource(R.string.ledger_exact))
                Text(r.outboundText ?: stringResource(R.string.ledger_not_kept), style = Type.mono, color = c.text)
                Text("sha256 ${r.outboundSha256}", style = Type.mono, color = c.text2)
                Text("prev ${r.prevHash.take(16)}… · hash ${r.hash.take(16)}…", style = Type.mono, color = c.text2)
                Small(stringResource(R.string.ledger_checks, r.gateChecks.joinToString(" "), (r.latencyMs["seal"] ?: 0L).toInt(), (r.latencyMs["network"] ?: 0L).toInt()))
            }
        }
    }
}
