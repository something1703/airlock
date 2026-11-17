# API-NOTES — what we know about the SDKs, and how sure we are

This is a living file. Agents add to "Verified in source" whenever they confirm a signature in the SDK checkout. Status key: **✅ documented** (in official docs as of 15 Nov 2026), **🔍 verify** (plausible, not confirmed), **❌ not supported**.

---

## 1. Firebase AI Logic — iOS hybrid inference

Source: firebase.google.com/docs/ai-logic/hybrid/ios/get-started and …/configuration-options.

| Fact | Status |
|------|--------|
| Feature is **Experimental**: no SLA, may change in backward-incompatible ways. Pin the SDK version exactly. | ✅ |
| Requires Firebase SDK **v12.13.0+**, installed with **Swift Package Manager** (hybrid only works via SPM). Products: `FirebaseAILogic`, `FirebaseAppCheck`. | ✅ |
| On-device needs Apple Intelligence enabled. Apps cannot trigger the model download or enable Apple Intelligence; they can check availability and ask the user. | ✅ |
| On-device inference runs **only while the app is in the foreground**. | ✅ |
| Use is governed by Apple's acceptable-use requirements for the Foundation Models framework. | ✅ |
| Service: `FirebaseAI.firebaseAI(backend: .googleAI())`. | ✅ |
| Cloud model: `ai.geminiModel(name: "…")`. | ✅ |
| System model: `FirebaseAI.SystemLanguageModel.default`. | ✅ |
| Hybrid: docs show both `HybridModel(primary:secondary:)` and `.hybridModel(primary:secondary:)` passed to `ai.generativeModelSession(model:)`. | ✅ (two spellings seen) 🔍 confirm which compiles |
| The get-started sample creates `ai` then calls `firebaseAI.generativeModelSession` — a naming bug in the docs. Use one variable. | ✅ correction |
| Phone only: `ai.generativeModelSession(model: systemModel)`. Cloud only: `ai.generativeModelSession(model: cloudModel)`. | ✅ |
| **Prefer on-device**: primary = system, secondary = cloud. Falls back to cloud if on-device is unavailable *or doesn't support the request*. | ✅ |
| **Prefer in-cloud**: primary = cloud, secondary = system. Falls back to on-device **only when offline**; other failures throw. | ✅ |
| Single model (no hybrid): failures throw. | ✅ |
| `session.respond(to:)` → `response.content`. `session.streamResponse(to:)` → `for try await snapshot in stream { snapshot.content }`. | ✅ |
| Are stream snapshots cumulative or deltas? | 🔍 verify — restorer handles both |
| A `GenerativeModelSession` keeps chat history. For single-turn use, create a new session per request. | ✅ (→ INV-4) |
| Which model answered: `response.rawResponse.modelVersion` → cloud model name, or `apple-foundation-models-system-language-model` for on-device. | ✅ |
| Per-request config: `options: .hybrid(gemini: GenerationConfig(temperature:topP:thinkingConfig:), foundationModels: FirebaseAI.GenerationOptions(sampling:temperature:))`. | ✅ |
| Greedy sampling option for on-device (`sampling: .greedy`)? | 🔍 verify in `GenerationOptions` |
| Max output tokens option for on-device? | 🔍 verify |
| System instructions / instructions for sessions | 🔍 not documented for hybrid — verify; fallback: prepend instructions to prompt |
| Availability: `FirebaseAI.SystemLanguageModel.default.isAvailable` and `.availability` → `.available`, `.unavailable(.deviceNotEligible)`, `.unavailable(.appleIntelligenceNotEnabled)`, `.unavailable(.modelNotReady)`, `.unavailable(other)`. | ✅ |
| On-device supports: text in → text out, streaming, multi-turn via session. | ✅ |
| On-device **structured output** (JSON/enums): "supported", docs "coming soon". | ✅ exists / 🔍 API shape — fallback: JSON-in-prompt + strict parser (see `03-PRIVACY-ENGINE.md` §5.4) |
| On-device **function calling**: "supported", docs "coming soon". | ✅ exists / 🔍 API shape — we do not need it on-device in v1 |
| On-device does **not** support: image/audio/video/PDF input, media generation, requests over **4,096 tokens** (~3,000 English words), built-in tools (Search, Maps, code execution, URL context). | ❌ |
| Firebase console AI monitoring shows **no data** for on-device inference. | ✅ (we log our own on-device metrics locally) |
| Not supported with hybrid at all: **Live API, server prompt templates, count tokens**. | ❌ |
| Content guardrail refusals from Apple's model — error type? | 🔍 verify; handle generically as `EngineError.refused` |

