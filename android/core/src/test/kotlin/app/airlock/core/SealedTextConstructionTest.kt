package app.airlock.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** INV-2 (port of web/tests/sealed.test.ts): only the egress gate may create a GateToken or a SealedText. */
class SealedTextConstructionTest {
    private val construction = Regex("(?<![A-Za-z0-9_])(GateToken|SealedText)\\s*\\(")
    // Comments are scanned too (stricter): write "a SealedText" in prose, never the type name followed by "(".
    private fun code(f: java.io.File): String = f.readText()

    @Test fun onlyGateKtConstructsSealedText() {
        val root = Fixtures.repoFile("android/core/src/main")
        val files = root.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue(files.size > 10, "sources not found under $root")
        val offenders = files.filter { it.name != "Gate.kt" && construction.containsMatchIn(code(it)) }.map { it.relativeTo(root).path }
        assertEquals(emptyList(), offenders)
        // The gate itself must be the one constructing it (guards against the scan silently matching nothing).
        assertTrue(construction.containsMatchIn(code(root.walkTopDown().first { it.name == "Gate.kt" })))
    }

    @Test fun sealedTextIsImmutableAndContentFree() {
        val s = EgressGate(PatternDetector(), emptyList()).sealToolResult("{\"a\":1}", EntityMap())
        assertFailsWith<UnsupportedOperationException> { (s.legend as MutableList<LegendLine>).add(LegendLine("PERSON_1", "x")) }
        assertFailsWith<UnsupportedOperationException> { (s.gateReport.counts as MutableMap<String, Int>)["person"] = 1 }
        assertTrue(!s.toString().contains("\"a\""))
    }
}
