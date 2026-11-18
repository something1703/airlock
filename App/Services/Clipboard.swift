import Foundation

#if canImport(UIKit)
    import UIKit
#elseif canImport(AppKit)
    import AppKit
#endif

/// The system pasteboard (UIPasteboard / NSPasteboard). Callers decide what may be copied:
/// sealed text (Scrub & copy) or a restored answer the user asked to copy — never logged.
@MainActor
enum Clipboard {
    static func copy(_ text: String) {
        #if canImport(UIKit)
            UIPasteboard.general.string = text
        #elseif canImport(AppKit)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}