## 2. Firebase AI Logic — cloud features we use

| Fact | Status |
|------|--------|
| Function calling: declare `FunctionDeclaration` (name, description, parameter schema); pass via `tools` on a `GenerativeModel`; the **app** executes the function and returns results; the model may request several in parallel; up to 128 declarations; schema is an OpenAPI subset (no `default`, `oneOf`, `maximum`); fields required unless listed in `optionalProperties`; tool config modes `AUTO`/`ANY`/`NONE`. | ✅ |
| Function-calling models include `gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-carbon`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`. | ✅ |
| Classic API shape: `ai.generativeModel(modelName:tools:systemInstruction:)` + `startChat()` + `sendMessage`. | 🔍 verify exact labels |
| Google Search grounding: `tools: [.googleSearch()]`; response carries grounding metadata. Search grounding has **display requirements** (show search suggestions/attribution as specified in Firebase docs). | 🔍 verify API + read display requirements before shipping Proof |
| Function calling + Search grounding in one request? | 🔍 not documented — keep them in separate calls |

## 3. Models (Gemini Developer API, 15 Nov 2026)

| Model | Stage | Billing required | Our use |
|-------|-------|------------------|---------|
| `gemini-3.5-flash-lite` | Stable | No | Quick-task cloud fallback; default cloud model in Firebase web hybrid |
| `gemini-3.8-flash` | Stable | No | **Default deep answers**, Proof check, eval judge |
| `gemini-4-hydrogen` | Stable | No | "Max" mode (Remote Config switch) |
| `gemini-4-argon`, `gemini-4-carbon` | Stable | Yes | Not used by default |
| `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` | Stable | No | **Not used** for restored text (INV-10) |
| `gemini-3.1-flash-tts-preview` | Preview | — | **Do not use**: shuts down 17 Nov 2026 |

Gemini 2.5 models are deprecated; requests are rerouted from 1 Dec 2026. Do not reference them.

Model availability on the **Agent Platform (formerly Vertex AI) backend** under the same names: 🔍 verify before switching `ai_backend`.

## 4. Security, App Check, quotas

| Fact | Status |
|------|--------|
| App Check enforcement is **required** for Firebase AI Logic since 2 Nov 2026. Debug provider for development; debug tokens accepted in hackathon submissions. | ✅ |
| Debug provider: set `AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())` **before** `FirebaseApp.configure()`; copy token from console log; register in console. | ✅ |
| Apple attestation providers: DeviceCheck, App Attest, reCAPTCHA Enterprise. App Attest does not work in the Simulator. | ✅ / ✅ |
| Per-user rate limit default: 100 requests/minute; configurable. | ✅ |
| API key restrictions: restrict to bundle ID; API restrictions should include `firebasevertexai.googleapis.com` plus only the Firebase services used. | ✅ |
| Use separate Firebase projects for dev and demo/prod. | ✅ (recommended) |

## 5. Model Armor (Google Cloud)

| Fact | Status |
|------|--------|
| Integrates with Gemini on **Agent Platform / Vertex AI**: intercepts prompts before the model and responses before the app. Docs say it can protect other interfaces to the Vertex Gemini API, **including Firebase AI Logic SDKs**. | ✅ |
| Gemini **Developer API** backend: not covered. To use Model Armor, set `ai_backend = agentPlatform` (billing required). | ✅ |
| Covers `generateContent` only; streaming not mentioned. | ✅ / 🔍 test streaming |
| With `INSPECT_AND_BLOCK`, blocked responses carry `promptFeedback.blockReason = "MODEL_ARMOR"` with a message. | ✅ |
| Sensitive Data Protection filter **blocks**; it does not pass de-identified text back to Gemini. | ✅ |
| **Fails open**: if Model Armor is unavailable or errors, processing continues unscreened. | ✅ (→ it is a second net, never the first) |
| Results visible in Cloud Logging (must enable logging). Configured via project-level floor settings. | ✅ |
| Free tier: 2 million tokens/month, then $0.10 per 1M tokens. | ✅ |

## 6. Simulator facts

| Fact | Status |
|------|--------|
| Foundation Models runs in the iOS Simulator (26+) when the **Mac** supports Apple Intelligence and has it enabled. The Simulator uses the Mac's model. | ✅ (Apple DTS, forums) |
| macOS version must be ≥ the Simulator runtime version (including betas) or calls fail. | ✅ |
| VisionKit document camera is not available in the Simulator → use `PhotosPicker` + file importer for images and PDFs. | ✅ |
| Free Apple ID can run on a physical device for 7 days. TestFlight requires the paid program. | ✅ |
| Sign in with Apple capability requires the paid program. | 🔍 believed true — we use Anonymous + Google sign-in instead |

## 6b. Web SDK facts (verified 17 Nov in `firebase@13.3.0` / `@firebase/ai@3.1.0` typings)

| Fact | Status |
|------|--------|
| Unlike iOS, the **web hybrid API was NOT removed in 13.x**: `getGenerativeModel(ai, { mode, onDeviceParams?, inCloudParams? })` with `mode` ∈ `InferenceMode.PREFER_ON_DEVICE / ONLY_ON_DEVICE / PREFER_IN_CLOUD / ONLY_IN_CLOUD` (string values `prefer_on_device` …). `HybridParams.inCloudParams: ModelParams` carries the cloud model name. | ✅ |
| `model.initializeDeviceModel(onDownloadProgress?)` triggers the on-device download; **must run after a user gesture** (click/keypress) or a needed download errors. Calling inference before it's ready → cloud fallback under `PREFER_ON_DEVICE`, **throws** under `ONLY_ON_DEVICE`. | ✅ |
| Responses carry `inferenceSource: InferenceSource.ON_DEVICE \| IN_CLOUD` (`"on_device"` / `"in_cloud"`). There is **no `modelVersion`** field on the enhanced response — web `ranOnDevice` comes from `inferenceSource`; the cloud model name is what we configured. | ✅ |
| `OnDeviceParams = { createOptions?: LanguageModelCreateOptions, promptOptions?: LanguageModelPromptOptions }` — Chrome Prompt API options (expectedInputs/outputs default to English text + image input; download `monitor`). | ✅ |
| Backends: `new GoogleAIBackend()` (Gemini Developer API) and `new AgentPlatformBackend()` (Agent Platform / Vertex), `getAI(app, { backend })`. `useLimitedUseAppCheckTokens` option exists. | ✅ |
| This Mac's Chrome 155: `chrome://on-device-internals` → performance class High, `prompt_api: Available`, Nano v3 GPU component Ready (4 GB), 12 GB VRAM. Chrome also lists `prompt_api_gemma4` / `_4b` / `_12b` use-cases as *Pending Usage* (fetched on first use). | ✅ observed |
| `generateContent(request, singleRequestOptions?)` / `generateContentStream(request, singleRequestOptions?)`: `SingleRequestOptions = RequestOptions & { signal?: AbortSignal }`; `RequestOptions.timeout` defaults to **180 s** and only covers the time **until the stream begins** (cleared once headers arrive). Abort/timeout surface as a `DOMException` named `AbortError`, which is **not** in `errorsCausingFallback` (`FETCH_ERROR`, `ERROR`, `API_NOT_ENABLED`), so `PREFER_IN_CLOUD` does not fall back on device after an abort. Source: `@firebase/ai/dist/esm/index.esm.js` (`makeRequest`, `callCloudOrDevice`). | ✅ source |
| **Live, 17 Nov (dev project, Gemini Developer API):** first real web round trip. Chrome Nano sealed the sample (~20–25 s incl. red-team); `gemini-3.8-flash` unary answered "Say hi" in 7 s; the same model's `streamGenerateContent` sometimes **returned 503 or sent no headers for >30 s**, while `gemini-3.5-flash-lite` streamed in 5 s. `gemini-2.5-flash` → 404 "no longer available to new users". Handled by the first-chunk guard + `model_cloud_fallback` chain (`web/src/ai/firebaseEngines.ts`). | ✅ observed |
| **On-device timings, 17 Nov (this Mac, Chrome 155, Nano v3 GPU):** trivial prompt ~0.9 s; `detect.v1` on the 260-char sample 10–12 s warm, ~22 s as the first long prompt after page load (~630 chars of JSON out ≈ 18 tok/s); `gen.v1` ~1.4 s each; `attack.v1` ~6 s. Concurrent prompts are **not** faster (3× `gen.v1`: 5.0 s parallel vs 4.3 s sequential) — the GPU serialises. `onDeviceParams.promptOptions.responseConstraint` (JSON schema) works but gave no speed-up. No temperature/topK control is exposed in `LanguageModelCreateOptions` (3.1.0). | ✅ observed |
| Web Remote Config (`@firebase/remote-config` 0.10.0): `getRemoteConfig`, `activate`, `fetchAndActivate`, `getAll` → `Value.getSource()` (`static`/`default`/`remote`) + `asString()`; `settings.minimumFetchIntervalMillis` / `fetchTimeoutMillis`. Cached in IndexedDB `firebase_remote_config`. Verified live 17 Nov: 29 keys fetched from the dev project. Needs `https://firebaseremoteconfig.googleapis.com` in the CSP `connect-src`. | ✅ typings + live |

