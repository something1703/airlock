package app.airlock.android.ui.screens

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.AirlockColors
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.evidence.Evidence
import app.airlock.android.evidence.Measure
import app.airlock.android.evidence.loadEvidence
import app.airlock.android.evidence.pct
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.Screen
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Card
import app.airlock.android.ui.EaseOutExpo
import app.airlock.android.ui.H1
import app.airlock.android.ui.H2
import app.airlock.android.ui.Small
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Tone
import app.airlock.android.ui.Type
import app.airlock.android.ui.card
import app.airlock.android.ui.enter
import app.airlock.android.ui.reduceMotion
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

private val CountEase = CubicBezierEasing(0.33f, 1f, 0.68f, 1f)

/**
 * "How Airlock is tested" (docs/06-UI-UX.md §5.12; same layout and copy as web/src/ui/screens/Evidence.tsx): the latest
 * AirlockBench report. A mock run is always shown under its label, with dashed tiles and muted numbers.
 * Everything is drawn here with Canvas — no chart library. Motion follows the system animator scale (Compose
 * scales every tween by it) and is skipped entirely when animations are off.
 */
@Composable
fun EvidenceScreen(session: AirlockSession) {
    val evidence = remember { loadEvidence(session.services.config.string("evidence_json")) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        AirButton(stringResource(R.string.back), { session.go(Screen.SETTINGS) }, kind = ButtonKind.GHOST, compact = true)
        Column {
            H1(stringResource(R.string.ev_title))
            if (evidence != null) Sub(stringResource(R.string.ev_sub))
        }
        if (evidence == null) Banner(Tone.INFO, stringResource(R.string.ev_none)) else EvidenceBody(evidence)
    }
}

@Composable
private fun EvidenceBody(e: Evidence) {
    val c = LocalAirlock.current
    val locale = LocalConfiguration.current.locales[0] ?: Locale.ROOT
    if (e.mock) Banner(Tone.WARN, e.label ?: stringResource(R.string.ev_mock_fallback), body = stringResource(R.string.ev_mock_body))

    data class TileSpec(val label: String, val m: Measure, val def: String, val lower: Boolean, val icon: ImageVector)
    val tiles = buildList {
        add(TileSpec(stringResource(R.string.ev_leak), e.leakRate, stringResource(R.string.ev_leak_def), true, AirlockIcons.Shield))
        add(TileSpec(stringResource(R.string.ev_names), e.namesCaught, stringResource(R.string.ev_names_def), false, AirlockIcons.Sparkle))
        add(TileSpec(stringResource(R.string.ev_quality), e.quality, stringResource(R.string.ev_quality_def), false, AirlockIcons.Ledger))
        e.onDevice?.let { add(TileSpec(stringResource(R.string.ev_device), it, stringResource(R.string.ev_device_def), false, AirlockIcons.Phone)) }
    }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val two = maxWidth >= 560.dp
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            tiles.withIndex().chunked(if (two) 2 else 1).forEach { row ->
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    row.forEach { (i, t) -> Tile(t.label, t.m, t.def, t.lower, t.icon, i, e.mock, locale, Modifier.weight(1f).fillMaxHeight()) }
                    if (row.size == 1 && two) Box(Modifier.weight(1f))
                }
            }
        }
    }

    Card(Modifier.enter(tiles.size)) {
        H2(stringResource(R.string.ev_chart_title))
        Small(stringResource(R.string.ev_chart_sub))
        Ablation(e, locale)
    }

    if (e.misses.isNotEmpty()) {
        Card(Modifier.enter(tiles.size + 1)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(AirlockIcons.Alert, null, Modifier.size(18.dp), tint = c.review)
                H2(stringResource(R.string.ev_misses_title))
            }
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                e.misses.forEach { m ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.padding(top = 8.5.dp).size(5.dp).clip(RoundedCornerShape(50)).background(c.text2))
                        Text(m, style = Type.body.copy(fontSize = 15.sp, lineHeight = 22.sp), color = c.text)
                    }
                }
            }
            Small(stringResource(R.string.ev_misses_note))
        }
    }

    val langs = e.languages.joinToString(", ") { Locale.forLanguageTag(it).getDisplayLanguage(locale).ifEmpty { it } }
    val date = runCatching {
        DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG).withLocale(locale).format(Instant.parse(e.createdAt).atZone(ZoneId.systemDefault()))
    }.getOrDefault(e.createdAt)
    val footer = pluralStringResource(R.plurals.ev_footer, e.n, e.n, langs, date, e.dataset, e.split)
    val linkText = e.method.removePrefix("https://").removePrefix("http://").replace("/tree/main", "")
    Text(
        buildAnnotatedString {
            append(footer)
            append(" ") // aapt trims a trailing space in the resource
            if (e.method.startsWith("https://")) {
                withLink(LinkAnnotation.Url(e.method, TextLinkStyles(SpanStyle(color = c.seal, textDecoration = TextDecoration.Underline)))) { append(linkText) }
            } else append(linkText)
            append(".")
        },
        style = Type.small,
        color = c.text2,
    )
}

