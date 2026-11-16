import AirlockCore
import AirlockDetect
import AirlockPrompts
import Foundation

/// What a reader could still work out (attribute names match `attack.v1`).
public enum RiskAttribute: String, Sendable, Hashable, Codable, CaseIterable {
    case identity, location, employer, occupation, age, relationship, event
}

/// One Risk card: "A reader could still guess …, because of …".
public struct Risk: Sendable, Hashable, Identifiable {
    public let id: Int
    public let attribute: RiskAttribute
    /// The model's guess in plain words ("lives in a small town").
    public let guess: String
    /// The exact draft text that gives it away.
    public let evidence: String
    public let confidence: Confidence
    /// A validated rewrite, or nil (the card then offers Keep / Edit only).
    public let suggestion: String?

    public init(id: Int, attribute: RiskAttribute, guess: String, evidence: String, confidence: Confidence, suggestion: String?) {
        self.id = id
        self.attribute = attribute
        self.guess = guess
        self.evidence = evidence
        self.confidence = confidence
        self.suggestion = suggestion
    }
}

public struct RedTeamResult: Sendable {
    public let risks: [Risk]
    /// Risks whose suggestion was applied (Strict auto-apply).
    public let applied: [Risk]
    /// Rewritten in Strict; unchanged otherwise.
    public let draft: SealDraft
    public let rounds: Int
    /// Apple's model couldn't run the check (unavailable, refused, or unparseable) — forces review.
    public let unavailable: Bool
}

/// Stage 7 — the on-device red-team loop (`docs/03-PRIVACY-ENGINE.md` §8).
///
/// Guarantees:
/// - Phone-only (INV-3): the only engine in scope is a `PhoneOnlyEngine`; nothing is sent anywhere.
/// - A guess is used only if its evidence is an exact substring of the draft; the model can't
///   make us rewrite text that isn't there.
/// - A suggestion is offered only if it passes `Generaliser.validate` (no entity terms, no pattern
///   hits, ≤ 8 words) **and** keeps exactly the evidence's placeholders — never dropping or inventing one.
/// - `apply` is deterministic, skips evidence it can't find, and is idempotent.
/// - At most `maxRisksPerRound` (6) risks per round and `maxRounds` (≤ 2) rounds.
public struct RedTeam: Sendable {
    public static let maxRisksPerRound = 6

    public let phone: any PhoneOnlyEngine
    public let prompts: PromptLibrary
    public let patterns: PatternDetector

    public init(phone: any PhoneOnlyEngine, prompts: PromptLibrary, patterns: PatternDetector) {
        self.phone = phone
        self.prompts = prompts
        self.patterns = patterns
    }

    public func run(_ draft: SealDraft, mode: RedTeamMode, maxRounds: Int, taskSummary: String) async -> RedTeamResult {
        guard mode != .off, maxRounds > 0 else {
            return RedTeamResult(risks: [], applied: [], draft: draft, rounds: 0, unavailable: false)
        }
        var current = draft
        var all: [Risk] = []
        var applied: [Risk] = []
        var rounds = 0
        for round in 1...min(maxRounds, 2) {
            rounds = round
            guard let guesses = await attack(current) else {
                return RedTeamResult(risks: all, applied: applied, draft: current, rounds: rounds, unavailable: true)
            }
            let risky = Self.filter(guesses, in: current.text)
            if risky.isEmpty { break }
            var risks: [Risk] = []
            for (i, g) in risky.enumerated() {
                let suggestion = await suggest(for: g, in: current, taskSummary: taskSummary)
                risks.append(
                    Risk(
                        id: round * 100 + i, attribute: g.attribute, guess: g.guess, evidence: g.evidence, confidence: g.confidence,
                        suggestion: suggestion))
            }
            all += risks
            guard mode == .autoApply else { break }
            let good = risks.filter { $0.suggestion != nil }
            if good.isEmpty { break }
            current = Self.apply(good, to: current)
            applied += good
        }
        return RedTeamResult(risks: all, applied: applied, draft: current, rounds: rounds, unavailable: false)
    }

