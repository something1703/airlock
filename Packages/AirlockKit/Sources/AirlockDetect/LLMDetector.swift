import AirlockCore
import AirlockPrompts
import Foundation
import NaturalLanguage

/// What the on-device detector found, and what it couldn't do.
public struct LLMDetectionReport: Sendable, Hashable {
    public var candidates: [Candidate] = []
    /// Chunk indexes the model couldn't parse even after one repair (forced review).
    public var failedChunks: [Int] = []
    /// Chunk indexes Apple's guardrails refused (forced review, highlighted).
    public var refusedChunks: [Int] = []
    /// Model "found" text that isn't in the input — dropped (local metric only).
    public var hallucinatedDropped = 0
    public var repairsUsed = 0
    /// Set if the phone model was unavailable; detection fell back to rules.
    public var unavailable: PhoneAvailability?
    public var chunkCount = 0
    /// `detect.v2`: the model's own "a large hospital" phrase for an ORG / LOCATION / HEALTH item, by
    /// `LLMDetector.generalKey`. Unchecked: the pipeline shape-checks it and the Sealer validates it before use.
    public var generals: [String: String] = [:]

    public var isComplete: Bool { failedChunks.isEmpty && refusedChunks.isEmpty && unavailable == nil }
}

/// D4 — on-device LLM entity detection (`docs/03-PRIVACY-ENGINE.md` §5.4, prompt `detect.v1`).
///
/// Guarantees:
/// - Uses only a `PhoneOnlyEngine` (INV-3).
/// - **Every returned candidate's text is an exact substring of the input at its span.**
///   Items the model invented are dropped; never trusted.
/// - Broken JSON gets exactly one `detect-repair.v1` attempt; `contextTooLong` halves the
///   chunk (at most twice); refusals and failures are reported, never silently ignored.
public struct LLMDetector: Sendable {
    public static let detectV1 = "detect.v1"
    public static let detectV2 = "detect.v2"

    public let engine: any PhoneOnlyEngine
    public let prompts: PromptLibrary
    public let budgetTokens: Int
    /// `detect.v1` (JSON, default) or `detect.v2` (one line per detail). Both replies parse either way.
    public let promptID: String
    private let masks: [Candidate]

    /// - Parameter masks: rule hits to hide from the model in a `detect.v2` prompt (`[email]`, `[phone]`, `[id]`…) so it
    ///   doesn't write them back out. Ignored for `detect.v1`, which sees the text as written.
    public init(engine: any PhoneOnlyEngine, prompts: PromptLibrary, budgetTokens: Int, promptID: String = LLMDetector.detectV1, masks: [Candidate] = []) {
        self.engine = engine
        self.prompts = prompts
        self.budgetTokens = budgetTokens
        self.promptID = promptID
        self.masks = promptID == Self.detectV2 ? masks : []
    }

    /// Key into `LLMDetectionReport.generals`.
    public static func generalKey(_ category: PrivacyCategory, _ text: String) -> String { "\(category.rawValue):\(text.lowercased())" }

    public func detect(in text: String, progress: @Sendable (_ section: Int, _ of: Int) -> Void = { _, _ in }) async -> LLMDetectionReport {
        var report = LLMDetectionReport()
        let availability = await engine.availability()
        guard availability == .available else {
            report.unavailable = availability
            return report
        }
        let chunks = Chunker.chunks(text, budgetTokens: budgetTokens)
        report.chunkCount = chunks.count
        var seen: Set<String> = []
        for chunk in chunks {
            if Task.isCancelled { break }
            progress(chunk.index + 1, chunks.count)
            let outcome = await run(chunk, fullText: text, depth: 0, report: &report)
            if case .stop = outcome { break }
            for c in outcome.candidates {
                let key = "\(c.span.start):\(c.span.end):\(c.category.rawValue)"
                if seen.insert(key).inserted { report.candidates.append(c) }
            }
        }
        report.candidates.sort { $0.span < $1.span }
        return report
    }

    enum Outcome {
        case found([Candidate])
        case stop
        var candidates: [Candidate] { if case .found(let c) = self { c } else { [] } }
    }

    private func run(_ chunk: Chunk, fullText: String, depth: Int, report: inout LLMDetectionReport) async -> Outcome {
        let prompt: PhonePrompt
        do throws(PromptError) {
            prompt = PhonePrompt(promptID: promptID, text: try prompts.render(promptID, ["chunk": Self.maskChunk(chunk, masks: masks)]))
        } catch {
            report.failedChunks.append(chunk.index)
            return .found([])
        }
        let output: String
        do throws(EngineError) {
            output = try await engine.respond(prompt, options: .analysis).text
        } catch {
            return await handle(error, chunk: chunk, fullText: fullText, depth: depth, report: &report)
        }
        if let items = Self.parse(output) { return .found(locate(items, in: chunk, report: &report)) }

        // One repair attempt, then give up on this chunk (rules + forced review cover it).
        report.repairsUsed += 1
        guard let repairText = try? prompts.render("detect-repair.v1", ["broken": output]) else {
            report.failedChunks.append(chunk.index)
            return .found([])
        }
        let repaired: String
        do throws(EngineError) {
            repaired = try await engine.respond(PhonePrompt(promptID: "detect-repair.v1", text: repairText), options: .analysis).text
        } catch {
            return await handle(error, chunk: chunk, fullText: fullText, depth: depth, report: &report)
        }
        if let items = Self.parse(repaired) { return .found(locate(items, in: chunk, report: &report)) }
        report.failedChunks.append(chunk.index)
        return .found([])
    }