/** A dashed hairline instead of the solid one: this card holds mock numbers. */
private fun Modifier.dashedCard(c: AirlockColors): Modifier = this
    .clip(RoundedCornerShape(20.dp))
    .background(c.raised)
    .drawBehind {
        val w = 1.5.dp.toPx()
        drawRoundRect(
            lerp(c.stroke, c.text2, 0.45f), topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w),
            cornerRadius = CornerRadius(20.dp.toPx() - w / 2),
            style = Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
        )
    }
    .padding(16.dp)

@Composable
private fun Tile(label: String, m: Measure, definition: String, lowerIsBetter: Boolean, icon: ImageVector, index: Int, mock: Boolean, locale: Locale, modifier: Modifier) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val p = remember { Animatable(if (still) 1f else 0f) }
    LaunchedEffect(Unit) { if (!still) p.animateTo(1f, tween(900, delayMillis = index * 60, easing = CountEase)) }
    val shown = Math.round(m.value * 1000 * p.value) / 10.0
    val better = stringResource(if (lowerIsBetter) R.string.ev_lower else R.string.ev_higher)
    val lo = pct(m.low, 1, locale)
    val hi = pct(m.high, 1, locale)
    val a11y = (if (mock) stringResource(R.string.ev_mock_a11y) + " " else "") +
        stringResource(R.string.ev_tile_a11y, label, pct(m.value, 1, locale), lo, hi, m.n, better, definition)
    Column(
        modifier.enter(index).clearAndSetSemantics { contentDescription = a11y }.then(if (mock) Modifier.dashedCard(c) else Modifier.card(c, padding = 16.dp)),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(28.dp).clip(RoundedCornerShape(9.dp)).background(c.sealTint), contentAlignment = Alignment.Center) {
                Icon(icon, null, Modifier.size(16.dp), tint = c.seal)
            }
            Text(label, style = Type.small.copy(fontSize = 14.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.3.sp), color = c.text)
        }
        Text(
            String.format(locale, "%.1f%%", shown),
            Modifier.padding(top = 4.dp),
            style = TextStyle(fontSize = 40.sp, lineHeight = 44.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.8).sp, fontFeatureSettings = "tnum"),
            color = if (mock) c.text2 else c.text,
        )
        // The 95% interval on a 0–100% track; the point travels with the count.
        Canvas(Modifier.fillMaxWidth().height(12.dp)) {
            val w = size.width
            val h = size.height
            drawRoundRect(c.stroke, Offset(0f, h * 0.4f), Size(w, h * 0.2f), CornerRadius(h * 0.1f))
            val rangeW = maxOf(w * 0.008f, ((m.high - m.low) * w).toFloat())
            drawRoundRect(c.seal.copy(alpha = 0.35f * p.value), Offset((m.low * w).toFloat(), h * 0.2f), Size(rangeW, h * 0.6f), CornerRadius(h * 0.3f))
            val px = (m.value * p.value * w).toFloat().coerceIn(0f, w)
            val pw = 2.dp.toPx()
            drawRect(c.seal, Offset((px - pw / 2).coerceIn(0f, w - pw), 0f), Size(pw, h))
        }
        Small(stringResource(R.string.ev_interval, lo, hi, m.n, better))
        Text(definition, style = Type.small, color = c.text2)
    }
}