    // MARK: - Attack

    struct Guess: Hashable {
        let attribute: RiskAttribute
        let guess: String
        let evidence: String
        let confidence: Confidence
    }

    /// nil = the check couldn't run (unavailable / refused / unparseable).
    func attack(_ draft: SealDraft) async -> [Guess]? {
        guard let text = try? prompts.render("attack.v1", ["draft": draft.text]),
            let output = try? await phone.respond(PhonePrompt(promptID: "attack.v1", text: text), options: .analysis).text,
            let json = LLMDetector.firstJSONObject(in: output), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let list = obj["guesses"] as? [Any]
        else { return nil }
        return list.compactMap { any in
            guard let d = any as? [String: Any], let a = (d["attribute"] as? String).flatMap({ RiskAttribute(rawValue: $0.lowercased()) }),
                let evidence = d["evidence"] as? String
            else { return nil }
            let conf = (d["confidence"] as? String).flatMap { Confidence(rawValue: $0.lowercased()) } ?? .low
            return Guess(attribute: a, guess: (d["guess"] as? String) ?? "", evidence: evidence, confidence: conf)
        }
    }

    /// Keeps medium+ guesses whose evidence really is in the draft (as written there), max 6.
    static func filter(_ guesses: [Guess], in text: String) -> [Guess] {
        var seen: Set<String> = []
        let kept = guesses.compactMap { g -> Guess? in
            guard g.confidence >= .medium else { return nil }
            let stripped = maskTokens(g.evidence).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
            guard !stripped.isEmpty else { return nil }
            guard let asWritten = locate(g.evidence, in: text).first.flatMap({ text.substring(utf16: $0) }) else { return nil }
            guard seen.insert(asWritten).inserted else { return nil }
            return Guess(attribute: g.attribute, guess: g.guess, evidence: asWritten, confidence: g.confidence)
        }
        return Array(kept.sorted { $0.confidence > $1.confidence }.prefix(maxRisksPerRound))
    }

    // MARK: - Suggest