    private func handle(_ error: EngineError, chunk: Chunk, fullText: String, depth: Int, report: inout LLMDetectionReport) async -> Outcome
    {
        switch error {
        case .contextTooLong where depth < 2:
            var found: [Candidate] = []
            for half in Chunker.halve(chunk, in: fullText) where half.span != chunk.span {
                let o = await run(half, fullText: fullText, depth: depth + 1, report: &report)
                if case .stop = o { return .stop }
                found += o.candidates
            }
            return .found(found)
        case .refused:
            report.refusedChunks.append(chunk.index)
            return .found([])
        case .unavailable(let a):
            report.unavailable = a
            return .stop
        case .cancelled:
            return .stop
        default:
            report.failedChunks.append(chunk.index)
            return .found([])
        }
    }

    // MARK: Parsing

    struct Item: Hashable {
        let text: String
        let type: String
        let role: String?
        let sameAs: String?
        let confidence: Confidence
        let general: String?
    }

    /// `detect.v2` reply: `TYPE | exact text | role | general`, one per line, `?TYPE` when unsure, `END` last. Returns nil
    /// when the reply holds neither a line in that form nor `END` (so it can be repaired). A bare `END` is a valid
    /// "nothing found".
    static func parseLines(_ output: String) -> [Item]? {
        var items: [Item] = []
        var sawEnd = false
        var sawLine = false
        func dash(_ f: String?) -> String? { f.flatMap { $0.isEmpty || $0 == "-" ? nil : $0 } }
        for raw in output.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacing(/^[-*•]\s+/, with: "")
            if line.isEmpty { continue }
            if line.uppercased() == "END" {
                sawEnd = true
                break
            }
            guard let m = line.wholeMatch(of: /(\??)\s*([A-Za-z_ ]+?)\s*\|(.*)/) else { continue }
            sawLine = true
            let fields = m.3.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            let text = fields.first ?? ""
            if text.isEmpty { continue }
            items.append(
                Item(
                    text: text, type: String(m.2).uppercased(), role: dash(fields.count > 1 ? fields[1] : nil), sameAs: nil,
                    confidence: m.1.isEmpty ? .high : .low, general: dash(fields.count > 2 ? fields[2] : nil)))
        }
        return sawLine || sawEnd ? items : nil
    }

    /// Lenient: strips code fences, takes the first balanced `{…}`, ignores unknown keys. Tries the v2 line form first.
    static func parse(_ output: String) -> [Item]? {
        if let lines = parseLines(output) { return lines }
        guard let json = firstJSONObject(in: output), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let items = obj["items"] as? [Any]
        else { return nil }
        return items.compactMap { any in
            guard let d = any as? [String: Any], let text = d["text"] as? String, let type = d["type"] as? String,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            let conf = (d["confidence"] as? String).flatMap { Confidence(rawValue: $0.lowercased()) } ?? .medium
            let general = (d["general"] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
            return Item(text: text, type: type.uppercased(), role: d["role"] as? String, sameAs: d["same_as"] as? String, confidence: conf, general: general)
        }
    }

    package static func firstJSONObject(in s: String) -> String? {
        let chars = Array(s.utf16)
        guard let start = chars.firstIndex(of: UInt16(UInt8(ascii: "{"))) else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        for i in start..<chars.count {
            let c = chars[i]
            if inString {
                if escaped {
                    escaped = false
                } else if c == UInt16(UInt8(ascii: "\\")) {
                    escaped = true
                } else if c == UInt16(UInt8(ascii: "\"")) {
                    inString = false
                }
                continue
            }
            switch c {
            case UInt16(UInt8(ascii: "\"")): inString = true
            case UInt16(UInt8(ascii: "{")): depth += 1
            case UInt16(UInt8(ascii: "}")):
                depth -= 1
                if depth == 0 { return String(decoding: chars[start...i], as: UTF16.self) }
            default: break
            }
        }
        return nil
    }

    static func category(_ type: String) -> PrivacyCategory? {
        switch type {
        case "PERSON", "NAME": .person
        case "ORG", "ORGANIZATION", "ORGANISATION", "COMPANY": .org
        case "LOCATION", "LOC", "PLACE", "ADDRESS": .location
        case "CONTACT", "EMAIL", "PHONE": .contact
        case "ID", "NUMBER": .id
        case "DATE", "DOB": .date
        case "HEALTH", "MEDICAL": .health
        case "SECRET", "PASSWORD": .secret
        default: nil
        }
    }

    /// Finds every occurrence of each item in the chunk (exact case first, then case-insensitive).
    private func locate(_ items: [Item], in chunk: Chunk, report: inout LLMDetectionReport) -> [Candidate] {
        let ns = chunk.text as NSString
        var out: [Candidate] = []
        for item in items {
            // A mask token ("[email]") the model echoed back is not a detail.
            let t = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.hasPrefix("["), t.hasSuffix("]"), !t.dropFirst().dropLast().contains("]") { continue }
            guard let category = Self.category(item.type) else { continue }
            var ranges = Self.occurrences(of: item.text, in: ns, options: [])
            if ranges.isEmpty { ranges = Self.occurrences(of: item.text, in: ns, options: [.caseInsensitive]) }
            guard !ranges.isEmpty else {
                report.hallucinatedDropped += 1
                continue
            }
            if let g = item.general, category == .org || category == .location || category == .health {
                let k = Self.generalKey(category, item.text)
                if report.generals[k] == nil { report.generals[k] = g }
            }
            let subtype: String? =
                switch category {
                case .location: item.text.contains(where: \.isNumber) ? "address" : "place"
                case .date: "dob"
                default: nil
                }
            for r in ranges {
                let span = TextSpan(start: chunk.span.start + r.location, end: chunk.span.start + r.location + r.length)
                out.append(
                    Candidate(
                        span: span, text: ns.substring(with: r), category: category, subtype: subtype, detector: .llm,
                        confidence: item.confidence, roleHint: item.role, sameAs: item.sameAs))
            }
        }
        return out
    }

    /// The chunk as the model sees it for `detect.v2`: contact, ID and secret hits the rules already found become `[email]`,
    /// `[phone]`, `[id]`, `[secret]`. Locating spans still uses the original chunk text. With no masks, unchanged.
    static func maskChunk(_ chunk: Chunk, masks: [Candidate]) -> String {
        let inside = masks.filter {
            ($0.category == .contact || $0.category == .id || $0.category == .secret)
                && $0.span.start >= chunk.span.start && $0.span.end <= chunk.span.end
        }
        .sorted { $0.span.start != $1.span.start ? $0.span.start < $1.span.start : $0.span.end > $1.span.end }
        if inside.isEmpty { return chunk.text }
        let ns = chunk.text as NSString
        var out = ""
        var at = chunk.span.start
        for c in inside {
            if c.span.start < at { continue }  // overlaps a mask already applied
            out += ns.substring(with: NSRange(location: at - chunk.span.start, length: c.span.start - at))
            out += Self.maskToken(c)
            at = c.span.end
        }
        return out + ns.substring(from: at - chunk.span.start)
    }

    private static func maskToken(_ c: Candidate) -> String {
        switch c.category {
        case .contact:
            switch c.subtype {
            case "email": "[email]"
            case "phone": "[phone]"
            case "url": "[link]"
            case "handle": "[handle]"
            default: "[contact]"
            }
        case .secret: "[secret]"
        default: "[id]"
        }
    }

    static func occurrences(of needle: String, in ns: NSString, options: NSString.CompareOptions) -> [NSRange] {
        var ranges: [NSRange] = []
        var start = 0
        while start < ns.length {
            let r = ns.range(of: needle, options: options, range: NSRange(location: start, length: ns.length - start))
            guard r.location != NSNotFound, r.length > 0 else { break }
            if FoldedSearch.isBoundary(ns, at: r.location - 1), FoldedSearch.isBoundary(ns, at: r.location + r.length) {
                ranges.append(r)
            }
            start = r.location + max(1, r.length)
        }
        return ranges
    }
}

/// D3 — Apple NaturalLanguage name tagger (flag `nltagger_enabled`; rule question Q-1).
///
/// Guarantees: deterministic for a given OS; `.medium` confidence; the app works fully with it off.
public enum NLDetector {
    public static func detect(in text: String) -> [Candidate] {
        let tagger = NLTagger(tagSchemes: [.nameType])
        tagger.string = text
        var out: [Candidate] = []
        let options: NLTagger.Options = [.omitPunctuation, .omitWhitespace, .joinNames]
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .word, scheme: .nameType, options: options) { tag, range in
            let category: PrivacyCategory? =
                switch tag {
                case .personalName: .person
                case .placeName: .location
                case .organizationName: .org
                default: nil
                }
            if let category {
                out.append(
                    Candidate(
                        span: TextSpan(NSRange(range, in: text)), text: String(text[range]), category: category,
                        subtype: category == .location ? "place" : nil, detector: .nl, confidence: .medium))
            }
            return true
        }
        return out
    }
}
