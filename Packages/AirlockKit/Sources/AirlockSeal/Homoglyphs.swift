/// Look-alike characters used to dodge filters ("Rаj" with a Cyrillic "а").
///
/// Guarantees: `skeleton` maps each listed Cyrillic/Greek confusable to the
/// Latin letter it imitates and leaves every other character alone; every
/// mapping is one UTF-16 unit to one unit, so spans in the skeleton equal spans
/// in the original.
enum Homoglyphs {
    static let map: [Character: Character] = [
        // Cyrillic lowercase
        "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
        "ԁ": "d", "һ": "h", "ԛ": "q", "ԝ": "w", "ӏ": "l", "ѵ": "v",
        // Cyrillic uppercase
        "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T",
        "У": "Y", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S", "Ԁ": "D", "Ԛ": "Q", "Ԝ": "W",
        // Greek
        "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "κ": "k", "υ": "u", "ε": "e",
        "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O",
        "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
    ]

    static func skeleton(_ s: String) -> String {
        String(s.map { map[$0] ?? $0 })
    }

    enum Script { case latin, cyrillic, greek, other }

    static func script(_ scalar: Unicode.Scalar) -> Script {
        switch scalar.value {
        case 0x41...0x5A, 0x61...0x7A, 0xC0...0x24F: .latin
        case 0x400...0x4FF, 0x500...0x52F: .cyrillic
        case 0x370...0x3FF: .greek
        default: .other
        }
    }

    /// UTF-16 spans of words that mix Latin with Cyrillic or Greek letters.
    static func mixedScriptWords(in text: String) -> [(start: Int, end: Int)] {
        var result: [(Int, Int)] = []
        var offset = 0
        var wordStart = 0
        var scripts: Set<Script> = []
        func close() {
            if scripts.contains(.latin) && (scripts.contains(.cyrillic) || scripts.contains(.greek)) {
                result.append((wordStart, offset))
            }
            scripts = []
        }
        for scalar in text.unicodeScalars {
            let isLetter = scalar.properties.isAlphabetic
            if isLetter {
                if scripts.isEmpty { wordStart = offset }
                let s = script(scalar)
                if s != .other { scripts.insert(s) }
            } else {
                close()
            }
            offset += scalar.utf16.count
        }
        close()
        return result
    }
}
