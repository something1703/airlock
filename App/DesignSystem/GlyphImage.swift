import SwiftUI

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// Template images of our glyphs for places that only take an `Image` (the iPhone tab bar).
@MainActor
enum GlyphImage {
    private static var cache: [Glyph: Image] = [:]

    static func image(_ glyph: Glyph, size: CGFloat = 24) -> Image {
        if let cached = cache[glyph] { return cached }
        let path = glyph.path(in: CGRect(x: 0, y: 0, width: size, height: size)).cgPath
        let style = Glyph.stroke(for: size)
        #if canImport(UIKit)
            let img = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { ctx in
                let c = ctx.cgContext
                c.addPath(path)
                c.setLineWidth(style.lineWidth)
                c.setLineCap(.round)
                c.setLineJoin(.round)
                c.setStrokeColor(UIColor.black.cgColor)
                c.strokePath()
            }
            let out = Image(uiImage: img.withRenderingMode(.alwaysTemplate))
        #else
            let img = NSImage(size: CGSize(width: size, height: size), flipped: true) { _ in
                guard let c = NSGraphicsContext.current?.cgContext else { return false }
                c.addPath(path)
                c.setLineWidth(style.lineWidth)
                c.setLineCap(.round)
                c.setLineJoin(.round)
                c.setStrokeColor(NSColor.black.cgColor)
                c.strokePath()
                return true
            }
            img.isTemplate = true
            let out = Image(nsImage: img)
        #endif
        cache[glyph] = out
        return out
    }
}
