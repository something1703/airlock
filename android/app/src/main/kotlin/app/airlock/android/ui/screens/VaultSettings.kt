package app.airlock.android.ui.screens

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.AppMode
import app.airlock.android.session.State
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Card
import app.airlock.android.ui.CategoryBadge
import app.airlock.android.ui.Field
import app.airlock.android.ui.H1
import app.airlock.android.ui.H2
import app.airlock.android.ui.Pill
import app.airlock.android.ui.Segmented
import app.airlock.android.ui.Small
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Type
import app.airlock.android.ui.Wrap
import app.airlock.android.ui.enter
import app.airlock.core.AnswerPreference
import app.airlock.core.PrivacyCategory
import app.airlock.core.VaultEntry
import java.util.UUID

private val KINDS = listOf(
    PrivacyCategory.PERSON to R.string.cat_person, PrivacyCategory.ORG to R.string.cat_org, PrivacyCategory.LOCATION to R.string.cat_location,
    PrivacyCategory.CONTACT to R.string.cat_contact, PrivacyCategory.ID to R.string.vault_kind_id,
)

@Composable
fun VaultScreen(session: AirlockSession, s: State) {
    val c = LocalAirlock.current
    var name by rememberSaveable { mutableStateOf("") }
    var aliases by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf("") }
    var kind by rememberSaveable { mutableStateOf(PrivacyCategory.PERSON) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
            H1(stringResource(R.string.vault_title))
            Sub(stringResource(R.string.vault_sub))
        }
        Card(Modifier.enter(0)) {
            val kindA11y = stringResource(R.string.vault_kind_a11y)
            Wrap(Modifier.semantics { contentDescription = kindA11y }) {
                KINDS.forEach { (k, label) -> Pill(stringResource(label), kind == k, { kind = k }) }
            }
            Field(name, { name = it }, stringResource(R.string.vault_name_hint), stringResource(R.string.vault_name_a11y), Modifier.fillMaxWidth())
            Field(role, { role = it }, stringResource(R.string.vault_role_hint), stringResource(R.string.vault_role_a11y), Modifier.fillMaxWidth())
            Field(aliases, { aliases = it }, stringResource(R.string.vault_alias_hint), stringResource(R.string.vault_alias_a11y), Modifier.fillMaxWidth(), singleLine = false)
            AirButton(
                stringResource(R.string.vault_add),
                {
                    val entry = VaultEntry(
                        UUID.randomUUID().toString(), name.trim(), aliases.split(",").map { it.trim() }.filter { it.isNotEmpty() }, kind,
                        role.trim().takeIf { it.isNotEmpty() }?.let { "my $it" }, false,
                    )
                    session.saveVault(s.vault + entry)
                    name = ""; aliases = ""; role = ""
                },
                kind = ButtonKind.PRIMARY, icon = AirlockIcons.Plus, enabled = name.isNotBlank(),
            )
        }
        Card(Modifier.enter(1), padding = 14.dp) {
            if (s.vault.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(AirlockIcons.Vault, null, Modifier.size(36.dp), tint = c.seal.copy(alpha = 0.8f))
                    Text(stringResource(R.string.vault_empty), style = Type.body, color = c.text2)
                    Small(stringResource(R.string.vault_empty_sub))
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    s.vault.forEachIndexed { i, v -> VaultRow(v, i) { session.saveVault(s.vault.filter { it.id != v.id }) } }
                }
            }
        }
    }
}

@Composable
private fun VaultRow(v: VaultEntry, index: Int, onRemove: () -> Unit) {
    val c = LocalAirlock.current
    val kindLabel = KINDS.firstOrNull { it.first == v.category }?.second?.let { stringResource(it) } ?: v.category.wire
    var line = kindLabel
    if (v.roleHint != null) line += " · ${v.roleHint}"
    if (v.aliases.isNotEmpty()) line += " · " + stringResource(R.string.vault_also, v.aliases.joinToString("”, “"))
    Row(
        Modifier.enter(index).fillMaxWidth().clip(RoundedCornerShape(12.dp)).border(1.dp, c.stroke, RoundedCornerShape(12.dp)).padding(start = 12.dp, top = 6.dp, bottom = 6.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CategoryBadge(c.category(v.category), AirlockIcons.forCategory(v.category))
        Column(Modifier.weight(1f)) {
            Text(if (v.isUser) stringResource(R.string.vault_you, v.canonical) else v.canonical, style = Type.bodyBold.copy(lineHeight = 22.sp), color = c.text)
            Text(line, style = Type.small.copy(fontSize = 14.sp), color = c.text2)
        }
        AirButton(stringResource(R.string.vault_remove), onRemove, kind = ButtonKind.DANGER_GHOST, compact = true, contentDescription = stringResource(R.string.vault_remove_a11y, v.canonical))
    }
}

@Composable
fun SettingsScreen(session: AirlockSession, s: State) {
    var confirm by rememberSaveable { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        H1(stringResource(R.string.settings_title))
        OnDeviceStatus(session, s)
        Card(Modifier.enter(0)) {
            H2(stringResource(R.string.settings_dial))
            DialCards(s.prefs.dial) { d -> session.setPrefs { it.copy(dial = d) } }
        }
        Card(Modifier.enter(1)) {
            H2(stringResource(R.string.settings_pref))
            Segmented(
                listOf(
                    AnswerPreference.AUTO to stringResource(R.string.pref_auto), AnswerPreference.PHONE_ONLY to stringResource(R.string.pref_phone),
                    AnswerPreference.BEST to stringResource(R.string.pref_best),
                ),
                s.prefs.preference, { p -> session.setPrefs { it.copy(preference = p) } }, Modifier.fillMaxWidth(), a11y = stringResource(R.string.settings_pref),
            )
            Small(stringResource(R.string.settings_pref_note))
        }
        Card(Modifier.enter(2)) {
            H2(stringResource(R.string.settings_honest_title))
            Small(stringResource(R.string.settings_honest))
            Small(stringResource(R.string.settings_storage, session.services.config.rawPurgeDays))
            Small(stringResource(if (session.services.mode == AppMode.LIVE) R.string.settings_mode_live else R.string.settings_mode_demo))
        }
        Card(Modifier.enter(3)) {
            H2(stringResource(R.string.settings_delete_title))
            Small(stringResource(R.string.settings_delete_body))
            AnimatedContent(confirm, transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(120)) }, label = "confirm") { asking ->
                if (asking) Wrap {
                    AirButton(stringResource(R.string.settings_delete_confirm), { confirm = false; session.deleteEverything() }, kind = ButtonKind.DANGER)
                    AirButton(stringResource(R.string.cancel), { confirm = false }, kind = ButtonKind.GHOST)
                } else AirButton(stringResource(R.string.settings_delete_button), { confirm = true }, kind = ButtonKind.DANGER)
            }
        }
    }
}
