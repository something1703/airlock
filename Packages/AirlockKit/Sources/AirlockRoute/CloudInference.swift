import AirlockCore
import AirlockLedger
import AirlockPrompts
import Foundation

/// One thing the cloud model says it can infer about the writer from sealed text (F-25).
public struct Inference: Sendable, Hashable {
    public let attribute: String
    public let value: String
    public let confidence: Confidence
    /// The words in the sealed text that suggest it (may contain placeholders).
    public let evidence: String

    public init(attribute: String, value: String, confidence: Confidence, evidence: String) {
        self.attribute = attribute
        self.value = value
        self.confidence = confidence
        self.evidence = evidence
    }
}

/// The parsed reply plus the receipt for the request.
public struct InferenceResult: Sendable {
    public let inferences: [Inference]
    public let modelVersion: String
    public let receipt: Receipt
    /// The model's reply could not be read as the expected JSON.
    public let unreadable: Bool
}

/// F-25 "What could Gemini still guess?" — the native port of `web/src/engine/infer.ts`.
///
/// Guarantees:
/// - Only the `SealedText` that already left is sent again, on the `cloudOnly` route (INV-1), so
///   the outbound hash equals the original request's.
/// - A receipt is written for every request (it left the device), including a Model Armor block.
/// - The instruction is the versioned `infer.v1` prompt minus its quoted-message block: the cloud
///   user turn (`cloud-user.v1`) already carries the sealed text and its legend.
/// - Parsing is lenient about wrappers and strict about shape: at most 8 items, sorted by
///   confidence (high first), and a value that is only a placeholder is dropped.
public enum CloudInference {
    public static let promptID = "infer.v1"
    public static let maxItems = 8

    public static func task(prompts: PromptLibrary) throws(PromptError) -> TaskSpec {
        let full = try prompts.render(promptID, ["sealed_text": ""])
        let instruction: Substring
        if let close = full.range(of: ">>>", options: .backwards) {
            instruction = full[close.upperBound...]
        } else {
            instruction = full[...]
        }
        return TaskSpec(id: promptID, instruction: instruction.trimmingCharacters(in: .whitespacesAndNewlines), maxOutputTokens: 700)
    }

    public static func parse(_ text: String) -> (inferences: [Inference], unreadable: Bool) {
        guard let json = firstJSONObject(in: text), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let raw = obj["inferences"] as? [Any]
        else { return ([], true) }
        var out: [Inference] = []
        for item in raw {
            guard let r = item as? [String: Any] else { continue }
            let attribute = (r["attribute"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let value = (r["value"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !attribute.isEmpty, !value.isEmpty, attribute.count <= 40, value.count <= 160 else { continue }
            let confidence = (r["confidence"] as? String).flatMap { Confidence(rawValue: $0.lowercased()) } ?? .low
            let evidence = String(((r["evidence"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").prefix(200))
            // The prompt forbids guessing names; a value that is just a placeholder adds nothing.
            if value.replacingOccurrences(of: #"\[\[[A-Z]+_(?:\d+|ME)\]\]"#, with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            {
                continue
            }
            out.append(Inference(attribute: attribute, value: value, confidence: confidence, evidence: evidence))
        }
        // Stable: equal confidences keep the model's order.
        let ranked = out.enumerated().sorted { a, b in
            a.element.confidence != b.element.confidence ? a.element.confidence > b.element.confidence : a.offset < b.offset
        }
        return (Array(ranked.map(\.element).prefix(maxItems)), false)
    }

    /// Sends `sealed` again (cloudOnly) with `infer.v1` and appends a receipt to `ledger`.
    public static func run(
        engines: any EngineProvider, prompts: PromptLibrary, ledger: ReceiptLedger, sealed: SealedText, threadId: String,
        armorExpected: Bool = false
    ) async throws(EngineError) -> InferenceResult {
        let spec: TaskSpec
        do { spec = try task(prompts: prompts) } catch { throw .other(code: "prompt") }
        let clock = ContinuousClock()
        let start = clock.now
        let result: EngineResult
        do {
            result = try await engines.sealed(route: .cloudOnly, quality: .auto).respond(sealed, task: spec, history: nil)
        } catch {
            if error == .armorBlocked {
                await ledger.append(
                    sealed: sealed, threadId: threadId, route: .cloudOnly, modelVersion: "blocked", armor: .blocked, sealLatency: .zero,
                    networkLatency: clock.now - start)
            }
            throw error
        }
        let receipt = await ledger.append(
            sealed: sealed, threadId: threadId, route: .cloudOnly, modelVersion: result.modelVersion,
            armor: armorExpected ? .pass : .notConfigured, sealLatency: .zero, networkLatency: clock.now - start)
        let parsed = parse(result.text)
        return InferenceResult(
            inferences: parsed.inferences, modelVersion: result.modelVersion, receipt: receipt, unreadable: parsed.unreadable)
    }

    /// The first balanced `{…}` in `s`, skipping braces inside JSON strings.
    static func firstJSONObject(in s: String) -> String? {
        let chars = Array(s.utf16)
        let open = UInt16(UInt8(ascii: "{")), close = UInt16(UInt8(ascii: "}"))
        let quote = UInt16(UInt8(ascii: "\"")), backslash = UInt16(UInt8(ascii: "\\"))
        guard let start = chars.firstIndex(of: open) else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        for i in start..<chars.count {
            let c = chars[i]
            if inString {
                if escaped {
                    escaped = false
                } else if c == backslash {
                    escaped = true
                } else if c == quote {
                    inString = false
                }
                continue
            }
            if c == quote {
                inString = true
            } else if c == open {
                depth += 1
            } else if c == close {
                depth -= 1
                if depth == 0 { return String(decoding: chars[start...i], as: UTF16.self) }
            }
        }
        return nil
    }
}