    func suggest(for g: Guess, in draft: SealDraft, taskSummary: String) async -> String? {
        let ns = draft.text as NSString
        guard let span = Self.locate(g.evidence, in: draft.text).first else { return nil }
        let from = max(0, span.start - 120)
        let to = min(ns.length, span.end + 120)
        let sentence = ns.substring(with: NSRange(location: from, length: to - from))
        guard
            let text = try? prompts.render(
                "gen.v1",
                [
                    "task_summary": taskSummary, "sentence": sentence, "phrase": g.evidence, "type": g.attribute.rawValue,
                    "level_hint": "general, not unique to one person or place",
                ]),
            let output = try? await phone.respond(PhonePrompt(promptID: "gen.v1", text: text), options: .analysis).text,
            let json = LLMDetector.firstJSONObject(in: output), let data = json.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rewrite = (obj["rewrite"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        return Self.isValid(rewrite, replacing: g.evidence, entities: draft.entities, patterns: patterns) ? rewrite : nil
    }

    /// Generaliser rules on the non-placeholder text, plus exact placeholder preservation.
    static func isValid(_ rewrite: String, replacing evidence: String, entities: EntityMap, patterns: PatternDetector) -> Bool {
        guard tokens(in: rewrite).sorted() == tokens(in: evidence).sorted() else { return false }
        let r = maskTokens(rewrite).trimmingCharacters(in: .whitespaces)
        let e = maskTokens(evidence).trimmingCharacters(in: .whitespaces)
        guard !r.isEmpty else { return false }
        return Generaliser.validate(r, replacing: e, entities: entities, patterns: patterns)
    }

    // MARK: - Apply (deterministic; used by Strict and by Review's "Use suggestion")

    public static func apply(_ risks: [Risk], to draft: SealDraft) -> SealDraft {
        var text = draft.text
        var replacements = draft.replacements
        struct Edit {
            let span: TextSpan
            let text: String
            let risk: Risk
        }
        var edits: [Edit] = []
        for risk in risks {
            guard let suggestion = risk.suggestion,
                !FoldedSearch.contains(FoldedSearch.fold(risk.evidence), in: FoldedSearch.fold(suggestion))
            else { continue }
            let tokenSpans = placeholderSpans(in: text)
            let candidate = locate(risk.evidence, in: text).first { span in
                !edits.contains { $0.span.overlaps(span) }
                    && !tokenSpans.contains { $0.overlaps(span) && !span.contains($0) }
            }
            if let span = candidate { edits.append(Edit(span: span, text: suggestion, risk: risk)) }
        }
        for edit in edits.sorted(by: { $0.span.start > $1.span.start }) {
            let ns = text as NSString
            text = ns.replacingCharacters(in: edit.span.nsRange, with: edit.text)
            let delta = edit.text.utf16.count - edit.span.length
            replacements = replacements.compactMap { r in
                if r.sealedSpan.end <= edit.span.start { return r }
                if r.sealedSpan.start >= edit.span.end {
                    return Replacement(
                        normalisedSpan: r.normalisedSpan,
                        sealedSpan: TextSpan(start: r.sealedSpan.start + delta, end: r.sealedSpan.end + delta), entityID: r.entityID,
                        kind: r.kind)
                }
                return nil  // inside the rewritten phrase
            }
            replacements.append(
                Replacement(
                    normalisedSpan: TextSpan(start: 0, end: 0),
                    sealedSpan: TextSpan(start: edit.span.start, end: edit.span.start + edit.text.utf16.count),
                    entityID: nil, kind: .redteam))
        }
        replacements.sort { $0.sealedSpan < $1.sealedSpan }
        return SealDraft(
            text: text, legend: draft.legend, replacements: replacements, entities: draft.entities, secretWarnings: draft.secretWarnings,
            revealedVaultIDs: draft.revealedVaultIDs, keptValues: draft.keptValues)
    }

    // MARK: - Helpers

    private final class Box: @unchecked Sendable {
        let token = try? NSRegularExpression(pattern: #"\[\[[A-Z]+_(?:[0-9]+|ME)\]\]"#)
    }
    private static let box = Box()

    static func placeholderSpans(in text: String) -> [TextSpan] {
        guard let re = box.token else { return [] }
        return re.matches(in: text, range: NSRange(location: 0, length: (text as NSString).length)).map { TextSpan($0.range) }
    }

    static func tokens(in text: String) -> [String] {
        placeholderSpans(in: text).compactMap { text.substring(utf16: $0) }
    }

    static func maskTokens(_ text: String) -> String {
        let ns = NSMutableString(string: text)
        for span in placeholderSpans(in: text).reversed() { ns.replaceCharacters(in: span.nsRange, with: " ") }
        return (ns as String).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Word-bounded occurrences: exact case first, then case-insensitive.
    static func locate(_ needle: String, in text: String) -> [TextSpan] {
        let ns = text as NSString
        let trimmed = needle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        for options: NSString.CompareOptions in [[], [.caseInsensitive]] {
            var found: [TextSpan] = []
            var start = 0
            while start < ns.length {
                let r = ns.range(of: trimmed, options: options, range: NSRange(location: start, length: ns.length - start))
                guard r.location != NSNotFound, r.length > 0 else { break }
                if FoldedSearch.isBoundary(ns, at: r.location - 1) || !isWordChar(trimmed.first),
                    FoldedSearch.isBoundary(ns, at: r.location + r.length) || !isWordChar(trimmed.last)
                {
                    found.append(TextSpan(r))
                }
                start = r.location + r.length
            }
            if !found.isEmpty { return found }
        }
        return []
    }

    private static func isWordChar(_ c: Character?) -> Bool {
        guard let c else { return false }
        return c.isLetter || c.isNumber
    }
}
