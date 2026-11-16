@_spi(EgressGate) import AirlockCore
import AirlockDetect
import AirlockRestore
import Foundation

/// Limits enforced by check G7.
public struct GateLimits: Sendable, Hashable {
    /// Max UTF-16 length of text + legend (matches the Firestore `looksSealed` rule).
    public var maxUTF16: Int

    public init(maxUTF16: Int = 40_000) {
        self.maxUTF16 = maxUTF16
    }
}

/// Why the gate blocked. Carries **no** matched values (INV-8) — only the check,
/// the category, and where in the draft or legend to highlight.
public struct GateHit: Sendable, Hashable {
    public let check: GateCheck
    public let category: PrivacyCategory?
    /// Span in the draft text, or in the legend line's description when `legendIndex` is set.
    public let span: TextSpan?
    public let legendIndex: Int?
}

public struct GateBlocked: Error, Sendable, Hashable {
    public let hits: [GateHit]
    public var checks: Set<GateCheck> { Set(hits.map(\.check)) }
}

/// Stage 9 — the egress gate (`docs/03-PRIVACY-ENGINE.md` §9). **The only constructor of `SealedText`** (INV-2).
///
/// Guarantees: deterministic; all of G1–G7 must pass or nothing is produced.
/// - G6 draft and legend are already normalised (no zero-width/invisible characters,
///   NFKC-stable) and no word mixes Latin with Cyrillic/Greek letters.
/// - G1 no Vault name or alias (except entries revealed this time) — checked on the
///   text and on its homoglyph skeleton.
/// - G2 no surface form of any entity that must not leave (placeholder, block,
///   generalise); plus person-name tokens (≥ 3 letters, case-sensitive, excluding
///   common words) — text and skeleton.
/// - G3 no contact / ID / secret / street-address pattern hit, except values the
///   user explicitly chose to keep.
/// - G4 every placeholder is canonical and explained by the legend.
/// - G5 legend lines contain no surface forms, Vault terms or pattern hits.
/// - G7 size within limits.
/// The same checks run on tool results (INV-5) via `sealToolResult`.
public struct EgressGate: Sendable {
    public let patterns: PatternDetector
    public let vault: [VaultEntry]
    public let limits: GateLimits

    public init(patterns: PatternDetector, vault: [VaultEntry], limits: GateLimits = GateLimits()) {
        self.patterns = patterns
        self.vault = vault
        self.limits = limits
    }

    /// Seals a draft for a model call.
    public func seal(_ draft: SealDraft) throws(GateBlocked) -> SealedText {
        let hits = check(
            text: draft.text, legend: draft.legend, entities: draft.entities, revealed: draft.revealedVaultIDs,
            kept: draft.keptValues, requireLegend: true)
        guard hits.isEmpty else { throw GateBlocked(hits: hits) }
        return make(text: draft.text, legend: draft.legend, entities: draft.entities, replacements: draft.replacements)
    }

    /// Seals a tool result before it is returned to the cloud model (INV-5).
    /// Placeholders in a tool result must belong to the thread's entity map.
    public func sealToolResult(_ text: String, entities: EntityMap) throws(GateBlocked) -> SealedText {
        let hits = check(text: text, legend: [], entities: entities, revealed: [], kept: [], requireLegend: false)
        guard hits.isEmpty else { throw GateBlocked(hits: hits) }
        return make(text: text, legend: [], entities: entities, replacements: [])
    }

    #if DEBUG
        /// DEBUG only — skips every check so the Model Armor second net can be demonstrated.
        /// Compiled out of Release. The report says `bypassed: true` and the UI shows a red banner.
        public func sealBypassingChecks(_ draft: SealDraft) -> SealedText {
            let outbound = Self.outbound(draft.text, draft.legend)
            return SealedText(
                value: draft.text, legend: draft.legend,
                gateReport: GateReport(
                    checksPassed: [], counts: Self.counts(draft.legend, draft.replacements, draft.entities),
                    outboundSha256: sha256Hex(outbound), bypassed: true))
        }
    #endif

    // MARK: - Checks

