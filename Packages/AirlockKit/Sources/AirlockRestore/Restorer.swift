import AirlockCore
import Foundation

/// Everything the restorer may use. Built on device from the thread's entity map.
public struct RestoreContext: Sendable {
    public let entities: EntityMap
    /// The user's first name, used for `[[PERSON_ME]]` only in drafts written as the user.
    public let userFirstName: String?
    /// True for "Draft a reply… write it as me" tasks (signature uses the first name).
    public let writingAsUser: Bool
    /// Plain-text stand-in for secrets in copied text. Secrets are never restored.
    public let secretDisplay: String

    public init(entities: EntityMap, userFirstName: String? = nil, writingAsUser: Bool = false, secretDisplay: String = "(hidden code)") {
        self.entities = entities
        self.userFirstName = userFirstName
        self.writingAsUser = writingAsUser
        self.secretDisplay = secretDisplay
    }
}

/// A piece of restored output.
public enum RestoredSegment: Sendable, Hashable {
    case text(String)
    /// A placeholder replaced with a real value (UI underlines it; tap shows `original`).
    case restored(id: PlaceholderID, display: String, original: String)
    /// `[[SECRET_n]]` — shown as a coral "hidden code" chip, never restored.
    case secret(id: PlaceholderID, original: String)
    /// A canonical placeholder whose id the phone doesn't know (model invented it).
    case unknown(id: PlaceholderID, original: String)

    /// The text this segment contributes to copied output.
    public func output(secretDisplay: String) -> String {
        switch self {
        case .text(let s): s
        case .restored(_, let display, _): display
        case .secret: secretDisplay
        case .unknown(_, let original): original
        }
    }
}

/// Streaming-safe restore of model output (`docs/03-PRIVACY-ENGINE.md` §11.3).
///
/// Guarantees:
/// - For any way of splitting a response into chunks — deltas or cumulative
///   snapshots — the emitted segments are identical to restoring the whole
///   response at once (`RestorerTests` fuzzes every split point).
/// - Text is held back only near the end of the buffer (≤ `holdBack` units),
///   so the answer streams with at most a few characters of delay.
/// - `SECRET_n` is never restored; unknown ids are flagged, not guessed.
public struct StreamingRestorer: Sendable {
    /// Must exceed `PlaceholderParser.maxTokenLength` plus one unit of look-ahead.
    public static let holdBack = 32

    public let context: RestoreContext
    private let parser: PlaceholderParser
    private let displayForms: [PlaceholderID: (first: String, later: String)]
    private var buffer = ""
    private var emitted = 0  // UTF-16 offset into `buffer`
    private var seen: Set<PlaceholderID> = []
    public private(set) var segments: [RestoredSegment] = []
    public private(set) var finished = false

    public init(context: RestoreContext) {
        self.context = context
        parser = PlaceholderParser(knownIDs: Set(context.entities.entities.keys))
        displayForms = Self.displayForms(for: context.entities)
    }

    /// Feeds a delta (new text only). Returns newly emitted segments.
    @discardableResult
    public mutating func append(delta: String) -> [RestoredSegment] {
        precondition(!finished, "restorer already finished")
        buffer += delta
        return process(final: false)
    }

    /// Feeds a cumulative snapshot (whole response so far). Returns newly emitted segments.
    @discardableResult
    public mutating func update(cumulative snapshot: String) -> [RestoredSegment] {
        let have = buffer.utf16.count
        let ns = snapshot as NSString
        guard ns.length > have else { return [] }
        return append(delta: ns.substring(from: have))
    }

    /// Flushes everything still held back.
    @discardableResult
    public mutating func finish() -> [RestoredSegment] {
        let out = process(final: true)
        finished = true
        return out
    }

    /// Full restored text so far.
    public var text: String { segments.map { $0.output(secretDisplay: context.secretDisplay) }.joined() }

    // MARK: - Internals

    private mutating func process(final: Bool) -> [RestoredSegment] {
        let ns = buffer as NSString
        let tokens = parser.tokens(in: buffer)
        var safeEnd = final ? ns.length : max(emitted, ns.length - Self.holdBack)
        if !final, let spanning = tokens.first(where: { $0.span.start < safeEnd && $0.span.end > safeEnd }) {
            safeEnd = max(emitted, spanning.span.start)
        }
        // Never cut between the two UTF-16 halves of one character (emoji, rare scripts).
        if !final, safeEnd > emitted, safeEnd < ns.length, UTF16.isLeadSurrogate(ns.character(at: safeEnd - 1)) {
            safeEnd -= 1
        }
        guard safeEnd > emitted else { return [] }

        var out: [RestoredSegment] = []
        var cursor = emitted
        for token in tokens where token.span.start >= emitted && token.span.end <= safeEnd {
            if token.span.start > cursor {
                out.append(.text(ns.substring(with: NSRange(location: cursor, length: token.span.start - cursor))))
            }
            out.append(resolve(token))
            cursor = token.span.end
        }
        if safeEnd > cursor {
            out.append(.text(ns.substring(with: NSRange(location: cursor, length: safeEnd - cursor))))
        }
        emitted = safeEnd
        append(out)
        return out
    }

