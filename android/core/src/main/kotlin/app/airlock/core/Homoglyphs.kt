package app.airlock.core

/** Look-alike characters used to dodge filters ("Rаj" with a Cyrillic "а") — port of homoglyphs.ts / Homoglyphs.swift. */
object Homoglyphs {
    private val MAP: Map<Char, Char> = listOf(
        'а' to 'a', 'е' to 'e', 'о' to 'o', 'р' to 'p', 'с' to 'c', 'у' to 'y', 'х' to 'x', 'і' to 'i', 'ј' to 'j', 'ѕ' to 's', 'ԁ' to 'd',
        'һ' to 'h', 'ԛ' to 'q', 'ԝ' to 'w', 'ӏ' to 'l', 'ѵ' to 'v',
        'А' to 'A', 'В' to 'B', 'Е' to 'E', 'К' to 'K', 'М' to 'M', 'Н' to 'H', 'О' to 'O', 'Р' to 'P', 'С' to 'C', 'Т' to 'T', 'У' to 'Y',
        'Х' to 'X', 'І' to 'I', 'Ј' to 'J', 'Ѕ' to 'S', 'Ԁ' to 'D', 'Ԛ' to 'Q', 'Ԝ' to 'W',
        'α' to 'a', 'ο' to 'o', 'ρ' to 'p', 'ν' to 'v', 'ι' to 'i', 'κ' to 'k', 'υ' to 'u', 'ε' to 'e',
        'Α' to 'A', 'Β' to 'B', 'Ε' to 'E', 'Ζ' to 'Z', 'Η' to 'H', 'Ι' to 'I', 'Κ' to 'K', 'Μ' to 'M', 'Ν' to 'N', 'Ο' to 'O', 'Ρ' to 'P',
        'Τ' to 'T', 'Υ' to 'Y', 'Χ' to 'X',
    ).toMap()

    /** Each listed confusable → the Latin letter it imitates; every mapping is one UTF-16 unit to one unit, so spans carry over. */
    fun skeleton(s: String): String {
        val sb = StringBuilder(s.length)
        for (c in s) sb.append(MAP[c] ?: c)
        return sb.toString()
    }

    private enum class Script { LATIN, CYRILLIC, GREEK, OTHER }

    private fun script(cp: Int): Script = when {
        cp in 0x41..0x5a || cp in 0x61..0x7a || cp in 0xc0..0x24f -> Script.LATIN
        cp in 0x400..0x52f -> Script.CYRILLIC
        cp in 0x370..0x3ff -> Script.GREEK
        else -> Script.OTHER
    }

    /** UTF-16 spans of words that mix Latin with Cyrillic or Greek letters. */
    fun mixedScriptWords(text: String): List<TextSpan> {
        val result = ArrayList<TextSpan>()
        var offset = 0
        var wordStart = 0
        var scripts = HashSet<Script>()
        fun close() {
            if (Script.LATIN in scripts && (Script.CYRILLIC in scripts || Script.GREEK in scripts)) result.add(TextSpan(wordStart, offset))
            scripts = HashSet()
        }
        while (offset < text.length) {
            val cp = text.codePointAt(offset)
            if (Character.isAlphabetic(cp)) {
                if (scripts.isEmpty()) wordStart = offset
                val s = script(cp)
                if (s != Script.OTHER) scripts.add(s)
            } else close()
            offset += Character.charCount(cp)
        }
        close()
        return result
    }
}
