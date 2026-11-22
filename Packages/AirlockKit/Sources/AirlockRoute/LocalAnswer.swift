import AirlockCore
import AirlockPrompts
import Foundation

/// FX-02: a quick task that never needs the cloud skips the seal and the Review screen. The raw message goes to the
/// phone-only engine and nowhere else (INV-3) — nothing is sent, so there is nothing to check before sending.
///
/// Guarantees: it applies only when the on-device model is available, the message fits its window, and either the task is a
/// quick one or the user chose "This device only" ("Best answer" always goes to Gemini). Any failure is thrown, never
/// swallowed, so the caller can fall back to the normal seal → Review → gate flow.
public enum LocalAnswer {
    /// Whether a request is answered on the device with no seal and no Review.
    public static func runsOnDevice(task: TaskKind, preference: AnswerPreference, availability: PhoneAvailability?, rawLength: Int) -> Bool {
        guard availability == .available, rawLength <= Router.onDeviceLimit, preference != .best else { return false }
        return preference == .phoneOnly || task.isQuick
    }

    /// An earlier exchange of the same conversation that also stayed on the device.
    public struct Exchange: Sendable, Hashable {
        public let raw: String
        public let answer: String
        public init(raw: String, answer: String) {
            self.raw = raw
            self.answer = answer
        }
    }

    public struct Result: Sendable {
        public let text: String
        public let modelVersion: String
        public let latency: Duration
    }

    /// At most this many characters of earlier exchanges go in front of a follow-up (the on-device window is small).
    static let earlierBudget = 3_000

    /// One on-device answer from the raw message (`phone-local.v1`).
    public static func run(
        phone: any PhoneOnlyEngine, prompts: PromptLibrary, task: TaskKind, raw: String, earlier: [Exchange] = []
    ) async throws(EngineError) -> Result {
        let instruction: String
        let turn: String
        do throws(PromptError) {
            instruction = try TaskCatalog(prompts: prompts).spec(task).instruction
            turn = try prompts.render("phone-local.v1", ["task_instruction": instruction, "text": raw])
        } catch {
            throw .other(code: "prompt")
        }
        var kept: [String] = []
        var used = 0
        for x in earlier.reversed() {
            let block = "User:\n<<<\n\(x.raw)\n>>>\n\nYou replied:\n<<<\n\(x.answer)\n>>>"
            if used + block.count > earlierBudget { break }
            kept.insert(block, at: 0)
            used += block.count
        }
        let text = kept.isEmpty ? turn : "Earlier in this conversation:\n\n\(kept.joined(separator: "\n\n"))\n\n\(turn)"
        let r = try await phone.respond(PhonePrompt(promptID: "phone-local.v1", text: text), options: PhoneOptions(greedy: false, permissiveGuardrails: false))
        let answer = r.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if answer.isEmpty { throw .other(code: "empty-answer") }
        return Result(text: answer, modelVersion: r.modelVersion, latency: r.latency)
    }
}