    func check(
        text: String, legend: [LegendLine], entities: EntityMap, revealed: Set<String>, kept: Set<String>, requireLegend: Bool
    ) -> [GateHit] {
        var hits: [GateHit] = []
        let descriptions = legend.map(\.description)

        // G6 — normal form and mixed scripts.
        if !Normaliser.isNormalised(text) { hits.append(GateHit(check: .g6Normalised, category: nil, span: nil, legendIndex: nil)) }
        for w in Homoglyphs.mixedScriptWords(in: text) {
            hits.append(GateHit(check: .g6Normalised, category: nil, span: TextSpan(start: w.start, end: w.end), legendIndex: nil))
        }
        for (i, d) in descriptions.enumerated() where !Normaliser.isNormalised(d) || !Homoglyphs.mixedScriptWords(in: d).isEmpty {
            hits.append(GateHit(check: .g6Normalised, category: nil, span: nil, legendIndex: i))
        }

        let terms = protectedTerms(entities: entities, revealed: revealed)
        let masked = Self.maskPlaceholders(text)

        // G1 / G2 on the text and its homoglyph skeleton.
        hits += termHits(in: masked, terms: terms, legendIndex: nil)

        // G3 — patterns.
        for p in patterns.detect(in: masked) where Self.blocksPattern(p) && !kept.contains(FoldedSearch.fold(p.text)) {
            hits.append(GateHit(check: .g3Patterns, category: p.category, span: p.span, legendIndex: nil))
        }

        // G4 — placeholders well-formed and explained.
        let legendIDs = Set(legend.map(\.placeholder))
        let known = legendIDs.union(entities.entities.keys)
        for token in PlaceholderParser(knownIDs: known).tokens(in: text) {
            let explained = requireLegend ? legendIDs.contains(token.id) : entities[token.id] != nil
            if !token.isCanonical || !explained {
                hits.append(GateHit(check: .g4PlaceholdersWellFormed, category: token.id.category, span: token.span, legendIndex: nil))
            }
        }
        if requireLegend {
            let used = Set(PlaceholderParser(knownIDs: known).tokens(in: text).map(\.id))
            for (i, line) in legend.enumerated() where !used.contains(line.placeholder) {
                hits.append(GateHit(check: .g4PlaceholdersWellFormed, category: line.placeholder.category, span: nil, legendIndex: i))
            }
        }

        // G5 — legend lines.
        for (i, d) in descriptions.enumerated() {
            for h in termHits(in: d, terms: terms, legendIndex: i) {
                hits.append(GateHit(check: .g5LegendClean, category: h.category, span: h.span, legendIndex: i))
            }
            if d.contains("[[") || patterns.detect(in: d).contains(where: { $0.category != .date }) {
                hits.append(GateHit(check: .g5LegendClean, category: nil, span: nil, legendIndex: i))
            }
        }

        // G7 — size.
        if Self.outbound(text, legend).utf16.count > limits.maxUTF16 {
            hits.append(GateHit(check: .g7Size, category: nil, span: nil, legendIndex: nil))
        }
        return hits
    }

    struct Term {
        let text: String
        let check: GateCheck
        let category: PrivacyCategory
        let caseSensitive: Bool
    }

    func protectedTerms(entities: EntityMap, revealed: Set<String>) -> [Term] {
        var terms: [Term] = []
        for entry in vault where !revealed.contains(entry.id) {
            terms += entry.allTerms.filter { $0.utf16.count >= 2 }.map {
                Term(text: $0, check: .g1VaultTerms, category: entry.category, caseSensitive: false)
            }
        }
        for e in entities.sorted where e.action.mustNotEgress {
            if let vid = e.vaultEntryID, revealed.contains(vid) { continue }
            terms += Self.entityTerms(e)
        }
        return terms
    }

