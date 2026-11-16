import AirlockCore
import Foundation

/// One place in the (normalised) text where an entity is mentioned.
public struct Mention: Sendable, Hashable {
    public let span: TextSpan
    public let entityID: PlaceholderID
    public let text: String
}

/// Two entities the merger couldn't tell apart ("Sam" vs "Sam Lee" / "Sam Ortiz").
/// The Review screen shows a "Same person?" control for each pair.
public struct Ambiguity: Sendable, Hashable {
    public let entity: PlaceholderID
    public let possiblySameAs: PlaceholderID
}

/// Output of stage 4 (merge + coreference).
public struct MergeResult: Sendable {
    /// The thread's entity map: previous entities plus new or updated ones.
    public let entities: EntityMap
    /// Mentions in this text, sorted by position, never overlapping.
    public let mentions: [Mention]
    public let ambiguous: [Ambiguity]
}

/// Stage 4 — merge overlapping detections and cluster mentions into entities
/// (`docs/03-PRIVACY-ENGINE.md` §6).
///
/// Guarantees:
/// - Output mentions never overlap. On overlap the higher-priority detector wins
///   (`user > vault > pattern > llm > nl`), then the longer span, then the
///   higher-priority category.
/// - **Containment extension:** when a losing span strictly contains a single
///   winner of the same category, the winner grows to cover it (vault "Raj"
///   inside LLM "Raj Patel" seals the whole name).
/// - **Losers are never forgotten:** a dropped candidate's text becomes a surface
///   form of the same-category entity that beat it, so the gate still blocks it.
/// - Coreference: exact folded match, LLM `same_as`, same Vault entry, or token
///   subset with exactly one candidate superset. A short form with several
///   possible supersets stays separate, at `.medium` confidence, and is reported in
///   `ambiguous`.
/// - IDs: the Vault user is `PERSON_ME`; entities already in `existing` keep their
///   id (stable across follow-ups); new ones are numbered by first appearance.
public enum Merger {
    public static func merge(
        _ candidates: [Candidate],
        in text: String,
        existing: EntityMap = EntityMap(),
        vault: [VaultEntry] = []
    ) -> MergeResult {
        let accepted = resolveOverlaps(candidates.filter { $0.category != .quasi }, in: text)
        let clusters = cluster(accepted, vault: vault)
        return assignIDs(clusters, existing: existing, vault: vault)
    }

    // MARK: - Overlap resolution

    struct Accepted {
        var span: TextSpan
        var text: String
        let category: PrivacyCategory
        let subtype: String?
        let detector: DetectorID
        var confidence: Confidence
        let roleHint: String?
        let sameAs: String?
        let vaultEntryID: String?
        var extraForms: Set<String> = []
    }

    static func resolveOverlaps(_ candidates: [Candidate], in text: String) -> [Accepted] {
        let ordered = candidates.sorted {
            if $0.detector.priority != $1.detector.priority { return $0.detector.priority < $1.detector.priority }
            if $0.span.length != $1.span.length { return $0.span.length > $1.span.length }
            if $0.category.priority != $1.category.priority { return $0.category.priority < $1.category.priority }
            return $0.span < $1.span
        }
        var kept: [Accepted] = []
        for c in ordered {
            let overlapping = kept.indices.filter { kept[$0].span.overlaps(c.span) }
            if overlapping.isEmpty {
                kept.append(
                    Accepted(
                        span: c.span, text: c.text, category: c.category, subtype: c.subtype, detector: c.detector,
                        confidence: c.confidence, roleHint: c.roleHint, sameAs: c.sameAs, vaultEntryID: c.vaultEntryID))
                continue
            }
            if overlapping.count == 1, case let i = overlapping[0], kept[i].category == c.category, c.span.contains(kept[i].span),
                c.span != kept[i].span, let grown = text.substring(utf16: c.span)
            {
                kept[i].extraForms.insert(kept[i].text)
                kept[i].extraForms.insert(c.text)
                kept[i].span = c.span
                kept[i].text = grown
                kept[i].confidence = max(kept[i].confidence, c.confidence)
                continue
            }
            if let i = overlapping.first(where: { kept[$0].category == c.category }) {
                kept[i].extraForms.insert(c.text)
            }
        }
        return kept.sorted { $0.span < $1.span }
    }

