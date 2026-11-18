package app.airlock.android.ui.screens

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.airlock.android.LocalAirlock
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
import app.airlock.android.ui.reduceMotion
import app.airlock.core.PhoneAvailability

/**
 * Gemini Nano's state on this phone (port of the web's OnDeviceStatus): ready, checking, a one-time download with a
 * progress bar, a failed download with Retry, or not supported. The download only ever starts from a button tap.
 */
@Composable
fun OnDeviceStatus(session: AirlockSession, s: State) {
    val svc = session.services
    if (svc.mode == AppMode.DEMO) {
        if (svc.demoReason == DemoReason.NO_FIREBASE) Banner(Tone.WARN, stringResource(R.string.status_nofb_title), body = stringResource(R.string.status_nofb_body))
        else Banner(Tone.WARN, stringResource(R.string.status_demo_title), body = stringResource(R.string.status_demo_body))
        return
    }
    val start = { session.run { enableOnDevice() }; Unit }
    if (s.downloading) {
        val p = s.downloadProgress
        Banner(
            Tone.INFO,
            if (p != null) stringResource(R.string.status_download_title, Math.round(p * 100)) else stringResource(R.string.status_download_title_unknown),
            body = stringResource(R.string.status_download_body),
            action = { DownloadBar(p) },
        )
        return
    }
    if (s.downloadFailed && s.availability != PhoneAvailability.AVAILABLE) {
        Banner(
            Tone.RISK, stringResource(R.string.status_download_failed_title), body = stringResource(R.string.status_download_failed_body),
            action = { AirButton(stringResource(R.string.status_download_retry), start, kind = ButtonKind.PRIMARY, icon = AirlockIcons.Phone, compact = true) },
        )
        return
    }
    when (s.availability) {
        null -> Banner(Tone.INFO, stringResource(R.string.status_checking))
        PhoneAvailability.AVAILABLE -> Banner(Tone.OK, stringResource(R.string.status_ready_title), body = stringResource(R.string.status_ready_body))
        // The system may already be fetching it (another app asked); joining the download shows its progress.
        PhoneAvailability.DOWNLOADING -> Banner(
            Tone.INFO, stringResource(R.string.status_downloading_title), body = stringResource(R.string.status_downloadable_body),
            action = { AirButton(stringResource(R.string.status_download_show), start, icon = AirlockIcons.Phone, compact = true) },
        )
        PhoneAvailability.DOWNLOADABLE -> Banner(
            Tone.WARN, stringResource(R.string.status_downloadable_title), body = stringResource(R.string.status_downloadable_body),
            action = { AirButton(stringResource(R.string.status_download_button), start, kind = ButtonKind.PRIMARY, icon = AirlockIcons.Phone, compact = true) },
        )
        else -> Banner(Tone.WARN, stringResource(R.string.status_unavailable_title), body = stringResource(R.string.status_unavailable_body))
    }
}

/** Thin progress bar: determinate when the size is known, otherwise a sliding segment (still with reduced motion). */
@Composable
private fun DownloadBar(fraction: Float?) {
    val c = LocalAirlock.current
    val still = reduceMotion()
    val a11y = stringResource(R.string.status_download_a11y)
    val shown by animateFloatAsState(fraction ?: 0f, tween(if (still) 0 else 300), label = "download")
    val slide = if (fraction == null && !still) {
        rememberInfiniteTransition(label = "indeterminate").animateFloat(0f, 1f, infiniteRepeatable(tween(1300, easing = LinearEasing)), label = "slide").value
    } else 0f
    Box(
        Modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(CircleShape)
            .background(c.stroke)
            .semantics {
                contentDescription = a11y
                progressBarRangeInfo = if (fraction != null) ProgressBarRangeInfo(fraction, 0f..1f) else ProgressBarRangeInfo.Indeterminate
            }
            .drawBehind {
                val r = CornerRadius(size.height / 2)
                if (fraction != null) {
                    drawRoundRect(c.cloud, size = Size(size.width * shown, size.height), cornerRadius = r)
                } else {
                    val w = size.width * 0.3f
                    val x = if (still) (size.width - w) / 2 else -w + (size.width + w) * slide
                    drawRoundRect(c.cloud, topLeft = Offset(x, 0f), size = Size(w, size.height), cornerRadius = r)
                }
            },
    )
}
