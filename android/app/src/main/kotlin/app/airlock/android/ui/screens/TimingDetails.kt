package app.airlock.android.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.airlock.android.LocalAirlock
import app.airlock.android.R
import app.airlock.android.ui.Type
import app.airlock.core.SealTimings

/** FX-02: where the seal's time went, on this device. Numbers only. */
@Composable
internal fun TimingDetails(timings: SealTimings) {
    val c = LocalAirlock.current
    val locale = LocalConfiguration.current.locales[0]
    var open by rememberSaveable { mutableStateOf(false) }
    fun secs(ms: Double) = String.format(locale, "%.1f", ms / 1000)
    val rows = buildList {
        add(stringResource(R.string.timing_rules) to stringResource(R.string.timing_seconds, secs(timings.rulesMs)))
        add(stringResource(R.string.timing_detect) to stringResource(R.string.timing_seconds_calls, secs(timings.detectMs), timings.detectCalls + timings.repairCalls))
        if (timings.generaliseCalls > 0) add(stringResource(R.string.timing_generalise) to stringResource(R.string.timing_seconds_calls, secs(timings.generaliseMs), timings.generaliseCalls))
        if (timings.redTeamCalls > 0) add(stringResource(R.string.timing_redteam) to stringResource(R.string.timing_seconds_calls, secs(timings.redTeamMs), timings.redTeamCalls))
        timings.firstModelOutputMs?.let { add(stringResource(R.string.timing_first_reply) to stringResource(R.string.timing_after, secs(it))) }
        add(stringResource(R.string.timing_ready) to stringResource(R.string.timing_after, secs(timings.totalMs)))
    }
    val small = Type.small.copy(fontSize = 13.sp)
    val stateText = stringResource(if (open) R.string.timing_shown else R.string.timing_hidden)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            stringResource(R.string.timing_title) + if (open) " ▴" else " ▾",
            style = small, color = c.text2,
            modifier = Modifier.heightIn(min = 32.dp).clickable(role = Role.Button) { open = !open }.semantics { stateDescription = stateText },
        )
        AnimatedVisibility(open) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                for ((label, value) in rows) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text(label, style = small, color = c.text2)
                        Text(value, style = small, color = c.text2)
                    }
                }
            }
        }
    }
}
