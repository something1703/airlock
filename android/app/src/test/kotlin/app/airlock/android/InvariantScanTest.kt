package app.airlock.android

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Source scans for the app module (the Kotlin side of scripts/lint.sh). */
class InvariantScanTest {
    private val main = File(repoRoot, "android/app/src/main/kotlin")
    private fun sources() = main.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()

    @Test fun scansSomething() = assertTrue(sources().size > 15)

    /** INV-8: no println / android.util.Log anywhere in app code — content could end up in logcat. */
    @Test fun noConsoleLogging() {
        val re = Regex("(^|[^A-Za-z_.])(println|print)\\(|\\bLog\\.[vdiwe]\\(|android\\.util\\.Log")
        assertEquals(emptyList(), sources().filter { re.containsMatchIn(it.readText()) }.map { it.name })
    }

    /** INV-2: the app never constructs a sealed value (only core's EgressGate can). */
    @Test fun noSealedTextConstruction() {
        val re = Regex("(?<![A-Za-z0-9_])(GateToken|SealedText)\\s*\\(")
        assertEquals(emptyList(), sources().filter { re.containsMatchIn(it.readText()) }.map { it.name })
    }

    /** ADR-08: only the engines package talks to Firebase AI Logic. */
    @Test fun firebaseAiOnlyInEngines() {
        val offenders = sources().filter { it.readText().contains("import com.google.firebase.ai") && it.parentFile.name != "engines" }.map { it.name }
        assertEquals(emptyList(), offenders)
    }

    /** Copy rules (docs/06 §9): never promise "100% private" or "anonymous". */
    @Test fun noForbiddenClaimsInStrings() {
        val strings = File(repoRoot, "android/app/src/main/res/values/strings.xml").readText().lowercase()
        for (bad in listOf("100% private", "anonymous", "untraceable", "unhackable", "legal advice:", "diagnosis")) {
            assertTrue(!strings.contains(bad), "strings.xml must not say \"$bad\"")
        }
    }
}
