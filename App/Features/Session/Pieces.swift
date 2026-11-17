import AirlockCore
import AirlockRestore
import AirlockSeal
import Foundation

/// Turns AirlockKit values into `InlinePiece`s for display. Pure functions; local display only.
enum Pieces {
    /// "Person 1 · landlord", "You", "Place 2".
    static func chipLabel(_ e: Entity) -> String {
        if e.id.isMe { return String(localized: "You") }
        let n: String
        switch e.id.index {
        case .number(let i): n = "\(i)"
        case .me: n = ""
        }
        var role = e.roleHint?.trimmingCharacters(in: .whitespaces)
        if let r = role {
            role = r.replacingOccurrences(of: #"^(?:the (?:user|writer)'s|my) "#, with: "", options: [.regularExpression, .caseInsensitive])
            if role?.range(of: #"^the (user|writer)$"#, options: [.regularExpression, .caseInsensitive]) != nil { role = String(localized: "you") }
            if role?.isEmpty == true { role = nil }
        }
        return role.map { "\(e.category.label) \(n) · \($0)" } ?? "\(e.category.label) \(n)"
    }

    static func chipLabel(_ id: PlaceholderID, entities: EntityMap) -> String {
        if let e = entities[id] { return chipLabel(e) }
        if id.isMe { return String(localized: "You") }
        if case .number(let n) = id.index { return "\(id.category.label) \(n)" }
        return id.category.label
    }

    static func style(_ e: Entity, blocked: Bool = false) -> ChipStyle {
        if blocked || e.category == .secret || e.action == .block { return .secret }
        return .protected(e.category, lowConfidence: e.confidence < .high)
    }

    static func spoken(_ e: Entity, tappable: Bool) -> String {
        let label = chipLabel(e)
        var s =
            e.category == .secret || e.action == .block
            ? String(localized: "Hidden secret, \(label)") : String(localized: "Protected \(e.category.label.lowercased()), \(label)")
        if e.confidence < .high { s += String(localized: ", possibly private") }
        if tappable { s += String(localized: ". Can be sent as written.") }
        return s
    }

    /// The sealed draft exactly as it will leave, with chips (Review).
    static func draft(_ d: SealDraft, tappable: Bool) -> [InlinePiece] {
        let ns = d.text as NSString
        var out: [InlinePiece] = []
        var cursor = 0
        for r in d.replacements.sorted(by: { $0.sealedSpan.start < $1.sealedSpan.start }) {
            guard r.sealedSpan.start >= cursor, r.sealedSpan.end <= ns.length else { continue }
            if r.sealedSpan.start > cursor { out.append(.text(ns.substring(with: NSRange(location: cursor, length: r.sealedSpan.start - cursor)))) }
            let text = ns.substring(with: r.sealedSpan.nsRange)
            switch r.kind {
            case .generalised, .bucketed, .redteam:
                out.append(.chip(label: text, spoken: String(localized: "Made less specific: \(text)"), style: .generalised, entityID: nil))
            case .placeholder, .blocked:
                if let id = r.entityID, let e = d.entities[id] {
                    let canTap = tappable && e.category != .secret && r.kind != .blocked
                    out.append(
                        .chip(label: chipLabel(e), spoken: spoken(e, tappable: canTap), style: style(e, blocked: r.kind == .blocked), entityID: canTap ? id : nil))
                } else {
                    out.append(.text(text))
                }
            }
            cursor = r.sealedSpan.end
        }
        if cursor < ns.length { out.append(.text(ns.substring(from: cursor))) }
        return out
    }

    /// Sealed text that already left (thread bubbles): placeholder tokens become chips.
    static func sealed(_ text: String, entities: EntityMap) -> [InlinePiece] {
        let parser = PlaceholderParser(knownIDs: Set(entities.entities.keys))
        let ns = text as NSString
        var out: [InlinePiece] = []
        var cursor = 0
        for t in parser.tokens(in: text) where t.span.start >= cursor {
            if t.span.start > cursor { out.append(.text(ns.substring(with: NSRange(location: cursor, length: t.span.start - cursor)))) }
            if let e = entities[t.id] {
                out.append(.chip(label: chipLabel(e), spoken: spoken(e, tappable: false), style: style(e), entityID: nil))
            } else {
                out.append(.chip(label: chipLabel(t.id, entities: entities), spoken: chipLabel(t.id, entities: entities), style: .protected(t.id.category, lowConfidence: false), entityID: nil))
            }
            cursor = t.span.end
        }
        if cursor < ns.length { out.append(.text(ns.substring(from: cursor))) }
        return out
    }

    /// Text with bare or bracketed placeholder ids (risk cards: "lives near LOC_1").
    static func withChips(_ text: String, entities: EntityMap) -> [InlinePiece] {
        guard let re = try? NSRegularExpression(pattern: #"(?:\[\[)?\b((?:PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET)_(?:\d+|ME))\b(?:\]\])?"#)
        else { return [.text(text)] }
        let ns = text as NSString
        var out: [InlinePiece] = []
        var cursor = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > cursor { out.append(.text(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor)))) }
            let raw = ns.substring(with: m.range(at: 1))
            if let id = PlaceholderID(string: raw) {
                let label = chipLabel(id, entities: entities)
                out.append(.chip(label: label, spoken: label, style: entities[id].map { style($0) } ?? .protected(id.category, lowConfidence: false), entityID: nil))
            } else {
                out.append(.text(raw))
            }
            cursor = m.range.location + m.range.length
        }
        if cursor < ns.length { out.append(.text(ns.substring(from: cursor))) }
        return out
    }

    /// A restored answer: real details underlined, secrets as "hidden code" chips.
    static func restored(_ segments: [RestoredSegment]) -> [InlinePiece] {
        segments.map { s in
            switch s {
            case .text(let t): .text(t.replacingOccurrences(of: "**", with: ""))
            case .restored(_, let display, _): .restored(display)
            case .secret:
                .chip(label: String(localized: "hidden code"), spoken: String(localized: "Hidden code, never shown"), style: .secret, entityID: nil)
            case .unknown:
                .chip(
                    label: String(localized: "unknown"), spoken: String(localized: "A placeholder Airlock doesn't know"), style: .unknown, entityID: nil)
            }
        }
    }

    /// Plain restored text (copy button).
    static func plain(_ segments: [RestoredSegment]) -> String {
        segments.map { $0.output(secretDisplay: String(localized: "(hidden code)")) }.joined().replacingOccurrences(of: "**", with: "")
    }

    /// "Gemini · 3.8 Flash" style model names.
    static func prettyModel(_ m: String) -> String {
        if m == EngineResult.appleOnDeviceModelVersion { return String(localized: "Apple on-device model") }
        let s = m.replacingOccurrences(of: #"^gemini-"#, with: "", options: .regularExpression).replacingOccurrences(of: "-", with: " ")
        return s.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}
