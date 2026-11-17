import AirlockCore
import AirlockPrompts
import Foundation

/// Names a conversation on device from its **sealed** first message (`title.v1`).
///
/// Guarantees:
/// - Input is `SealedText` only, so a title is generated from text that already passed the
///   egress gate — it can't contain a real name the gate would have caught.
/// - Runs on the phone-only engine; nothing leaves the device.
/// - The model's output is accepted only if it is short plain words with no placeholder-like
///   tokens (`clean(_:)`); otherwise `nil` and the caller keeps its rule-based title.
public struct ThreadTitler: Sendable {
    public let phone: any PhoneOnlyEngine
    public let prompts: PromptLibrary

    public init(phone: any PhoneOnlyEngine, prompts: PromptLibrary) {
        self.phone = phone
        self.prompts = prompts
    }

    public func title(for sealed: SealedText) async -> String? {
        guard await phone.availability() == .available,
            let text = try? prompts.render("title.v1", ["sealed_first_message": String(sealed.value.prefix(2_000))]),
            let out = try? await phone.respond(PhonePrompt(promptID: "title.v1", text: text), options: .analysis).text
        else { return nil }
        return Self.clean(out)
    }

    /// Port of the web `cleanTitle`: first line, quotes/markdown trimmed, ≤ 60 characters,
    /// ≤ 7 words, at least one letter, no `[[`, `_<digit>`, `ME` token or brackets.
    public static func clean(_ output: String) -> String? {
        guard var line = output.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init)
        else { return nil }
        if let r = line.range(of: #"^title:\s*"#, options: [.regularExpression, .caseInsensitive]) { line.removeSubrange(r) }
        line = line.replacingOccurrences(of: #"^["'*#\s]+"#, with: "", options: .regularExpression)
        line = line.replacingOccurrences(of: #"["'*.\s]+$"#, with: "", options: .regularExpression)
        line = line.trimmingCharacters(in: .whitespaces)
        guard !line.isEmpty, line.count <= 60 else { return nil }
        if line.range(of: #"\[\[|_\d|\bME\b|[{}<>]"#, options: .regularExpression) != nil { return nil }
        guard line.contains(where: \.isLetter) else { return nil }
        guard line.split(whereSeparator: \.isWhitespace).count <= 7 else { return nil }
        return line.prefix(1).uppercased() + line.dropFirst()
    }
}
