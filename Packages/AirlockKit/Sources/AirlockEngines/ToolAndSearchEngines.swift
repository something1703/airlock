import AirlockCore
import AirlockPrompts
import FirebaseAILogic
import Foundation

/// Cloud function calling with private tools (classic `GenerativeModel` + `Chat`).
///
/// Guarantees: every reply sent back to the model is a gate-produced `SealedText` or one of the
/// fixed `user_declined` / `unavailable` payloads (INV-5); at most `maxTurns` tool rounds.
struct FirebaseToolEngine: ToolCapableEngine {
    let engines: FirebaseEngines
    static let maxTurns = 6

    func runToolLoop(
        _ sealed: SealedText, task: TaskSpec, tools: [ToolSpec], executor: @escaping @Sendable (ToolCall) async -> ToolReply
    ) async throws(EngineError) -> EngineResult {
        let instructions: String
        let turn: String
        do {
            instructions = try engines.prompts.template("cloud-system.v1") + "\n\n" + engines.prompts.template("tools-addendum.v1")
            turn = try engines.prompts.cloudUserTurn(sealed, task: task, history: nil)
        } catch {
            throw .other(code: "prompt")
        }
        let model = engines.ai.generativeModel(
            modelName: engines.config.modelCloudDeep,
            generationConfig: GenerationConfig(maxOutputTokens: task.maxOutputTokens),
            tools: [.functionDeclarations(tools.map(Self.declaration))],
            toolConfig: ToolConfig(functionCallingConfig: .auto()),
            systemInstruction: ModelContent(role: "system", parts: instructions))
        let clock = ContinuousClock()
        let start = clock.now
        do {
            let chat = model.startChat()
            var response = try await chat.sendMessage(turn)
            var turns = 0
            while !response.functionCalls.isEmpty, turns < Self.maxTurns {
                turns += 1
                var parts: [any Part] = []
                for call in response.functionCalls {
                    let reply = await executor(ToolCall(id: call.functionId, name: call.name, argumentsJSON: Self.json(call.args)))
                    parts.append(FunctionResponsePart(name: call.name, response: Self.payload(reply), functionId: call.functionId))
                }
                response = try await chat.sendMessage([ModelContent(role: "function", parts: parts)])
            }
            return EngineResult(text: response.text ?? "", modelVersion: response.modelVersion, latency: clock.now - start)
        } catch {
            throw ErrorMapper.map(error)
        }
    }

    static func declaration(_ spec: ToolSpec) -> FunctionDeclaration {
        var params: [String: Schema] = [:]
        for p in spec.parameters {
            switch p.kind {
            case .string: params[p.name] = .string(description: p.description)
            case .integer: params[p.name] = .integer(description: p.description)
            case .number: params[p.name] = .double(description: p.description)
            case .boolean: params[p.name] = .boolean(description: p.description)
            }
        }
        return FunctionDeclaration(
            name: spec.name, description: spec.description, parameters: params,
            optionalParameters: spec.parameters.filter(\.optional).map(\.name))
    }

    /// The only payloads that can go back to the model.
    static func payload(_ reply: ToolReply) -> JSONObject {
        switch reply {
        case .declined: return ["error": .string("user_declined")]
        case .unavailable: return ["error": .string("unavailable")]
        case .result(let sealed):
            guard let data = sealed.value.data(using: .utf8), let any = try? JSONSerialization.jsonObject(with: data),
                case .object(let obj) = jsonValue(any)
            else { return ["result": .string(sealed.value)] }
            return obj
        }
    }

    static func jsonValue(_ any: Any) -> JSONValue {
        switch any {
        case let s as String: return .string(s)
        case let n as NSNumber:
            return CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let a as [Any]: return .array(a.map(jsonValue))
        case let d as [String: Any]: return .object(d.mapValues(jsonValue))
        default: return .null
        }
    }

    static func anyValue(_ v: JSONValue) -> Any {
        switch v {
        case .null: return NSNull()
        case .number(let d): return d
        case .string(let s): return s
        case .bool(let b): return b
        case .object(let o): return o.mapValues(anyValue)
        case .array(let a): return a.map(anyValue)
        }
    }

    static func json(_ obj: JSONObject) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: obj.mapValues(anyValue), options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// Gemini + Google Search grounding (Proof mode). Separate call from tools (API-NOTES §2).
struct FirebaseSearchEngine: SearchGroundedEngine {
    let engines: FirebaseEngines

    func respond(_ sealed: SealedText, task: TaskSpec) async throws(EngineError) -> GroundedResult {
        let instructions: String
        let turn: String
        do {
            instructions = try engines.prompts.template("cloud-system.v1")
            turn = try engines.prompts.cloudUserTurn(sealed, task: task, history: nil)
        } catch {
            throw .other(code: "prompt")
        }
        let model = engines.ai.generativeModel(
            modelName: engines.config.modelCloudProof, tools: [.googleSearch()],
            systemInstruction: ModelContent(role: "system", parts: instructions))
        let clock = ContinuousClock()
        let start = clock.now
        do {
            let response = try await FirebaseEngines.withRetry { () async throws(EngineError) -> GenerateContentResponse in
                do { return try await model.generateContent(turn) } catch { throw ErrorMapper.map(error) }
            }
            let grounding = response.candidates.first?.groundingMetadata
            let sources = (grounding?.groundingChunks ?? []).compactMap { chunk -> GroundingSource? in
                guard let uri = chunk.web?.uri else { return nil }
                return GroundingSource(title: chunk.web?.title, uri: uri)
            }
            return GroundedResult(
                result: EngineResult(text: response.text ?? "", modelVersion: response.modelVersion, latency: clock.now - start),
                sources: sources, searchQueries: grounding?.webSearchQueries ?? [],
                searchEntryPointHTML: grounding?.searchEntryPoint?.renderedContent)
        } catch {
            throw error
        }
    }
}
