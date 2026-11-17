import AirlockCore
import AirlockDetect
import Foundation

/// One change the sealer made.
public struct Replacement: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable { case placeholder, generalised, blocked, bucketed, redteam }
    /// Where the original text was, in the normalised input.
    public let normalisedSpan: TextSpan
    /// Where the replacement sits in the draft.
    public let sealedSpan: TextSpan
    public let entityID: PlaceholderID?
    public let kind: Kind
}

/// A sealed draft, before the egress gate. Lives only on device.
public struct SealDraft: Sendable, Hashable {
    public let text: String
    public let legend: [LegendLine]
    public let replacements: [Replacement]
    /// Entities with their final actions and generalised phrases.
    public let entities: EntityMap
    /// Secrets that were removed — the UI warns "Never share these".
    public let secretWarnings: [PlaceholderID]
    /// Vault entries the user chose to reveal this time (gate check G1 skips these).
    public let revealedVaultIDs: Set<String>
    /// Folded values the user explicitly chose to keep (gate check G3 allows these).
    public let keptValues: Set<String>
}

extension SealDraft {
    /// Rebuilds a draft from a sealed turn saved on this device, so it can go back through
    /// `EgressGate.seal` before it is reused (e.g. as follow-up history).
    ///
    /// Guarantees: this creates only a *draft* — never `SealedText`. A stored turn is never
    /// trusted: it reaches the cloud only if it passes every gate check again against the
    /// current Vault (INV-2). `replacements` and `secretWarnings` are empty (they only drive
    /// the Review screen, which a stored turn no longer shows).
    public init(storedText text: String, legend: [LegendLine], entities: EntityMap, revealedVaultIDs: Set<String>, keptValues: Set<String>) {
        self.init(
            text: text, legend: legend, replacements: [], entities: entities, secretWarnings: [], revealedVaultIDs: revealedVaultIDs,
            keptValues: keptValues)
    }
}

/// Stage 6 — build the sealed draft and its legend (`docs/03-PRIVACY-ENGINE.md` §7).
///
/// Guarantees:
/// - Every mention whose entity is not `.keep` is replaced: placeholder/block →
///   `[[ID]]`, generalise → a validated phrase; nothing else in the text changes,
///   except Strict money bucketing.
/// - The legend has one line per placeholder present in the draft, sorted by id;
///   `PERSON_ME` is "the user"; no legend line contains a surface form or pattern
///   hit (falls back to a neutral per-category description).
public struct Sealer: Sendable {
    public let policy: PolicyEngine
    public let patterns: PatternDetector
    public let today: Date

    public init(policy: PolicyEngine, patterns: PatternDetector, today: Date = Date()) {
        self.policy = policy
        self.patterns = patterns
        self.today = today
    }

