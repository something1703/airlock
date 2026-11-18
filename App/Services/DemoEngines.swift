import AirlockCore
import AirlockEngineMocks
import Foundation

/// Scripted engines for demo mode (`-demo`, the Demo scheme, or no Firebase config) — the native
/// twin of the web `demoEngines()`. No AI calls are made; the UI labels this clearly.
///
/// The phone engine is a `MockPhoneEngine` with a little latency so the sealing steps are visible;
/// the sealed engines stream like the real SDK (cumulative snapshots).
enum DemoEngines {
    static func make(latency: Duration = .milliseconds(450)) -> MockEngines {
        let phone = MockPhoneEngine(latency: latency) { id, text in
            switch id {
            case "detect.v1": return detect(chunk(of: text))
            case "gen.v1": return rewrite(phrase(of: text))
            case "attack.v1":
                return text.contains("work nights")
                    ? #"{"guesses":[{"attribute":"occupation","guess":"works night shifts at a hospital","evidence":"I work nights","confidence":"medium"}]}"#
                    : #"{"guesses":[]}"#
            case "title.v1": return "Broken heater repair"
            default: return "{}"
            }
        }
        var sealed: [Route: any SealedEngine] = [:]
        for route in Route.allCases { sealed[route] = DemoSealedEngine(route: route) }
        return MockEngines(phone: phone, sealed: sealed)
    }

    /// The user text inside a rendered `detect.v1` prompt (between `<<<` and `>>>`).
    static func chunk(of prompt: String) -> String {
        guard let open = prompt.range(of: "<<<"), let close = prompt.range(of: ">>>", options: .backwards), open.upperBound <= close.lowerBound
        else { return prompt }
        return String(prompt[open.upperBound..<close.lowerBound])
    }

    static func phrase(of prompt: String) -> String {
        guard let r = prompt.range(of: "Phrase to rewrite: ") else { return "" }
        return String(prompt[r.upperBound...].prefix { $0 != "\n" })
    }

    static func detect(_ text: String) -> String {
        var items: [String] = []
        if text.contains("Mercy General Hospital") {
            items.append(#"{"text":"Mercy General Hospital","type":"ORG","role":"the writer's employer","confidence":"high"}"#)
        }
        if text.contains("Raj Patel") {
            items.append(#"{"text":"Raj Patel","type":"PERSON","role":"the writer's landlord","confidence":"high"}"#)
        } else if text.contains("Raj") {
            items.append(#"{"text":"Raj","type":"PERSON","role":"the writer's landlord","confidence":"high"}"#)
        }
        return #"{"items":["# + items.joined(separator: ",") + "]}"
    }

    static func rewrite(_ phrase: String) -> String {
        if phrase.contains("Mercy General Hospital") { return #"{"rewrite":"a large hospital"}"# }
        if phrase.contains("work nights") { return #"{"rewrite":"I work shifts"}"# }
        return "{}"
    }
}

/// A scripted cloud/phone answer that streams slowly enough to watch.
struct DemoSealedEngine: SealedEngine {
    let route: Route

    private var modelVersion: String {
        route == .phoneFirst || route == .phoneOnly ? EngineResult.appleOnDeviceModelVersion : "gemini-demo"
    }

    func respond(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) async throws(EngineError) -> EngineResult {
        // Long enough to see the "asking" state (F-25); never reaches a network.
        try? await Task.sleep(for: .milliseconds(900))
        return EngineResult(
            text: Self.script(for: task.id, sealed: sealed, followUp: history != nil), modelVersion: modelVersion, latency: .milliseconds(900))
    }

    func stream(_ sealed: SealedText, task: TaskSpec, history: SealedHistory?) -> AsyncThrowingStream<EngineChunk, any Error> {
        let text = Self.script(for: task.id, sealed: sealed, followUp: history != nil)
        let version = modelVersion
        let firstWords: Duration = route == .phoneFirst || route == .phoneOnly ? .milliseconds(350) : .milliseconds(900)
        return AsyncThrowingStream { continuation in
            let work = Task {
                try? await Task.sleep(for: firstWords)
                var acc = ""
                for ch in text {
                    acc.append(ch)
                    if acc.count % 5 == 0 {
                        continuation.yield(EngineChunk(cumulativeText: acc, modelVersion: version))
                        try? await Task.sleep(for: .milliseconds(22))
                    }
                    if Task.isCancelled { break }
                }
                continuation.yield(EngineChunk(cumulativeText: acc, modelVersion: version))
                continuation.finish()
            }
            continuation.onTermination = { _ in work.cancel() }
        }
    }

    /// Fills the script with placeholders this thread actually has, so restore always resolves.
    static func script(for taskID: String, sealed: SealedText, followUp: Bool) -> String {
        let ids = Set(sealed.legend.map(\.placeholder.description))
        let person = ids.sorted().first { $0.hasPrefix("PERSON_") && $0 != "PERSON_ME" }.map { "[[\($0)]]" } ?? "them"
        let place = ids.sorted().first { $0.hasPrefix("LOC_") }.map { "[[\($0)]]" } ?? "your home"
        let me = ids.contains("PERSON_ME") ? "[[PERSON_ME]]" : "Me"
        if taskID == "infer.v1" {
            // Fictional guesses, like the web `DEMO_INFERENCES`: the situation shows through the seal.
            return #"{"inferences":["#
                + #"{"attribute":"situation","value":"Renting an apartment with a broken heater, in a dispute with the landlord","confidence":"high","evidence":"the heater at \#(place) has been broken"},"#
                + #"{"attribute":"occupation","value":"Works night shifts, probably in healthcare","confidence":"medium","evidence":"I work nights at a large hospital"},"#
                + #"{"attribute":"region","value":"Likely the United States","confidence":"low","evidence":"date format 'Oct 28'"}]}"#
        }
        if followUp {
            return
                "Good question. If \(person) still hasn't replied in two days, send a short reminder and keep a note of every message.\n\nYou could say: \"Hi \(person), following up on the heater at \(place). Could you confirm a repair date?\""
        }
        switch taskID {
        case "task.summary.v1":
            return "- \(person) hasn't fixed the heater at \(place).\n- You've asked several times.\n- You need it repaired this week."
        case "task.explain.v1":
            return
                "In plain words: the heater at \(place) is broken, you've asked \(person) several times, and you need a repair soon because you sleep during the day."
        case "task.questions.v1":
            return
                "Questions you could ask \(person):\n- When can someone come to look at the heater?\n- Who should you contact if it isn't fixed this week?\n- Can you get the repair date in writing?"
        case "task.actions.v1":
            return
                "1. Send \(person) a short written message today.\n2. Keep copies of every message about the heater at \(place).\n3. Ask for a repair date this week."
        default:
            return
                "Here's a firm, polite reply you can send to \(person):\n\nHi \(person), the heater at \(place) is still broken. I work nights and need to sleep during the day, so please arrange a repair this week.\n\nThanks,\n\(me)"
        }
    }
}
