import AirlockCore
import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

// Design tokens — identical to web/src/ui/styles.css (docs/06-UI-UX.md §2). Colour always carries
// meaning: seal / on-device (green), cloud (blue), review (amber), risk (coral).

extension Color {
    /// A colour with explicit light and dark variants (sRGB hex).
    init(light: UInt32, dark: UInt32) {
        #if canImport(UIKit)
            self.init(
                uiColor: UIColor { traits in
                    let v = traits.userInterfaceStyle == .dark ? dark : light
                    return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
                })
        #else
            self.init(
                nsColor: NSColor(name: nil) { appearance in
                    let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                    let v = isDark ? dark : light
                    return NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
                })
        #endif
    }
}

/// Colour tokens (`--bg`, `--raised`, … in the web CSS).
enum Palette {
    static let bg = Color(light: 0xF6F7F9, dark: 0x0B111C)
    static let raised = Color(light: 0xFFFFFF, dark: 0x141C2B)
    static let text = Color(light: 0x0E1726, dark: 0xEEF2F8)
    static let text2 = Color(light: 0x4A5568, dark: 0xA3AEC2)
    static let stroke = Color(light: 0xE2E6EC, dark: 0x24304A)
    static let seal = Color(light: 0x0FA97E, dark: 0x2BD9A6)
    static let sealTint = Color(light: 0xE3F7F0, dark: 0x123A30)
    static let cloud = Color(light: 0x3366E8, dark: 0x6E97FF)
    static let cloudTint = Color(light: 0xE7EEFD, dark: 0x17264A)
    static let review = Color(light: 0xB7791F, dark: 0xFFC062)
    static let reviewTint = Color(light: 0xFDF3E2, dark: 0x3A2C12)
    static let risk = Color(light: 0xD64545, dark: 0xFF7A6E)
    static let riskTint = Color(light: 0xFBE9E9, dark: 0x3E1C1C)
    static let muted = Color(light: 0x6B7280, dark: 0xB8C0CC)
    /// Text on a filled seal button (`#04140f`).
    static let onSeal = Color(light: 0x04140F, dark: 0x04140F)
    /// Card shadow: soft in light mode only (docs/06 §2.3).
    static let shadow = Color(light: 0x0E1726, dark: 0x000000)
}

extension PrivacyCategory {
    /// Category chip tint (`--c-person`, …).
    var tint: Color {
        switch self {
        case .person: Color(light: 0x0FA97E, dark: 0x2BD9A6)
        case .org: Color(light: 0x5B5BD6, dark: 0x9C9CFF)
        case .location: Color(light: 0x0E8FA3, dark: 0x4CC9DB)
        case .contact: Color(light: 0x3366E8, dark: 0x6E97FF)
        case .id: Color(light: 0x4A5568, dark: 0xA3AEC2)
        case .date: Color(light: 0x9A6B1F, dark: 0xE2B66A)
        case .health: Color(light: 0xC2417A, dark: 0xFF8FBF)
        case .secret: Palette.risk
        case .quasi: Palette.muted
        }
    }

    var glyph: Glyph {
        switch self {
        case .person: .person
        case .org: .org
        case .location: .place
        case .contact: .contact
        case .id: .id
        case .date: .date
        case .health: .health
        case .secret: .secret
        case .quasi: .sparkle
        }
    }

    /// "Person", "Organisation", … (chip labels).
    var label: String {
        switch self {
        case .person: String(localized: "Person")
        case .org: String(localized: "Organisation")
        case .location: String(localized: "Place")
        case .contact: String(localized: "Contact")
        case .id: String(localized: "ID")
        case .date: String(localized: "Date")
        case .health: String(localized: "Health")
        case .secret: String(localized: "Secret")
        case .quasi: String(localized: "Detail")
        }
    }
}

/// Shape and spacing (docs/06 §2.3).
enum Metrics {
    static let radius: CGFloat = 20
    static let chipRadius: CGFloat = 8
    static let controlRadius: CGFloat = 12
    static let gutter: CGFloat = 16
    static let readableWidth: CGFloat = 760
}

/// The motion system (web `--ease-out`, `--ease-spring`, `--t-*`). Every use goes through
/// `Motion.animation(_:reduce:)` so Reduce Motion turns it off.
enum Motion {
    static let fast = 0.14
    static let med = 0.28
    static let slow = 0.52

    static func easeOut(_ duration: Double = slow) -> Animation { .timingCurve(0.22, 1, 0.36, 1, duration: duration) }
    static func easeIn(_ duration: Double = med) -> Animation { .timingCurve(0.55, 0, 1, 0.45, duration: duration) }
    /// Overshooting "pop" (cubic-bezier(0.34, 1.56, 0.64, 1)).
    static func pop(_ duration: Double = 0.42) -> Animation { .timingCurve(0.34, 1.56, 0.64, 1, duration: duration) }
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.8)

    /// `nil` under Reduce Motion, so state changes apply instantly.
    static func animation(_ a: Animation, reduce: Bool) -> Animation? { reduce ? nil : a }

    /// Ease-out cubic (count-up, progress curves).
    static func easeOutCubic(_ t: Double) -> Double { 1 - pow(1 - min(max(t, 0), 1), 3) }

    /// cubic-bezier(0.34, 1.56, 0.64, 1) evaluated at `t` (for hand-driven pops in renderers).
    static func popCurve(_ t: Double) -> Double {
        let t = min(max(t, 0), 1)
        // Solve x(s) = t for the bezier parameter s (Newton), then return y(s).
        func bez(_ s: Double, _ a: Double, _ b: Double) -> Double { 3 * a * s * (1 - s) * (1 - s) + 3 * b * s * s * (1 - s) + s * s * s }
        var s = t
        for _ in 0..<6 {
            let x = bez(s, 0.34, 0.64) - t
            let dx = 3 * 0.34 * (1 - s) * (1 - s) + 6 * (0.64 - 0.34) * s * (1 - s) + 3 * (1 - 0.64) * s * s
            if abs(dx) < 1e-6 { break }
            s = min(max(s - x / dx, 0), 1)
        }
        return bez(s, 1.56, 1)
    }
}

extension Font {
    static let airlockDisplay = Font.system(.largeTitle, design: .rounded).weight(.bold)
    static let airlockTitle = Font.system(.title, design: .default).weight(.bold)
    static let airlockMono = Font.footnote.monospaced()
}