    /// Every way an entity could still show up: whole surface forms (case-insensitive), plus for
    /// people, organisations and places:
    /// - contiguous sub-phrases of ≥ 2 words ("Mercy General" from "Mercy General Hospital"), case-insensitive;
    /// - distinctive single words (≥ 3 letters for people, ≥ 4 otherwise), **case-sensitive**,
    ///   excluding everyday words and generic place/organisation words ("Hospital", "Street").
    static func entityTerms(_ e: Entity) -> [Term] {
        let forms = e.surfaceForms.filter { $0.utf16.count >= 2 }
        var terms = forms.map { Term(text: $0, check: .g2SurfaceForms, category: e.category, caseSensitive: false) }
        guard [.person, .org, .location].contains(e.category) else { return terms }
        var phrases: Set<String> = []
        var singles: Set<String> = []
        for form in forms {
            let words = form.split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "," })
                .map { $0.trimmingCharacters(in: .punctuationCharacters.union(.symbols)) }.filter { !$0.isEmpty }
            if words.count >= 3 {
                for n in 2..<words.count {
                    for i in 0...(words.count - n) { phrases.insert(words[i..<(i + n)].joined(separator: " ")) }
                }
            }
            let minLength = e.category == .person ? 3 : 4
            for w in words where w.count >= minLength && w.first?.isUppercase == true {
                let lower = w.lowercased()
                if commonWords.contains(lower) || genericPlaceWords.contains(lower) || w.allSatisfy(\.isNumber) { continue }
                singles.insert(w)
            }
        }
        let all = Set(forms)
        terms += phrases.subtracting(all).map { Term(text: $0, check: .g2SurfaceForms, category: e.category, caseSensitive: false) }
        terms += singles.subtracting(all).map { Term(text: $0, check: .g2SurfaceForms, category: e.category, caseSensitive: true) }
        return terms
    }

    /// Generic words inside organisation and place names — never identifying on their own.
    static let genericPlaceWords: Set<String> = [
        "hospital", "clinic", "medical", "centre", "center", "health", "care", "general", "university", "college", "school",
        "academy", "institute", "bank", "group", "company", "corp", "corporation", "inc", "ltd", "llc", "limited", "partners",
        "services", "solutions", "logistics", "properties", "property", "management", "realty", "holdings", "international",
        "national", "global", "city", "county", "state", "north", "south", "east", "west", "new", "saint", "street", "road",
        "avenue", "lane", "drive", "court", "place", "park", "square", "apartment", "apartments", "unit", "suite", "floor",
        "view", "hill", "valley", "lake", "river", "church", "office", "department", "agency", "council", "trust", "foundation",
    ]

    func termHits(in text: String, terms: [Term], legendIndex: Int?) -> [GateHit] {
        let skeleton = Homoglyphs.skeleton(text)
        let haystacks = skeleton == text ? [text] : [text, skeleton]
        var hits: [GateHit] = []
        var seen: Set<TextSpan> = []
        for term in terms {
            for hay in haystacks {
                for span in FoldedSearch.ranges(of: term.text, in: hay, caseSensitive: term.caseSensitive) where !seen.contains(span) {
                    seen.insert(span)
                    hits.append(GateHit(check: term.check, category: term.category, span: span, legendIndex: legendIndex))
                }
            }
        }
        return hits
    }

    static func blocksPattern(_ c: Candidate) -> Bool {
        switch c.category {
        case .contact, .id, .secret: true
        case .location: c.subtype.map { PolicyEngine.addressSubtypes.contains($0) } ?? false
        default: false
        }
    }

    /// First names that are also everyday words — not checked case-sensitively as bare tokens.
    static let commonWords: Set<String> = [
        "will", "may", "june", "april", "august", "rose", "grace", "hope", "joy", "faith", "mark", "bill", "frank",
        "art", "sky", "river", "dawn", "summer", "autumn", "winter", "ray", "rich", "sunny", "honey", "page", "pat",
        "sue", "jack", "max", "victor", "trust", "ivy", "lily", "daisy", "ruby", "pearl", "amber", "crystal", "sandy",
        "rusty", "brook", "gay", "holly", "jean", "rob", "drew", "chase", "hunter", "mason", "cash", "king", "queen",
        "young", "white", "black", "brown", "green", "gray", "grey", "long", "little", "small", "good", "best", "street",
        "the", "and", "for", "you", "your", "our", "his", "her", "dear", "mom", "dad", "mum", "aunt", "uncle", "grandma",
        "mrs", "miss", "prof", "sir", "madam", "dame", "lord", "lady", "doctor",
    ]

    /// Canonical placeholder tokens replaced by spaces of equal UTF-16 length, so term and
    /// pattern searches never match inside our own `[[PERSON_ME]]`-style tokens.
    static func maskPlaceholders(_ text: String) -> String {
        let ns = NSMutableString(string: text)
        let regex = try? NSRegularExpression(pattern: #"\[\[[A-Z]+_(?:[0-9]+|ME)\]\]"#)
        for m in (regex?.matches(in: text, range: NSRange(location: 0, length: ns.length)) ?? []).reversed() {
            ns.replaceCharacters(in: m.range, with: String(repeating: " ", count: m.range.length))
        }
        return ns as String
    }

    // MARK: - Output

    static func outbound(_ text: String, _ legend: [LegendLine]) -> String {
        legend.isEmpty ? text : text + "\n\n" + legend.map(\.rendered).joined(separator: "\n")
    }

    static func counts(_ legend: [LegendLine], _ replacements: [Replacement], _ entities: EntityMap) -> [String: Int] {
        var counts: [String: Int] = [:]
        for line in legend { counts[line.placeholder.category.rawValue, default: 0] += 1 }
        counts["generalised"] = Set(replacements.filter { $0.kind == .generalised }.compactMap(\.entityID)).count
        counts["bucketed"] = replacements.filter { $0.kind == .bucketed }.count
        counts["redteamApplied"] = replacements.filter { $0.kind == .redteam }.count
        return counts
    }

    func make(text: String, legend: [LegendLine], entities: EntityMap, replacements: [Replacement]) -> SealedText {
        SealedText(
            value: text, legend: legend,
            gateReport: GateReport(
                checksPassed: GateCheck.allCases, counts: Self.counts(legend, replacements, entities),
                outboundSha256: sha256Hex(Self.outbound(text, legend))))
    }
}
