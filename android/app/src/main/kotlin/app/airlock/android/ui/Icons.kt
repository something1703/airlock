// Airlock's own icon set, generated from the SVG paths in web/src/ui/icons.tsx (24px grid, 1.8px
// round strokes) so Android and the web draw identical icons. Regenerate with the snippet in the PR if
// icons.tsx changes. No system emoji, no icon fonts.
package app.airlock.android.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp
import app.airlock.core.PrivacyCategory

private fun icon(name: String, vararg paths: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f).apply {
        for (d in paths) addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            fill = null, stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f,
            strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
        )
    }.build()

/** Tint with `Icon(tint = …)`; stroke colour is replaced by the tint. */
object AirlockIcons {
    val Ask: ImageVector by lazy { icon("Ask", "M4 18.5V6.5a2.5 2.5 0 0 1 2.5-2.5h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-5 2.5Z", "M9 9.5h6M9 12.5h3.5") }
    val Ledger: ImageVector by lazy { icon("Ledger", "M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z", "M9 8h6M9 11.5h6M9 15h3") }
    val Vault: ImageVector by lazy { icon("Vault", "M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z", "M10.2,10.5h3.6a1.2,1.2 0 0,1 1.2,1.2v2.6a1.2,1.2 0 0,1 -1.2,1.2h-3.6a1.2,1.2 0 0,1 -1.2,-1.2v-2.6a1.2,1.2 0 0,1 1.2,-1.2z", "M10.3 10.5V9a1.7 1.7 0 0 1 3.4 0v1.5") }
    val Settings: ImageVector by lazy { icon("Settings", "M4 7h9M17 7h3M4 17h3M11 17h9", "M13.0,7.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0", "M7.0,17.0a2.0,2.0 0 1,0 4.0,0a2.0,2.0 0 1,0 -4.0,0") }
    val Person: ImageVector by lazy { icon("Person", "M8.5,8.5a3.5,3.5 0 1,0 7.0,0a3.5,3.5 0 1,0 -7.0,0", "M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5") }
    val Org: ImageVector by lazy { icon("Org", "M4 20.5h16M6 20.5V5.5l7-2v17M13 8.5l5 1.5v10.5", "M9 8h1M9 11.5h1M9 15h1M16 13h.5M16 16.5h.5") }
    val Place: ImageVector by lazy { icon("Place", "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z", "M9.7,10.0a2.3,2.3 0 1,0 4.6,0a2.3,2.3 0 1,0 -4.6,0") }
    val Contact: ImageVector by lazy { icon("Contact", "M6.0,5.5h12.0a2.5,2.5 0 0,1 2.5,2.5v8.0a2.5,2.5 0 0,1 -2.5,2.5h-12.0a2.5,2.5 0 0,1 -2.5,-2.5v-8.0a2.5,2.5 0 0,1 2.5,-2.5z", "m4.5 7 7.5 5.5L19.5 7") }
    val Id: ImageVector by lazy { icon("Id", "M6.0,5.5h12.0a2.5,2.5 0 0,1 2.5,2.5v8.0a2.5,2.5 0 0,1 -2.5,2.5h-12.0a2.5,2.5 0 0,1 -2.5,-2.5v-8.0a2.5,2.5 0 0,1 2.5,-2.5z", "M9.5 9.5 8.5 15M14 9.5 13 15M7.5 11h8M7 13.5h8") }
    val Date: ImageVector by lazy { icon("Date", "M6.5,5.5h11.0a2.5,2.5 0 0,1 2.5,2.5v9.5a2.5,2.5 0 0,1 -2.5,2.5h-11.0a2.5,2.5 0 0,1 -2.5,-2.5v-9.5a2.5,2.5 0 0,1 2.5,-2.5z", "M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5") }
    val Health: ImageVector by lazy { icon("Health", "M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z", "M8 12.5h2l1.2-2 1.6 4 1.2-2h2") }
    val Secret: ImageVector by lazy { icon("Secret", "M4.5,14.0a3.5,3.5 0 1,0 7.0,0a3.5,3.5 0 1,0 -7.0,0", "m10.5 11.5 8-8M15.5 6.5l2 2M13.5 8.5l1.5 1.5") }
    val Sparkle: ImageVector by lazy { icon("Sparkle", "M12 3.5c.6 4.2 2.3 5.9 6.5 6.5-4.2.6-5.9 2.3-6.5 6.5-.6-4.2-2.3-5.9-6.5-6.5 4.2-.6 5.9-2.3 6.5-6.5Z", "M18.5 16v4M16.5 18h4") }
    val Device: ImageVector by lazy { icon("Device", "M6.0,4.5h12.0a2.0,2.0 0 0,1 2.0,2.0v7.0a2.0,2.0 0 0,1 -2.0,2.0h-12.0a2.0,2.0 0 0,1 -2.0,-2.0v-7.0a2.0,2.0 0 0,1 2.0,-2.0z", "M2.5 19.5h19M9.5 15.5l-.5 4M14.5 15.5l.5 4") }
    /** Android-only: a phone, same grid and stroke as the rest (the web's Device icon is a computer). */
    val Phone: ImageVector by lazy { icon("Phone", "M9.0,3.0h6.0a2.5,2.5 0 0,1 2.5,2.5v13.0a2.5,2.5 0 0,1 -2.5,2.5h-6.0a2.5,2.5 0 0,1 -2.5,-2.5v-13.0a2.5,2.5 0 0,1 2.5,-2.5z", "M11 17.8h2") }
    val Cloud: ImageVector by lazy { icon("Cloud", "M7 18.5a4.5 4.5 0 0 1-.4-9 6 6 0 0 1 11.3 1.6A3.8 3.8 0 0 1 17.5 18.5Z") }
    val Check: ImageVector by lazy { icon("Check", "m5 12.5 4.5 4.5L19 7.5") }
    val Shield: ImageVector by lazy { icon("Shield", "M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6Z", "m9 12 2 2 4-4") }
    val Eye: ImageVector by lazy { icon("Eye", "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z", "M9.2,12.0a2.8,2.8 0 1,0 5.6,0a2.8,2.8 0 1,0 -5.6,0") }
    val Trash: ImageVector by lazy { icon("Trash", "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5") }
    val Plus: ImageVector by lazy { icon("Plus", "M12 5v14M5 12h14") }
    val Arrow: ImageVector by lazy { icon("Arrow", "M5 12h14M13 6l6 6-6 6") }
    val Link: ImageVector by lazy { icon("Link", "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1") }
    val Alert: ImageVector by lazy { icon("Alert", "M12 4 2.8 19.5h18.4Z", "M12 10v4.5M12 17v.2") }
    val Question: ImageVector by lazy { icon("Question", "M3.5,12.0a8.5,8.5 0 1,0 17.0,0a8.5,8.5 0 1,0 -17.0,0", "M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.8v.2") }

    fun forCategory(c: PrivacyCategory): ImageVector = when (c) {
        PrivacyCategory.PERSON -> Person
        PrivacyCategory.ORG -> Org
        PrivacyCategory.LOCATION -> Place
        PrivacyCategory.CONTACT -> Contact
        PrivacyCategory.ID -> Id
        PrivacyCategory.DATE -> Date
        PrivacyCategory.HEALTH -> Health
        PrivacyCategory.SECRET -> Secret
        PrivacyCategory.QUASI -> Sparkle
    }
}
