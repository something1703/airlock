import AirlockCore
import AirlockRestore

/// F-27 Scrub & copy: the sealed version the user takes to any other tool, and the local restore
/// of whatever answer they paste back.
///
/// Guarantees:
/// - `clipboardText` is built only from gate-produced `SealedText`, byte-identical to what a
///   receipt would record as having left (`value` + blank line + rendered legend).
/// - `restorePasted` runs entirely on device with the conversation's own entity map.
public enum ScrubCopy {
    public static func clipboardText(_ sealed: SealedText) -> String {
        sealed.legend.isEmpty ? sealed.value : sealed.value + "\n\n" + sealed.renderedLegend
    }

    /// Puts the real details back into a pasted answer. Empty or whitespace-only input gives nil.
    public static func restorePasted(_ text: String, context: RestoreContext) -> RestoreResult? {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return Restorer.restore(text, context: context)
    }
}