    private mutating func append(_ new: [RestoredSegment]) {
        for seg in new {
            if case .text(let s) = seg, case .text(let prev)? = segments.last {
                segments[segments.count - 1] = .text(prev + s)
            } else {
                segments.append(seg)
            }
        }
    }

    private mutating func resolve(_ token: PlaceholderToken) -> RestoredSegment {
        if token.id.category == .secret { return .secret(id: token.id, original: token.original) }
        if token.id.isMe {
            let display = context.writingAsUser ? (context.userFirstName ?? "me") : "you"
            return .restored(id: token.id, display: display, original: token.original)
        }
        guard let forms = displayForms[token.id] else { return .unknown(id: token.id, original: token.original) }
        let display = seen.contains(token.id) ? forms.later : forms.first
        seen.insert(token.id)
        return .restored(id: token.id, display: display, original: token.original)
    }

    /// First mention: canonical. Later mentions of a person: the shortest
    /// surface form no other person shares ("Raj" for "Raj Patel").
    static func displayForms(for map: EntityMap) -> [PlaceholderID: (first: String, later: String)] {
        let people = map.sorted.filter { $0.category == .person }
        let titles: Set<String> = ["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "prof", "prof."]
        var result: [PlaceholderID: (first: String, later: String)] = [:]
        for entity in map.sorted {
            guard entity.category == .person else {
                result[entity.id] = (entity.canonical, entity.canonical)
                continue
            }
            let others = people.filter { $0.id != entity.id }
            let otherForms = Set(
                others.flatMap { o in
                    o.surfaceForms.map(FoldedSearch.fold) + o.canonical.split(separator: " ").map { FoldedSearch.fold(String($0)) }
                })
            let short =
                entity.surfaceForms
                .filter { !titles.contains($0.lowercased()) && !otherForms.contains(FoldedSearch.fold($0)) }
                .sorted { $0.utf16.count != $1.utf16.count ? $0.utf16.count < $1.utf16.count : $0 < $1 }
                .first ?? entity.canonical
            result[entity.id] = (entity.canonical, short)
        }
        return result
    }
}

/// The finished restore of one answer.
public struct RestoreResult: Sendable, Hashable {
    public let text: String
    public let segments: [RestoredSegment]
    /// Where restored values sit in `text` (UTF-16), for underlining.
    public let restoredRanges: [TextSpan: PlaceholderID]
    public let unknownIDs: [PlaceholderID]
    public let secretsHidden: Int
}

/// Unary restore — defined as one streaming append plus finish, so streaming and
/// non-streaming can never disagree.
public enum Restorer {
    public static func restore(_ modelOutput: String, context: RestoreContext) -> RestoreResult {
        var s = StreamingRestorer(context: context)
        s.append(delta: modelOutput)
        s.finish()
        return result(from: s)
    }

    public static func result(from restorer: StreamingRestorer) -> RestoreResult {
        var ranges: [TextSpan: PlaceholderID] = [:]
        var unknown: [PlaceholderID] = []
        var secrets = 0
        var offset = 0
        for seg in restorer.segments {
            let piece = seg.output(secretDisplay: restorer.context.secretDisplay)
            let len = piece.utf16.count
            switch seg {
            case .restored(let id, _, _): ranges[TextSpan(start: offset, end: offset + len)] = id
            case .unknown(let id, _): unknown.append(id)
            case .secret: secrets += 1
            case .text: break
            }
            offset += len
        }
        return RestoreResult(
            text: restorer.text, segments: restorer.segments, restoredRanges: ranges, unknownIDs: unknown, secretsHidden: secrets)
    }
}

/// Post-answer checks (`docs/03-PRIVACY-ENGINE.md` §11.4).
public struct FidelityReport: Sendable, Hashable {
    /// Canonical placeholders the phone couldn't resolve.
    public let unknownIDs: [PlaceholderID]
    /// Entities whose real surface form appears in the model's own output —
    /// the model guessed a real name. Shown as "Gemini mentioned a name you didn't share".
    public let guessedEntities: [PlaceholderID]

    public var isClean: Bool { unknownIDs.isEmpty && guessedEntities.isEmpty }
}

public enum FidelityCheck {
    /// Runs on the model's raw output (before restore), so any real value found
    /// there was not introduced by restore.
    public static func check(modelOutput: String, context: RestoreContext) -> FidelityReport {
        let restored = Restorer.restore(modelOutput, context: context)
        let guessed = context.entities.sorted.filter { entity in
            entity.action.mustNotEgress
                && entity.surfaceForms.contains { form in
                    form.utf16.count >= 3 && FoldedSearch.contains(form, in: modelOutput)
                }
        }.map(\.id)
        return FidelityReport(unknownIDs: restored.unknownIDs, guessedEntities: guessed)
    }
}
