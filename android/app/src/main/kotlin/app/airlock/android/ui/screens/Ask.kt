package app.airlock.android.ui.screens

import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.State
import app.airlock.android.session.Turn
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Card
import app.airlock.android.ui.Field
import app.airlock.android.ui.H1
import app.airlock.android.ui.H2
import app.airlock.android.ui.Pill
import app.airlock.android.ui.Small
import app.airlock.android.ui.Sub
import app.airlock.android.ui.Tone
import app.airlock.android.ui.Type
import app.airlock.android.ui.Wrap
import app.airlock.android.ui.bottomHairline
import app.airlock.android.ui.enter
import app.airlock.core.TaskKind

/** The six task pills, in the web's order. */
val TASKS: List<Pair<Int, TaskKind>> = listOf(
    R.string.task_help to TaskKind.Help,
    R.string.task_reply to TaskKind.Reply("firm but polite"),
    R.string.task_explain to TaskKind.Explain,
    R.string.task_summary to TaskKind.Summary,
    R.string.task_questions to TaskKind.Questions,
    R.string.task_actions to TaskKind.Actions,
)

@Composable
fun TaskPills(selected: TaskKind, onSelect: (TaskKind) -> Unit) {
    val a11y = stringResource(R.string.tasks_a11y)
    Wrap(Modifier.semantics { contentDescription = a11y }) {
        TASKS.forEach { (label, task) -> Pill(stringResource(label), task == selected, { onSelect(task) }) }
    }
}

@Composable
fun AskScreen(session: AirlockSession, s: State) {
    val c = LocalAirlock.current
    var taskIndex by rememberSaveable { mutableIntStateOf(0) }
    val sample = stringResource(R.string.ask_sample_text)
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Column {
            H1(stringResource(R.string.ask_title))
            Sub(stringResource(R.string.ask_sub))
        }
        OnDeviceStatus(session, s)
        if (s.draftFromShare) Banner(Tone.INFO, stringResource(R.string.ask_shared))
        Field(
            s.draft, { session.setDraft(it, s.draftFromShare); session.warmUp() }, stringResource(R.string.ask_hint), stringResource(R.string.ask_a11y),
            Modifier.fillMaxWidth().enter(0), minHeight = 180.dp, singleLine = false,
        )
        TaskPills(TASKS[taskIndex].second) { t -> taskIndex = TASKS.indexOfFirst { it.second == t }.coerceAtLeast(0) }
        Wrap {
            AirButton(
                stringResource(if (session.staysOnDevice(TASKS[taskIndex].second, s.draft)) R.string.ask_answer_local else R.string.ask_seal),
                { val text = s.draft; val task = TASKS[taskIndex].second; session.run { submit(text, task) } },
                kind = ButtonKind.PRIMARY, trailingIcon = AirlockIcons.Arrow, enabled = s.draft.isNotBlank(),
            )
            AirButton(stringResource(R.string.ask_sample), { session.setDraft(sample); session.warmUp() }, kind = ButtonKind.GHOST, icon = AirlockIcons.Sparkle)
        }
        if (s.threads.isNotEmpty()) {
            Card(Modifier.enter(1), padding = 16.dp) {
                H2(stringResource(R.string.recent))
                Column {
                    s.threads.forEach { t ->
                        val last = t.turns.lastOrNull { it is Turn.Assistant } as? Turn.Assistant
                        val onDevice = last?.outcome?.ranOnDevice == true
                        val a11y = stringResource(R.string.recent_open_a11y, t.title)
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .clickable(role = Role.Button) { session.openThread(t.id) }
                                .semantics(mergeDescendants = true) { contentDescription = a11y }
                                .bottomHairline(c.stroke)
                                .padding(vertical = 12.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Text(t.title, Modifier.weight(1f), style = Type.body, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(if (onDevice) AirlockIcons.Phone else AirlockIcons.Cloud, null, Modifier.size(14.dp), tint = if (onDevice) c.seal else c.cloud)
                            Small(stringResource(if (onDevice) R.string.recent_on_device else R.string.recent_gemini))
                        }
                    }
                }
            }
        }
        Row(Modifier.padding(bottom = 8.dp)) {}
    }
}