/** Leak rate as each layer is added — bars with 95% interval whiskers, the last (full) configuration in the seal colour. */
@Composable
private fun Ablation(e: Evidence, locale: Locale) {
    val c = LocalAirlock.current
    val rows = e.ablation
    if (rows.isEmpty()) return
    val still = reduceMotion()
    val grow = remember(rows) { rows.map { Animatable(if (still) 1f else 0f) } }
    LaunchedEffect(rows) {
        if (!still) grow.forEachIndexed { i, a -> launch { a.animateTo(1f, tween(700, delayMillis = 200 + i * 120, easing = EaseOutExpo)) } }
    }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelStyle = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, color = c.text, textAlign = TextAlign.End)
    val valueStyle = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.Bold, color = c.text)
    val axisStyle = TextStyle(fontSize = 12.sp, color = c.text2)
    val parts = rows.map { r -> stringResource(R.string.ev_chart_row_a11y, r.label, pct(r.leak.value, 0, locale), pct(r.leak.low, 0, locale), pct(r.leak.high, 0, locale)) }
    val a11y = stringResource(R.string.ev_chart_a11y, parts.joinToString(", "))
    val ticks = listOf(0.0, 0.25, 0.5, 0.75, 1.0)
    val barColor = lerp(c.raised, c.risk, 0.55f)
    val whisker = c.text.copy(alpha = 0.7f)

    BoxWithConstraints(Modifier.fillMaxWidth().semantics { contentDescription = a11y; role = Role.Image }) {
        val widthPx = constraints.maxWidth.toFloat()
        with(density) {
            val labels = rows.map { measurer.measure(it.label, labelStyle, constraints = Constraints(maxWidth = (widthPx * 0.42f).toInt().coerceAtLeast(1))) }
            val values = rows.map { measurer.measure(pct(it.leak.value, 0, locale), valueStyle) }
            val tickText = ticks.map { measurer.measure(pct(it, 0, locale), axisStyle) }
            val left = labels.maxOf { it.size.width } + 12.dp.toPx()
            val right = maxOf(values.maxOf { it.size.width }.toFloat(), tickText.last().size.width / 2f) + 12.dp.toPx()
            val barH = 22.dp.toPx()
            val rowH = maxOf(46.dp.toPx(), labels.maxOf { it.size.height } + 16.dp.toPx(), barH + 16.dp.toPx())
            val top = 10.dp.toPx()
            val gridBottom = top + rows.size * rowH
            val heightPx = gridBottom + 6.dp.toPx() + tickText[0].size.height

            Canvas(Modifier.fillMaxWidth().height(heightPx.toDp())) {
                val span = (size.width - left - right).coerceAtLeast(1f)
                fun x(v: Double) = left + v.toFloat().coerceIn(0f, 1f) * span
                ticks.forEachIndexed { i, t ->
                    drawLine(c.stroke, Offset(x(t), top - 4.dp.toPx()), Offset(x(t), gridBottom), 1.dp.toPx())
                    val tl = tickText[i]
                    drawText(tl, topLeft = Offset((x(t) - tl.size.width / 2f).coerceIn(0f, size.width - tl.size.width), gridBottom + 6.dp.toPx()))
                }
                rows.forEachIndexed { i, r ->
                    val y = top + i * rowH
                    val cy = y + rowH / 2
                    val lab = labels[i]
                    drawText(lab, topLeft = Offset(left - 12.dp.toPx() - lab.size.width, cy - lab.size.height / 2f))
                    val barW = maxOf(2.dp.toPx(), (x(r.leak.value) - x(0.0)) * grow[i].value)
                    drawRoundRect(if (i == rows.lastIndex) c.seal else barColor, Offset(x(0.0), cy - barH / 2), Size(barW, barH), CornerRadius(6.dp.toPx()))
                    val sw = 1.6.dp.toPx()
                    val tick = 6.dp.toPx()
                    drawLine(whisker, Offset(x(r.leak.low), cy), Offset(x(r.leak.high), cy), sw)
                    drawLine(whisker, Offset(x(r.leak.low), cy - tick), Offset(x(r.leak.low), cy + tick), sw)
                    drawLine(whisker, Offset(x(r.leak.high), cy - tick), Offset(x(r.leak.high), cy + tick), sw)
                    val v = values[i]
                    drawText(v, topLeft = Offset(minOf(x(r.leak.high) + 8.dp.toPx(), size.width - right + 8.dp.toPx()), cy - v.size.height / 2f))
                }
            }
        }
    }
}

/** Settings row that opens [EvidenceScreen] (web: the `.ev-link` card). */
@Composable
fun EvidenceLink(onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    val title = stringResource(R.string.settings_evidence_title)
    val body = stringResource(R.string.settings_evidence_body)
    Row(
        modifier
            .fillMaxWidth()
            .card(c, padding = 0.dp)
            .clickable(role = Role.Button, onClickLabel = title, onClick = onOpen)
            .semantics(mergeDescendants = true) {}
            .padding(18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Type.bodyBold.copy(lineHeight = 22.sp), color = c.text)
            Small(body)
        }
        Icon(AirlockIcons.Arrow, null, Modifier.size(20.dp), tint = c.text2)
    }
}