    public func draft(
        _ text: NormalisedText,
        merge: MergeResult,
        overrides: [PlaceholderID: UserOverride] = [:],
        rewrites: [PlaceholderID: String] = [:]
    ) -> SealDraft {
        var map = merge.entities
        let presentIDs = Set(merge.mentions.map(\.entityID))
        var revealed: Set<String> = []
        var kept: Set<String> = []

        // Actions and generalised phrases for entities present in this text.
        for id in presentIDs {
            guard var e = map[id] else { continue }
            let override = overrides[id]
            e.action = policy.action(for: e, override: override)
            if case .generalise(let level) = e.action {
                if let r = rewrites[id], Generaliser.validate(r, replacing: e.canonical, entities: map, patterns: patterns) {
                    e.generalisedText = r
                } else {
                    e.generalisedText = Generaliser.ladderDefault(for: e, level: level, today: today)
                }
            }
            if e.action == .keep, override != nil {
                kept.formUnion(e.surfaceForms.map(FoldedSearch.fold))
                if let vid = e.vaultEntryID, override?.revealThisTime == true { revealed.insert(vid) }
            }
            map.upsert(e)
        }

        // Edits: entity mentions, then (Strict) money buckets that don't overlap a mention.
        struct Edit {
            let span: TextSpan
            let replacement: String
            let id: PlaceholderID?
            let kind: Replacement.Kind
        }
        var edits: [Edit] = merge.mentions.compactMap { m in
            guard let e = map[m.entityID] else { return nil }
            switch e.action {
            case .keep: return nil
            case .placeholder: return Edit(span: m.span, replacement: e.id.token, id: e.id, kind: .placeholder)
            case .block: return Edit(span: m.span, replacement: e.id.token, id: e.id, kind: .blocked)
            case .generalise:
                return Edit(span: m.span, replacement: e.generalisedText ?? "something", id: e.id, kind: .generalised)
            }
        }
        if policy.bucketsMoney {
            for hit in MoneyBucketer.find(in: text.text) where !edits.contains(where: { $0.span.overlaps(hit.span) }) {
                edits.append(Edit(span: hit.span, replacement: hit.bucket, id: nil, kind: .bucketed))
            }
        }
        edits.sort { $0.span < $1.span }

        // Build left to right, recording where each replacement lands.
        let ns = text.text as NSString
        var out = ""
        var cursor = 0
        var outLen = 0
        var replacements: [Replacement] = []
        for edit in edits where edit.span.start >= cursor {
            let before = ns.substring(with: NSRange(location: cursor, length: edit.span.start - cursor))
            out += before
            outLen += before.utf16.count
            out += edit.replacement
            let len = edit.replacement.utf16.count
            replacements.append(
                Replacement(
                    normalisedSpan: edit.span, sealedSpan: TextSpan(start: outLen, end: outLen + len), entityID: edit.id,
                    kind: edit.kind))
            outLen += len
            cursor = edit.span.end
        }
        out += ns.substring(from: cursor)

        // Legend for placeholders actually present.
        let placeholderIDs = Set(replacements.filter { $0.kind == .placeholder || $0.kind == .blocked }.compactMap(\.entityID))
        let legend = placeholderIDs.sorted().compactMap { id -> LegendLine? in
            guard let e = map[id] else { return nil }
            return LegendLine(placeholder: id, description: legendDescription(for: e, map: map))
        }
        let secrets = placeholderIDs.filter { map[$0]?.action == .block }.sorted()
        return SealDraft(
            text: out, legend: legend, replacements: replacements, entities: map, secretWarnings: secrets,
            revealedVaultIDs: revealed, keptValues: kept)
    }

    // MARK: Legend

    func legendDescription(for e: Entity, map: EntityMap) -> String {
        if e.id.isMe { return "the user" }
        if e.category == .secret { return "a secret the user should not share" }
        if let hint = e.roleHint.map(Self.rewriteRole), passesMiniGate(hint, map: map) { return hint }
        return Self.generic(e.category)
    }

    /// "the writer's landlord" → "the user's landlord"; "my landlord" → "the user's landlord"; "me" → "the user".
    static func rewriteRole(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let lower = s.lowercased()
        if ["me", "myself", "self", "the writer", "writer", "i", "the user"].contains(lower) { return "the user" }
        for (prefix, replacement) in [
            ("the writer's ", "the user's "), ("the writer’s ", "the user's "), ("writer's ", "the user's "), ("my ", "the user's "),
        ]
        where lower.hasPrefix(prefix) {
            s = replacement + s.dropFirst(prefix.count)
            return s
        }
        s = s.replacingOccurrences(of: "the writer", with: "the user", options: .caseInsensitive)
        let articles = ["the ", "a ", "an ", "someone", "their "]
        if !articles.contains(where: { s.lowercased().hasPrefix($0) }) { s = "the user's " + s }
        return s
    }

    func passesMiniGate(_ hint: String, map: EntityMap) -> Bool {
        guard !hint.isEmpty, hint.split(whereSeparator: \.isWhitespace).count <= 12, !hint.contains("[[") else { return false }
        for e in map.sorted {
            for form in e.surfaceForms where form.utf16.count >= 2 && FoldedSearch.contains(form, in: hint) { return false }
        }
        return !patterns.detect(in: hint).contains { $0.category != .date }
    }

    static func generic(_ c: PrivacyCategory) -> String {
        switch c {
        case .person: "a person mentioned in the message"
        case .org: "an organisation mentioned in the message"
        case .location: "a place mentioned in the message"
        case .contact: "contact details"
        case .id: "an ID or reference number"
        case .date: "a date"
        case .health: "a health detail"
        case .secret: "a secret the user should not share"
        case .quasi: "a detail"
        }
    }
}
