/// A JSON value restricted to what receipts need (no floating point).
public indirect enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

/// Canonical JSON for hashing (`spec/fixtures/hashchain.json`).
///
/// Guarantees — byte-identical on Swift, TypeScript (`JSON.stringify` on
/// key-sorted objects) and Kotlin, and to Python
/// `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`
/// for the values receipts use:
/// - object keys sorted by UTF-16 code units; no whitespace;
/// - strings escape only `"` `\` and U+0000–U+001F (`\b \f \n \r \t`, else `\u00xx` lowercase);
/// - integers only.
public enum CanonicalJSON {
    public static func encode(_ value: JSONValue) -> String {
        var out = ""
        write(value, to: &out)
        return out
    }

    private static func write(_ value: JSONValue, to out: inout String) {
        switch value {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .string(let s): writeString(s, to: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                write(item, to: &out)
            }
            out += "]"
        case .object(let dict):
            out += "{"
            let keys = dict.keys.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
            for (i, key) in keys.enumerated() {
                if i > 0 { out += "," }
                writeString(key, to: &out)
                out += ":"
                write(dict[key] ?? .null, to: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar.value {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x00..<0x20:
                let hex = String(scalar.value, radix: 16)
                out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
            default:
                out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}
