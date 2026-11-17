package app.airlock.android.ui

import android.os.Build
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.core.Confidence
import app.airlock.core.Entity
import app.airlock.core.EntityMap
import app.airlock.core.Placeholders
import app.airlock.core.PrivacyCategory
import app.airlock.core.ReplacementKind
import app.airlock.core.RestoredSegment
import app.airlock.core.SealDraft
import kotlinx.coroutines.delay

/** What an inline token looks like. */
enum class ChipKind { PLACEHOLDER, GENERALISED, SECRET, UNKNOWN, RESTORED }

/** One inline token: a placeholder chip, a "made less specific" chip, or a restored real name. */
data class ChipSpec(
    val kind: ChipKind,
    val category: PrivacyCategory?,
    val label: String,
    val a11y: String,
    val low: Boolean = false,
    val onClick: (() -> Unit)? = null,
)

/** Text interleaved with inline tokens. */
sealed interface Seg {
    data class Txt(val text: String) : Seg
    data class Chip(val spec: ChipSpec) : Seg
}

/** Localised labels for chips ("Person 1 · landlord"). */
class Labels(
    private val categories: Map<PrivacyCategory, String>,
    private val you: String,
    private val fmt: (String, String, String?) -> String,
    val protectedA11y: (String) -> String,
    val secretA11y: (String) -> String,
    val lowA11y: String,
    val toggleA11y: String,
    val generalA11y: (String) -> String,
    val hiddenCode: String,
    val hiddenCodeA11y: String,
    val unknown: String,
    val unknownA11y: String,
    val restoredA11y: (String) -> String,
) {
    fun category(c: PrivacyCategory): String = categories[c] ?: c.wire

    /** "Person 1 · landlord"; "You" for `PERSON_ME`. */
    fun chip(e: Entity): String {
        if (e.id == Placeholders.ME) return you
        val n = e.id.substringAfter('_')
        val role = e.roleHint?.replace(Regex("^(?:the (?:user|writer)'s|my) ", RegexOption.IGNORE_CASE), "")?.replace(Regex("^the (user|writer)$"), "you")
        return fmt(category(e.category), n, role?.takeIf { it.isNotBlank() })
    }

    /** Label for a bare placeholder id whose entity is unknown. */
    fun id(id: String): String {
        if (id == Placeholders.ME) return you
        val p = Placeholders.parse(id) ?: return id
        return fmt(category(p.category), p.index?.toString() ?: "", null)
    }
}

@Composable
fun rememberLabels(): Labels {
    val cats = mapOf(
        PrivacyCategory.PERSON to stringResource(R.string.cat_person), PrivacyCategory.ORG to stringResource(R.string.cat_org),
        PrivacyCategory.LOCATION to stringResource(R.string.cat_location), PrivacyCategory.CONTACT to stringResource(R.string.cat_contact),
        PrivacyCategory.ID to stringResource(R.string.cat_id), PrivacyCategory.DATE to stringResource(R.string.cat_date),
        PrivacyCategory.HEALTH to stringResource(R.string.cat_health), PrivacyCategory.SECRET to stringResource(R.string.cat_secret),
        PrivacyCategory.QUASI to stringResource(R.string.cat_quasi),
    )
    val you = stringResource(R.string.chip_you)
    val plain = stringResource(R.string.chip_label)
    val withRole = stringResource(R.string.chip_label_role)
    val prot = stringResource(R.string.chip_a11y_protected)
    val secret = stringResource(R.string.chip_a11y_secret)
    val low = stringResource(R.string.chip_a11y_low)
    val toggle = stringResource(R.string.chip_a11y_toggle)
    val general = stringResource(R.string.chip_a11y_general)
    val hidden = stringResource(R.string.chip_hidden_code)
    val hiddenA11y = stringResource(R.string.chip_hidden_code_a11y)
    val unknown = stringResource(R.string.chip_unknown)
    val unknownA11y = stringResource(R.string.chip_unknown_a11y)
    val restored = stringResource(R.string.restored_a11y)
    return remember(cats, you) {
        Labels(
            cats, you, { c, n, role -> if (role == null) String.format(plain, c, n) else String.format(withRole, c, n, role) },
            { String.format(prot, it) }, { String.format(secret, it) }, low, toggle, { String.format(general, it) }, hidden, hiddenA11y, unknown,
            unknownA11y, { String.format(restored, it) },
        )
    }
}

// MARK: Builders

private fun entityChip(e: Entity?, id: String, labels: Labels, blocked: Boolean, onClick: (() -> Unit)?): ChipSpec {
    val category = e?.category ?: Placeholders.parse(id)?.category
    val label = e?.let(labels::chip) ?: labels.id(id)
    val low = e != null && e.confidence != Confidence.HIGH
    val secret = blocked || category == PrivacyCategory.SECRET
    var a11y = if (secret) labels.secretA11y(label) else labels.protectedA11y(label)
    if (low) a11y += labels.lowA11y
    if (onClick != null) a11y += labels.toggleA11y
    return ChipSpec(if (category == PrivacyCategory.SECRET) ChipKind.SECRET else ChipKind.PLACEHOLDER, category, label, a11y, low, onClick)
}