    // MARK: - Clustering

    struct Cluster {
        let category: PrivacyCategory
        var keys: Set<String>
        var tokens: Set<String>
        var mentions: [Accepted]
        var vaultEntryID: String?
        var ambiguousWith: [Int] = []

        var firstStart: Int { mentions.map(\.span.start).min() ?? 0 }
    }

    static let titles: Set<String> = ["dr", "mr", "mrs", "ms", "mx", "miss", "prof", "sir", "madam", "dame"]
    static let nameCategories: Set<PrivacyCategory> = [.person, .org]

    /// Comparison key: folded, possessive and titles stripped; IDs and phones compare without separators.
    static func key(_ text: String, _ category: PrivacyCategory) -> String {
        var s = FoldedSearch.fold(text).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        for suffix in ["'s", "s'"] where s.hasSuffix(suffix) && s.count > suffix.count + 1 {
            s = String(s.dropLast(suffix == "'s" ? 2 : 1))
        }
        switch category {
        case .person, .org, .location, .health, .quasi:
            var words = s.split(whereSeparator: \.isWhitespace).map {
                $0.trimmingCharacters(in: CharacterSet(charactersIn: ".,"))
            }
            if category == .person { while let f = words.first, titles.contains(f), words.count > 1 { words.removeFirst() } }
            return words.joined(separator: " ")
        case .id, .contact, .secret:
            // Emails and URLs compare as written; numbers compare without separators.
            if s.contains("@") || s.contains("/") { return s }
            return s.filter { !$0.isWhitespace && !"-().".contains($0) }
        case .date:
            return s
        }
    }

    static func tokens(_ key: String) -> Set<String> {
        Set(key.split(separator: " ").map(String.init).filter { $0.count >= 2 && !titles.contains($0) })
    }

    static func cluster(_ accepted: [Accepted], vault: [VaultEntry]) -> [Cluster] {
        var clusters: [Cluster] = []
        // Longest names first so short forms ("Sam", "Patel") see every possible superset.
        let order = accepted.indices.sorted {
            let a = tokens(key(accepted[$0].text, accepted[$0].category)).count
            let b = tokens(key(accepted[$1].text, accepted[$1].category)).count
            return a != b ? a > b : accepted[$0].span < accepted[$1].span
        }
        for i in order {
            let m = accepted[i]
            let k = key(m.text, m.category)
            let t = tokens(k)

            // 1. Same Vault entry.
            if let vid = m.vaultEntryID {
                if let c = clusters.firstIndex(where: { $0.vaultEntryID == vid }) {
                    clusters[c].mentions.append(m)
                    clusters[c].keys.insert(k)
                } else {
                    var keys: Set<String> = [k]
                    var toks = t
                    if let entry = vault.first(where: { $0.id == vid }) {
                        for term in entry.allTerms {
                            let tk = key(term, m.category)
                            keys.insert(tk)
                            toks.formUnion(tokens(tk))
                        }
                    }
                    clusters.append(Cluster(category: m.category, keys: keys, tokens: toks, mentions: [m], vaultEntryID: vid))
                }
                continue
            }
            // 2. Exact key.
            if let c = clusters.firstIndex(where: { $0.category == m.category && $0.keys.contains(k) }) {
                clusters[c].mentions.append(m)
                continue
            }
            // 3. LLM same_as.
            if let sameAs = m.sameAs.map({ key($0, m.category) }),
                let c = clusters.firstIndex(where: { $0.category == m.category && $0.keys.contains(sameAs) })
            {
                clusters[c].mentions.append(m)
                clusters[c].keys.insert(k)
                clusters[c].tokens.formUnion(t)
                continue
            }
            // 4. Token subset (people and organisations).
            if nameCategories.contains(m.category), !t.isEmpty {
                let supersets = clusters.indices.filter { clusters[$0].category == m.category && t.isSubset(of: clusters[$0].tokens) }
                if supersets.count == 1 {
                    clusters[supersets[0]].mentions.append(m)
                    clusters[supersets[0]].keys.insert(k)
                    continue
                }
                if supersets.count > 1 {
                    var amb = m
                    amb.confidence = .medium
                    clusters.append(Cluster(category: m.category, keys: [k], tokens: t, mentions: [amb], ambiguousWith: supersets))
                    continue
                }
            }
            clusters.append(Cluster(category: m.category, keys: [k], tokens: t, mentions: [m]))
        }
        return clusters
    }

