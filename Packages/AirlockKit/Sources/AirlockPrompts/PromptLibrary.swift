import AirlockCore
import Foundation

/// Prompt loading failures (ids and variable names only — never content).
public enum PromptError: Error, Sendable, Hashable {
    case missing(id: String)
    case unfilledVariable(id: String, name: String)
}

/// Every prompt, by versioned id (`docs/04-PROMPTS.md`).
///
/// Guarantees:
/// - Bundled prompts are byte-identical to the documented ones (`PromptLibraryTests`).
/// - Remote Config `prompt_overrides_json` replaces prompts by id without a release.
/// - `render` substitutes `{{name}}` in a **single pass**: text inside a value (user content)
///   is never re-scanned, so a pasted `{{task_instruction}}` can't inject anything; any
///   placeholder left unfilled is an error, not a silent gap.
public struct PromptLibrary: Sendable {
    public static let bundledIDs: [String] = [
        "attack.v1", "attacker.v1", "claimcheck.v1", "cloud-system.v1", "cloud-user.v1", "detect-repair.v1", "detect.v1", "detect.v2",
        "gen.v1", "infer.v1", "judge.v1", "phone-system.v1", "synth.v1", "tactics.v1", "task.actions.v1", "task.custom.v1",
        "task.explain.v1", "task.help.v1", "task.questions.v1", "task.reply.v1", "task.rewrite.v1", "task.summary.v1",
        "title.v1", "tools-addendum.v1",
    ]

    private let prompts: [String: String]

    public init(overridesJSON: String = "{}") throws(PromptError) {
        var loaded: [String: String] = [:]
        for id in Self.bundledIDs {
            guard let url = Bundle.module.url(forResource: id, withExtension: "txt"),
                let text = try? String(contentsOf: url, encoding: .utf8)
            else { throw .missing(id: id) }
            loaded[id] = text.hasSuffix("\n") ? String(text.dropLast()) : text
        }
        if let data = overridesJSON.data(using: .utf8),
            let overrides = try? JSONDecoder().decode([String: String].self, from: data)
        {
            for (id, text) in overrides { loaded[id] = text }
        }
        prompts = loaded
    }

    public func template(_ id: String) throws(PromptError) -> String {
        guard let t = prompts[id] else { throw .missing(id: id) }
        return t
    }

    /// Fills `{{name}}` placeholders in one pass.
    public func render(_ id: String, _ vars: [String: String] = [:]) throws(PromptError) -> String {
        let t = try template(id)
        var out = ""
        var rest = t[...]
        while let open = rest.range(of: "{{") {
            out += rest[..<open.lowerBound]
            guard let close = rest[open.upperBound...].range(of: "}}") else {
                out += rest[open.lowerBound...]
                rest = rest[rest.endIndex...]
                break
            }
            let name = String(rest[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespaces)
            guard let value = vars[name] else { throw .unfilledVariable(id: id, name: name) }
            out += value
            rest = rest[close.upperBound...]
        }
        out += rest
        return out
    }

    /// The cloud user turn (`cloud-user.v1`) for sealed text, with replayed history.
    ///
    /// Only `SealedText` and the model's own earlier placeholder text can appear here.
    public func cloudUserTurn(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) throws(PromptError) -> String {
        let legend = sealed.legend.isEmpty ? "(none)" : sealed.renderedLegend
        let turn = try render("cloud-user.v1", ["legend_lines": legend, "task_instruction": task.instruction, "sealed_text": sealed.value])
        guard let history, !history.turns.isEmpty else { return turn }
        let earlier = history.turns.map { t -> String in
            switch t {
            case .user(let s): "User:\n<<<\n\(s.value)\n>>>"
            case .assistant(let text): "You replied:\n<<<\n\(text)\n>>>"
            }
        }.joined(separator: "\n\n")
        return "Earlier in this conversation (placeholders mean the same things):\n\n\(earlier)\n\n\(turn)"
    }
}