## 7. Corrections log (vs. earlier planning chats)

1. Model Armor needs the **Agent Platform** backend (billing). It does not work with the free Gemini Developer API backend.
2. On-device structured output and tool calling exist but their iOS API is undocumented — do not design v1 around on-device tool calling.
3. The Google Cloud console trace content for AI requests is unconfirmed; our evidence of "only placeholders left the phone" comes from (a) our receipts, (b) the Model Armor/SDP logs, (c) the benchmark.
4. `firebase-ai-logic-basics` agent skill is written for web apps.
5. The TTS preview model in the TTS blog post retires on 17 Nov 2026.
6. **(16 Nov, from SDK source) The documented iOS hybrid API was removed in SDK 13.0.0.** `GenerativeModelSession`, `FirebaseAI.SystemLanguageModel`, `HybridModel` and `generativeModelSession(model:)` exist only in **12.13.0 – 12.19.0** (12.19.0 released 9 Sep 2026). 13.0.0 (7 Oct 2026) replaced them with `ai.geminiLanguageModel(name:) -> GeminiLanguageModel`, a Gemini model that conforms to Apple's `FoundationModels.LanguageModel` and is used with Apple's own `LanguageModelSession` (iOS/macOS 27, Swift ≥ 6.4). The official hybrid get-started page (checked 16 Nov) still shows the 12.x API. Latest release: 13.2.0 (13 Nov 2026). Decision pending — see `11-RISKS-AND-DECISIONS.md`.
7. **(16 Nov) `HybridModel` falls back on *any* first-turn error of the primary, not only when offline.** `HybridModelSession._respond` falls back if the primary session can't be created *or* the primary request throws (except cancellation), unless the primary session already has history. So cloud-first deep answers fall back to the phone on 429/503/Model Armor blocks too. Docs' "prefer in-cloud falls back only when offline" is not what 12.19.0 does.
8. **(16 Nov) Apple's on-device errors pass through unwrapped.** Context-window and guardrail errors arrive as Apple's `FoundationModels.LanguageModelSession.GenerationError`; matching them requires `import FoundationModels` in `AirlockEngines` (AGENTS.md currently forbids that import).

