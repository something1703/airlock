import Foundation

/// Where a capture came from.
public enum CaptureSource: String, Sendable, Codable, Hashable {
    case paste, photo, pdf, share, followUp, toolResult
}

/// User-provided text before sealing. **Never leaves the device** (INV-1).
///
/// Guarantees: the content is only readable inside AirlockKit (`package` access),
/// so the app target cannot hand it to a network API as a `String`. Cloud-capable
/// engines accept only `SealedText`, which this type cannot become without
/// passing the egress gate. `displayString` exists solely so the local Review
/// screen can show "You wrote"; lint forbids passing it to anything but views.
public struct RawText: Sendable, Hashable {
    package let value: String
    public let source: CaptureSource

    public init(_ value: String, source: CaptureSource) {
        self.value = value
        self.source = source
    }

    /// Local display only (Review screen "You wrote"). Never send, log or sync this.
    public var displayString: String { value }

    /// UTF-16 length, the unit used for every span in Airlock.
    public var utf16Count: Int { value.utf16.count }
}

/// A half-open range `[start, end)` in **UTF-16 code units**.
///
/// UTF-16 is used everywhere (Swift, TypeScript, Kotlin) so spans in
/// `spec/fixtures/` mean the same thing on every platform and line up with
/// `NSRange`, JavaScript string indices and Kotlin `String` indices.
public struct TextSpan: Sendable, Hashable, Codable, Comparable, CustomStringConvertible {
    public let start: Int
    public let end: Int

    public init(start: Int, end: Int) {
        precondition(start <= end, "TextSpan start must not exceed end")
        self.start = start
        self.end = end
    }

    public init(_ range: NSRange) {
        self.init(start: range.location, end: range.location + range.length)
    }

    public var length: Int { end - start }
    public var nsRange: NSRange { NSRange(location: start, length: length) }

    public func overlaps(_ other: TextSpan) -> Bool {
        start < other.end && other.start < end
    }

    public func contains(_ other: TextSpan) -> Bool {
        start <= other.start && other.end <= end
    }

    public static func < (lhs: TextSpan, rhs: TextSpan) -> Bool {
        lhs.start != rhs.start ? lhs.start < rhs.start : lhs.end < rhs.end
    }

    public var description: String { "[\(start),\(end))" }
}

extension String {
    /// Substring for a UTF-16 span. Returns `nil` if the span is out of bounds.
    public func substring(utf16 span: TextSpan) -> String? {
        let ns = self as NSString
        guard span.start >= 0, span.end <= ns.length else { return nil }
        return ns.substring(with: span.nsRange)
    }
}