    // MARK: - IDs and entities

    static func assignIDs(_ clusters: [Cluster], existing: EntityMap, vault: [VaultEntry]) -> MergeResult {
        var map = existing
        var mentions: [Mention] = []
        var idByCluster: [Int: PlaceholderID] = [:]
        let order = clusters.indices.sorted { clusters[$0].firstStart < clusters[$1].firstStart }

        for ci in order {
            let c = clusters[ci]
            let entry = c.vaultEntryID.flatMap { vid in vault.first { $0.id == vid } }
            var forms = Set(c.mentions.flatMap { [$0.text, stripPossessive($0.text)] + $0.extraForms })
            if let entry { forms.formUnion(entry.allTerms) }
            forms = forms.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }

            let canonical =
                entry?.canonical
                ?? c.mentions.map { stripPossessive($0.text) }.max {
                    let a = tokens(key($0, c.category)).count
                    let b = tokens(key($1, c.category)).count
                    return a != b ? a < b : $0.utf16.count < $1.utf16.count
                } ?? ""
            let best = c.mentions.min { $0.detector.priority < $1.detector.priority }
            let role = entry.map { $0.isUser ? "the user" : $0.roleHint } ?? c.mentions.compactMap(\.roleHint).first
            let confidence = c.ambiguousWith.isEmpty ? (c.mentions.map(\.confidence).max() ?? .low) : .medium

            // Reuse an existing entity when any surface form matches (stable ids across follow-ups).
            let foldedForms = Set(forms.map { key($0, c.category) })
            let reuse = map.sorted.first { e in
                e.category == c.category
                    && (e.vaultEntryID != nil && e.vaultEntryID == c.vaultEntryID
                        || !foldedForms.isDisjoint(with: e.surfaceForms.map { key($0, c.category) }))
            }
            let id: PlaceholderID
            if var e = reuse {
                id = e.id
                e.surfaceForms.formUnion(forms)
                e.sources.formUnion(c.mentions.map(\.detector))
                e.confidence = max(e.confidence, confidence)
                if e.roleHint == nil { e.roleHint = role }
                map.upsert(e)
            } else {
                id = entry?.isUser == true ? .me : map.nextID(for: c.category)
                map.upsert(
                    Entity(
                        id: id, category: c.category, canonical: canonical, surfaceForms: forms, roleHint: role,
                        sources: Set(c.mentions.map(\.detector)), confidence: confidence, subtype: best?.subtype,
                        vaultEntryID: c.vaultEntryID))
            }
            idByCluster[ci] = id
            mentions += c.mentions.map { Mention(span: $0.span, entityID: id, text: $0.text) }
        }

        var ambiguous: [Ambiguity] = []
        for (ci, c) in clusters.enumerated() {
            guard let id = idByCluster[ci] else { continue }
            for other in c.ambiguousWith { if let o = idByCluster[other] { ambiguous.append(Ambiguity(entity: id, possiblySameAs: o)) } }
        }
        return MergeResult(entities: map, mentions: mentions.sorted { $0.span < $1.span }, ambiguous: ambiguous)
    }

    static func stripPossessive(_ s: String) -> String {
        for suffix in ["'s", "’s"] where s.hasSuffix(suffix) && s.count > 3 { return String(s.dropLast(2)) }
        return s
    }
}
