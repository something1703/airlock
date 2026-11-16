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
    public let engine: any PhoneOnlyEngine
    public let prompts: PromptLibrary
    public let budgetTokens: Int

    public init(engine: any PhoneOnlyEngine, prompts: PromptLibrary, budgetTokens: Int) {
        self.engine = engine
        self.prompts = prompts
        self.budgetTokens = budgetTokens
    }

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
            prompt = PhonePrompt(promptID: "detect.v1", text: try prompts.render("detect.v1", ["chunk": chunk.text]))
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
    }

    /// Lenient: strips code fences, takes the first balanced `{…}`, ignores unknown keys.
    static func parse(_ output: String) -> [Item]? {
        guard let json = firstJSONObject(in: output), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let items = obj["items"] as? [Any]
        else { return nil }
        return items.compactMap { any in
            guard let d = any as? [String: Any], let text = d["text"] as? String, let type = d["type"] as? String,
                !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            let conf = (d["confidence"] as? String).flatMap { Confidence(rawValue: $0.lowercased()) } ?? .medium
            return Item(text: text, type: type.uppercased(), role: d["role"] as? String, sameAs: d["same_as"] as? String, confidence: conf)
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
            guard let category = Self.category(item.type) else { continue }
            var ranges = Self.occurrences(of: item.text, in: ns, options: [])
            if ranges.isEmpty { ranges = Self.occurrences(of: item.text, in: ns, options: [.caseInsensitive]) }
            guard !ranges.isEmpty else {
                report.hallucinatedDropped += 1
                continue
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