/** The sealed draft as it will leave: text with chips. Tapping an entity chip toggles it. */
fun sealedPreviewSegs(draft: SealDraft, labels: Labels, onChip: ((Entity) -> Unit)?): List<Seg> {
    val out = ArrayList<Seg>()
    var cursor = 0
    for (r in draft.replacements.sortedBy { it.sealedSpan.start }) {
        if (r.sealedSpan.start < cursor || r.sealedSpan.end > draft.text.length) continue
        if (r.sealedSpan.start > cursor) out.add(Seg.Txt(draft.text.substring(cursor, r.sealedSpan.start)))
        val shown = draft.text.substring(r.sealedSpan.start, r.sealedSpan.end)
        val e = r.entityId?.let { draft.entities[it] }
        out.add(
            Seg.Chip(
                when (r.kind) {
                    ReplacementKind.GENERALISED, ReplacementKind.BUCKETED, ReplacementKind.REDTEAM ->
                        ChipSpec(ChipKind.GENERALISED, null, shown, labels.generalA11y(shown))
                    else -> entityChip(e, r.entityId ?: shown.removeSurrounding("[[", "]]"), labels, r.kind == ReplacementKind.BLOCKED, if (e != null && onChip != null && e.category != PrivacyCategory.SECRET) ({ onChip(e) }) else null)
                },
            ),
        )
        cursor = r.sealedSpan.end
    }
    if (cursor < draft.text.length) out.add(Seg.Txt(draft.text.substring(cursor)))
    return out
}

private val TOKEN = Regex("\\[\\[([A-Z]+_(?:\\d+|ME))]]")
private val BARE = Regex("(?:\\[\\[)?\\b((?:PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET)_(?:\\d+|ME))\\b(?:]])?")

/** Placeholder tokens in sealed text rendered as chips (sent turns, receipts). */
fun sealedTextSegs(text: String, entities: EntityMap, labels: Labels): List<Seg> = split(text, TOKEN) { id -> entityChip(entities[id], id, labels, false, null) }

/** Bare or bracketed placeholder ids in model-written text (risk cards: "lives near LOC_1"). */
fun withChipsSegs(text: String, entities: EntityMap, labels: Labels): List<Seg> = split(text, BARE) { id -> entityChip(entities[id], id, labels, false, null) }

private fun split(text: String, re: Regex, chip: (String) -> ChipSpec): List<Seg> {
    val out = ArrayList<Seg>()
    var cursor = 0
    for (m in re.findAll(text)) {
        if (m.range.first > cursor) out.add(Seg.Txt(text.substring(cursor, m.range.first)))
        out.add(Seg.Chip(chip(m.groupValues[1])))
        cursor = m.range.last + 1
    }
    if (cursor < text.length) out.add(Seg.Txt(text.substring(cursor)))
    return out
}

/** A restored answer: real names come back as underlined tokens that unseal (blur → sharp). Secrets never return. */
fun restoredSegs(segments: List<RestoredSegment>, labels: Labels): List<Seg> = segments.map { s ->
    when (s) {
        is RestoredSegment.Text -> Seg.Txt(s.text)
        is RestoredSegment.Restored -> Seg.Chip(ChipSpec(ChipKind.RESTORED, null, s.display, labels.restoredA11y(s.display)))
        is RestoredSegment.Secret -> Seg.Chip(ChipSpec(ChipKind.SECRET, PrivacyCategory.SECRET, labels.hiddenCode, labels.hiddenCodeA11y))
        is RestoredSegment.Unknown -> Seg.Chip(ChipSpec(ChipKind.UNKNOWN, PrivacyCategory.ID, labels.unknown, labels.unknownA11y))
    }
}

// MARK: Rendering

/**
 * Flowing text with inline tokens (Compose `InlineTextContent`). Each token's placeholder is sized by measuring its
 * label, so chips sit in the line like words. `popIn` staggers chips in (spring scale + blur), like the web's
 * `.sealed-card .chip`; restored names always unseal once as they arrive.
 */
