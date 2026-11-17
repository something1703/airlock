package app.airlock.android.ui.screens

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.airlock.android.R
import app.airlock.android.session.AirlockSession
import app.airlock.android.session.AppMode
import app.airlock.android.session.DemoReason
import app.airlock.android.session.State
import app.airlock.android.ui.AirButton
import app.airlock.android.ui.AirlockIcons
import app.airlock.android.ui.Banner
import app.airlock.android.ui.ButtonKind
import app.airlock.android.ui.Tone
import app.airlock.core.PhoneAvailability

/** Gemini Nano's state on this phone + the "Download on-device model" button (port of the web's OnDeviceStatus). */
@Composable
fun OnDeviceStatus(session: AirlockSession, s: State) {
    val svc = session.services
    if (svc.mode == AppMode.DEMO) {
        if (svc.demoReason == DemoReason.NO_FIREBASE) Banner(Tone.WARN, stringResource(R.string.status_nofb_title), body = stringResource(R.string.status_nofb_body))
        else Banner(Tone.WARN, stringResource(R.string.status_demo_title), body = stringResource(R.string.status_demo_body))
        return
    }
    if (s.downloading) {
        val p = s.downloadProgress
        Banner(
            Tone.INFO,
            if (p != null) stringResource(R.string.status_download_title, Math.round(p * 100)) else stringResource(R.string.status_download_title_unknown),
            body = stringResource(R.string.status_download_body),
        )
        return
    }
    when (s.availability) {
        null -> Banner(Tone.INFO, stringResource(R.string.status_checking))
        PhoneAvailability.AVAILABLE -> Banner(Tone.OK, stringResource(R.string.status_ready_title), body = stringResource(R.string.status_ready_body))
        PhoneAvailability.DOWNLOADABLE, PhoneAvailability.DOWNLOADING -> Banner(
            Tone.WARN, stringResource(R.string.status_downloadable_title), body = stringResource(R.string.status_downloadable_body),
            action = {
                AirButton(
                    stringResource(R.string.status_download_button), { session.run { enableOnDevice() } },
                    kind = ButtonKind.PRIMARY, icon = AirlockIcons.Phone, compact = true,
                )
            },
        )
        else -> Banner(Tone.WARN, stringResource(R.string.status_unavailable_title), body = stringResource(R.string.status_unavailable_body))
    }
}
