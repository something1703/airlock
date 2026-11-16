import AirlockCore
import Foundation

/// Strict-dial money bucketing (`docs/03-PRIVACY-ENGINE.md` §2: "$1,240" → "$1,000–1,500").
///
/// Guarantees: only amounts with a currency symbol are touched; the bucket always
/// contains the original amount; the symbol is preserved.
public enum MoneyBucketer {
    public struct Hit: Sendable, Hashable {
        public let span: TextSpan
        public let bucket: String
    }

    private final class Box: @unchecked Sendable {
        let regex: NSRegularExpression?
        init() {
            regex = try? NSRegularExpression(
                pattern: #"(?<![\w.])([$€£₹])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?!\d|,\d)"#)
        }
    }

    private static let box = Box()

    public static func find(in text: String) -> [Hit] {
        guard let regex = box.regex else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            let symbol = ns.substring(with: m.range(at: 1))
            let digits = ns.substring(with: m.range(at: 2)).replacingOccurrences(of: ",", with: "")
            guard let value = Int(digits) else { return nil }
            return Hit(span: TextSpan(m.range), bucket: bucket(value, symbol: symbol))
        }
    }

    /// Half-magnitude buckets: 1,240 → 1,000–1,500; 85 → 85–90; 7 → under 10.
    public static func bucket(_ value: Int, symbol: String) -> String {
        if value < 10 { return "under \(symbol)10" }
        let digits = String(value).count
        var magnitude = 1
        for _ in 1..<digits { magnitude *= 10 }
        let step = max(1, magnitude / 2)
        let low = value / step * step
        let high = low + step
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.locale = Locale(identifier: "en_US")
        let lo = f.string(from: NSNumber(value: low)) ?? String(low)
        let hi = f.string(from: NSNumber(value: high)) ?? String(high)
        return "\(symbol)\(lo)–\(hi)"
    }
}