@Composable
fun FlowText(segs: List<Seg>, modifier: Modifier = Modifier, style: TextStyle = Type.body, color: Color = LocalAirlock.current.text, popIn: Boolean = false) {
    val measurer = rememberTextMeasurer(cacheSize = 64)
    val density = LocalDensity.current
    val chipStyle = style.copy(fontSize = style.fontSize * 0.9f, fontWeight = FontWeight.SemiBold, lineHeight = style.fontSize * 1.1f)
    val inline = HashMap<String, InlineTextContent>()
    val text: AnnotatedString = buildAnnotatedString {
        var chipIndex = 0
        segs.forEachIndexed { i, s ->
            when (s) {
                is Seg.Txt -> append(s.text)
                is Seg.Chip -> {
                    val spec = s.spec
                    val id = "t$i"
                    val restored = spec.kind == ChipKind.RESTORED
                    val labelStyle = if (restored) style.copy(lineHeight = style.fontSize * 1.1f) else chipStyle
                    val textW = measurer.measure(AnnotatedString(spec.label), labelStyle, maxLines = 1, softWrap = false).size.width.toFloat()
                    val px = with(density) {
                        if (restored) textW + 2.dp.toPx()
                        else textW + 16.dp.toPx() + (chipStyle.fontSize.toPx() + 4.dp.toPx()) + (if (spec.low) 10.dp.toPx() else 0f) + 3.dp.toPx()
                    }
                    val w = with(density) { px.toSp() }
                    val h = style.fontSize * 1.42f
                    val index = chipIndex++
                    inline[id] = InlineTextContent(Placeholder(w, h, PlaceholderVerticalAlign.TextCenter)) {
                        InlineToken(spec, labelStyle, if (popIn) index else -1)
                    }
                    appendInlineContent(id, spec.label)
                }
            }
        }
    }
    Text(text, modifier, style = style, color = color, inlineContent = inline)
}

@Composable
private fun InlineToken(spec: ChipSpec, labelStyle: TextStyle, popIndex: Int) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    if (spec.kind == ChipKind.RESTORED) {
        // The return: the real name unseals (blur → sharp), its highlight fades, and the seal-green underline draws in.
        val k = remember { Animatable(if (still) 1f else 0f) }
        LaunchedEffect(Unit) { if (!still) k.animateTo(1f, tween(700, easing = EaseOutExpo)) }
        val v = k.value
        Box(
            Modifier
                .fillMaxSize()
                .semantics { contentDescription = spec.a11y }
                .drawBehind {
                    drawRoundRect(c.seal.copy(alpha = 0.28f * (1f - v)), cornerRadius = CornerRadius(4.dp.toPx()))
                    val y = size.height - 2.dp.toPx()
                    drawLine(c.seal.copy(alpha = v), Offset(1.dp.toPx(), y), Offset(size.width - 1.dp.toPx(), y), 2.dp.toPx())
                }
                .then(if (!still && Build.VERSION.SDK_INT >= 31 && v < 0.6f) Modifier.blur((3f * (1f - v / 0.6f)).dp) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Text(spec.label, style = labelStyle, color = c.text, maxLines = 1, softWrap = false)
        }
        return
    }
    val tint = when (spec.kind) {
        ChipKind.GENERALISED -> c.text2
        ChipKind.SECRET -> c.risk
        else -> c.category(spec.category)
    }
    val bg = when (spec.kind) {
        ChipKind.GENERALISED -> Color.Transparent
        ChipKind.SECRET -> c.riskTint
        else -> c.category(spec.category).copy(alpha = 0.16f)
    }
    val icon: ImageVector = when (spec.kind) {
        ChipKind.GENERALISED -> AirlockIcons.Sparkle
        ChipKind.SECRET -> AirlockIcons.Secret
        ChipKind.UNKNOWN -> AirlockIcons.Question
        else -> spec.category?.let(AirlockIcons::forCategory) ?: AirlockIcons.Sparkle
    }
    val pop = remember { Animatable(if (still || popIndex < 0) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (pop.value < 1f) {
            delay(120L + popIndex * 80L)
            pop.animateTo(1f, spring(dampingRatio = 0.5f, stiffness = 380f))
        }
    }
    val p = pop.value
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 1.5.dp)
            .graphicsLayer {
                alpha = p.coerceIn(0f, 1f)
                val s = 0.6f + 0.4f * p
                scaleX = s
                scaleY = s
            }
            .then(if (Build.VERSION.SDK_INT >= 31 && p < 0.95f && !still) Modifier.blur((4f * (1f - p).coerceAtLeast(0f)).dp) else Modifier)
            .clip(shape)
            .background(bg)
            .then(
                if (spec.kind == ChipKind.GENERALISED) Modifier.drawBehind {
                    drawRoundRect(c.muted, cornerRadius = CornerRadius(8.dp.toPx()), style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))))
                } else Modifier,
            )
            .then(if (spec.onClick != null) Modifier.clickable(role = Role.Button, onClick = spec.onClick) else Modifier)
            .semantics { contentDescription = spec.a11y }
            .padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(icon, null, Modifier.size(with(LocalDensity.current) { labelStyle.fontSize.toDp() }), tint = tint)
        Text(spec.label, style = labelStyle, color = tint, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
        if (spec.low) Box(Modifier.size(6.dp).clip(CircleShape).background(c.review))
    }
}

/** A standalone chip (outside flowing text), e.g. on the onboarding hero. */
@Composable
fun StandaloneChip(category: PrivacyCategory, label: String, modifier: Modifier = Modifier) {
    val c = LocalAirlock.current
    val tint = c.category(category)
    Row(
        modifier.clip(RoundedCornerShape(8.dp)).background(tint.copy(alpha = 0.16f)).border(1.dp, Color.Transparent, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Icon(AirlockIcons.forCategory(category), null, Modifier.size(15.dp), tint = tint)
        Text(label, style = Type.small.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold), color = tint, maxLines = 1)
    }
}