## 8. Verified in source (agents append here)

| Date | SDK version | Symbol | File | Notes |
|------|-------------|--------|------|-------|
| 16 Nov | 12.19.0 | `FirebaseAI.generativeModelSession(model: any LanguageModelProvider, tools: [any ToolRepresentable]? = nil, instructions: String? = nil) -> GenerativeModelSession` | `FirebaseAI/Sources/FirebaseAI.swift:152` | `instructions` **is** supported (resolves the 🔍 on system instructions). Overload taking `[any FoundationModels.Tool]` at :179 |
| 16 Nov | 12.19.0 | `LanguageModelProvider` statics: `.systemModel(useCase:guardrails:)`, `.geminiModel(name:safetySettings:requestOptions:)`, `.hybridModel(primary:secondary:)`; `String` conforms (model name) | `Protocols/Public/LanguageModelProvider.swift` | Both spellings exist: `HybridModel(primary:secondary:)` (takes `FirebaseAI.LanguageModel`) and `.hybridModel(...)` (takes providers) |
| 16 Nov | 12.19.0 | `FirebaseAI.SystemLanguageModel.default`, `.availability` → `.available` / `.unavailable(.deviceNotEligible / .appleIntelligenceNotEnabled / .modelNotReady / .unknown)`, `.isAvailable` | `Types/Public/SystemLanguageModel.swift` | Wraps `FoundationModels.SystemLanguageModel`; returns `.deviceNotEligible` where FM isn't supported |
| 16 Nov | 12.19.0 | `SystemLanguageModel.Guardrails.default` / `.permissiveContentTransformations` | `Types/Public/SystemLanguageModel.swift:140` | Permissive mode exists — use for detection/redaction prompts on sensitive text (R-05) |
| 16 Nov | 12.19.0 | `FirebaseAI.GenerationOptions(sampling: .greedy / .random(top:seed:) / .random(probabilityThreshold:seed:), temperature: Double?, maximumResponseTokens: Int?)` | `Types/Public/GenerationOptions.swift:143` | Greedy ✅, max tokens ✅ (resolves both 🔍) |
| 16 Nov | 12.19.0 | Options: `.gemini(GenerationConfig)`, `.foundationModels(FirebaseAI.GenerationOptions)`, `.hybrid(gemini:foundationModels:)` | `Protocols/Public/GenerationOptionsRepresentable.swift` | |
| 16 Nov | 12.19.0 | `session.respond(to:options:)`, `respond(to:generating:includeSchemaInPrompt:options:)`, `streamResponse(to:options:)` → `ResponseStream`; `Response.content / .rawContent / .rawResponse` | `GenerativeModelSession.swift` | **Structured output works on-device** via `generating:` (`@Generable`) — resolves 🔍; JSON-in-prompt stays as fallback |
| 16 Nov | 12.19.0 | On-device `rawResponse.modelVersion == "apple-foundation-models-system-language-model"` | `Extensions/Internal/LanguageModelSession+ModelSession.swift:175` | ✅ `ranOnDevice` derivation confirmed |
| 16 Nov | 12.19.0 | Stream snapshots are **cumulative** (Gemini session keeps cumulative state per chunk; FM snapshots are cumulative) | `Types/Internal/GeminiModelSession.swift:196` | Restorer uses `update(cumulative:)` |
| 16 Nov | 12.19.0 | `GenerativeModelSession.GenerationError`: `assetsUnavailable`, `decodingFailure`, `concurrentRequests`, `unsupportedPromptContent`, `internalError(_, underlyingError:)`, `invalidFunctionCall`, `maxFunctionCallTurnsExceeded` (`@nonexhaustive`) | `GenerativeModelSession.swift:712` | Unavailable system model throws `.assetsUnavailable` at session start |
| 16 Nov | 12.19.0 | Hybrid fallback rules (see Corrections 7) | `Types/Internal/HybridModelSession.swift` | Sticks to secondary once it has history; never falls back if primary has history |
| 16 Nov | 12.19.0 | `Backend.googleAI()`, `.vertexAI()`, `.vertexAI(location:)`, `.agentPlatform(location: = "global")` | `Types/Public/Backend.swift` | `vertexAI` removed in 13.0.0 — use `agentPlatform` |
| 16 Nov | 12.19.0 | `PromptFeedback.blockReason?.rawValue` is public (`String`); unknown values such as `MODEL_ARMOR` are preserved | `GenerateContentResponse.swift:405` | Used to map Model Armor blocks |
| 16 Nov | 12.19.0 | HTTP errors are an internal `BackendError: CustomNSError` with `errorCode == httpResponseCode`, domain `…BackendError` | `Types/Internal/Errors/BackendError.swift` | Mapped via `NSError.code` |
| 16 Nov | Xcode 27.2 SDK | Apple errors: `LanguageModelSession.GenerationError` (iOS 26; deprecated in 27: `exceededContextWindowSize`, `assetsUnavailable`, `guardrailViolation`, `unsupportedGuide`, `unsupportedLanguageOrLocale`, `decodingFailure`, `rateLimited`, `concurrentRequests`, `refusal`) and `LanguageModelError` (iOS 27: `contextSizeExceeded`, `rateLimited`, `guardrailViolation`, `refusal`, `unsupported…`, `timeout`) | `FoundationModels.swiftinterface` | Both mapped in `ErrorMapper` |
| 16 Nov | 12.19.0 | Built and linked against Xcode 27.2 / Swift 6.4.2 for macOS without errors | `swift build` | Resolves the "does 12.19 compile with Xcode 27" risk |
| 16 Nov | 13.2.0 | `FirebaseAI.geminiLanguageModel(name:) -> GeminiLanguageModel` (iOS/macOS 27, `compiler(>=6.4)`, `canImport(FoundationModels)`) | `Extensions/Public/FirebaseAI+GeminiLanguageModel.swift` | The 13.x replacement for the hybrid API; `GeminiLanguageModel` is its own SwiftPM target in the same repo |
