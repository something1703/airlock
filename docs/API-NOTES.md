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
| Google Search grounding: `tools: [.googleSearch()]`; response carries grounding metadata. Search grounding has **display requirements** (show search suggestions/attribution as specified in Firebase docs). | ✅ web API verified (§6b); 🔍 iOS/Android spelling |
| **Search display rules** (checked 18 Nov: Firebase "Grounding with Google Search" page, Gemini API terms §"Grounding with Google Search", Google Cloud "Search suggestions" display requirements — they say the Cloud rules apply to the Developer API too): (1) a response is a *Grounded Result* only if it has `groundingMetadata`/`searchEntryPoint`; (2) **Search Suggestions are required**: render `searchEntryPoint.renderedContent` (HTML+CSS) **exactly as provided** — no changes to colour, font or look; it adapts to light/dark itself via `prefers-color-scheme`; (3) it must stay **visible whenever its grounded answer is shown**, and the chip area must be **as wide as the grounded answer**; (4) a tap goes **directly** to the Google results page (in-app or separate browser), **no interstitial**, no obstruction; (5) **sources are required**: show `groundingChunks[].web` (title + uri) as recognisable, clickable links, with grounding support **inline and in aggregate** (`groundingSupports[].segment` → `groundingChunkIndices`); (6) don't show other search results/suggestions next to it, and don't mix other content into Grounded Results; (7) show them only to the end user who asked; don't cache/store them beyond chat history, no click tracking on them. | ✅ docs |
| How Airlock (web) meets them: one grounded call per sealed claim; each claim's answer is shown with its own numbered sources (inline superscripts from `groundingSupports` + a source list) and its `renderedContent` mounted unmodified in an open **shadow root** at the claim block's full width (`web/src/ui/searchEntryPoint.ts`: only scripts/frames/`on*` handlers/non-http links are stripped — nothing visual; anchors get `target=_blank rel=noopener`, i.e. straight to Google in a new tab). Proof results live in memory only (never stored or synced). The family share warning is built from fixed phrases, never from grounded text. | ✅ implemented (WP-18) |
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
| **Function calling (WP-17), `ai-public.d.ts` 3.1.0:** `ModelParams`/`StartChatParams` take `tools?: Tool[]` (`FunctionDeclarationsTool = { functionDeclarations?: FunctionDeclaration[] }`, max 64) and `toolConfig?: { functionCallingConfig?: { mode?: FunctionCallingMode.AUTO \| ANY \| NONE, allowedFunctionNames? } }`. `FunctionDeclaration = { name, description, parameters?: ObjectSchema \| ObjectSchemaRequest, functionReference?: Function }`; `ObjectSchemaRequest` is plain JSON (`type: 'object'`, `properties`, `required`). `GenerativeModel.startChat(params?) → ChatSession` with `sendMessage` / `sendMessageStream(request: string \| Array<string \| Part>, singleRequestOptions?)` and `getHistory()`. `EnhancedGenerateContentResponse.functionCalls(): FunctionCall[] \| undefined` (`FunctionCall = { id?, name, args: object }`). Responses go back as `FunctionResponsePart = { type: 'functionResponse', functionResponse: { id?, name, response: object, parts? } }` — **3.1.0 parts carry a client-side `type` discriminator**, stripped before the wire (`stripPartType`). | ✅ typings |
| **Function calling, from `dist/esm/index.esm.js` 3.1.0:** (1) `ChatSession` runs a tool **automatically only if every requested function has a `functionReference`** (`_getCallableFunctionCalls`, up to `maxSequentialFunctionCalls` = 10); we never set one, so calls come back to our code (consent + egress gate first). (2) A message may not mix function responses with other parts (`assignRoleToPartsAndValidateSendMessageRequest` throws). (3) **Requests containing a `functionResponse` part are never sent on device** (`ChromeAdapterImpl.isOnDeviceRequest` → false), so the tool loop is `ONLY_IN_CLOUD`. (4) Chat history stores the model's raw parts via `deepCopy` (streamed turns via `aggregateResponses`, which copies whole parts), so **Gemini 3 thought signatures survive into the next turn** — use `ChatSession`, not hand-built `contents`. (5) In hybrid mode `tools`/`toolConfig`/`systemInstruction` go inside `inCloudParams`; top-level keys are ignored with a warning. | ✅ source |
| **Live, 18 Nov (dev project, Gemini Developer API):** "Propose a meeting time" on the fictional sample + sample calendar: Gemini called `today_context`, then (second round, same `ChatSession`) `find_free_slots`; both consent cards shown and allowed; the draft named two real free slots. Answered by the fallback `gemini-3.5-flash-lite` in 43 s incl. two consent waits (the deep model failed transiently or stalled before its first turn), so multi-turn function calling over `sendMessageStream` works together with the fallback chain. Whether `FunctionCall.id` is set on the Developer API was not inspected (typings say it may be `undefined`; we echo it only when present). | ✅ observed |

| **Google Search grounding (web, `@firebase/ai` 3.1.0 typings + source):** `Tool = FunctionDeclarationsTool \| GoogleMapsTool \| GoogleSearchTool \| CodeExecutionTool \| URLContextTool`; `GoogleSearchTool = { googleSearch: GoogleSearch }` where `GoogleSearch` is an empty object. With hybrid params the tool goes in `inCloudParams.tools` (`ModelParams.tools`); `GenerativeModel` stores `modelParams.tools` and sends them in every `generateContent`/`generateContentStream` body. `ONLY_IN_CLOUD` → `callCloudOrDevice` always calls the cloud (never Chrome's model). Verified by a unit test that stubs `fetch`: the request to `models/<proof model>:generateContent` carries `"tools":[{"googleSearch":{}}]` (`web/tests/ai.test.ts`). | ✅ typings + source + test |
| Grounding metadata (web): `response.candidates[0].groundingMetadata?: GroundingMetadata` = `{ searchEntryPoint?: { renderedContent?: string }, groundingChunks?: { web?: { uri?, title?, domain? }, maps? }[], groundingSupports?: { segment?: { partIndex, startIndex, endIndex, text }, groundingChunkIndices?: number[] }[], webSearchQueries?: string[], googleMapsWidgetContextToken? }`. `segment.startIndex/endIndex` are **UTF-8 byte** offsets, so Airlock matches `segment.text` instead. `WebGroundingChunk.domain` is Agent-Platform-only (undefined on the Developer API). The typings recommend embedding `renderedContent` in a **shadow DOM** (`attachShadow({mode:'open'}).innerHTML = …`). The SDK copies `groundingMetadata` through unchanged (`mapGenerateContentCandidates`, and aggregated per candidate for streams). | ✅ typings + source |
| **Live, 18 Nov (dev project, Developer API):** Proof on the web with Chrome Nano: `tactics.v1` + claim sealing ran on device (~20 s; the date in a claim was generalised before sending); the grounded claim check returned **HTTP 429 from both `gemini-3.8-flash` and `gemini-3.5-flash-lite`** (7 requests for one claim with the old 3-retry policy) — most likely the project's Search-grounding quota/billing, not a blip. Claim checks now retry once per model. Needs a human to check grounding quota/billing in the console before a live Proof demo. No grounded response has been seen live yet, so `renderedContent` rendering is verified only with fixtures. | ⚠ observed |
| **AirlockBench under Node (18 Nov, read in source, not run):** App Check debug mode reads `FIREBASE_APPCHECK_DEBUG_TOKEN` from `getGlobal()` (`@firebase/util`: `self` → `window` → `global`), so under Node setting `globalThis.FIREBASE_APPCHECK_DEBUG_TOKEN = "<token>"` before `initializeAppCheck` enables it (`@firebase/app-check@0.13.1` `initializeDebugMode`). In debug mode the SDK **prints the debug token with `console.log`** — never paste that output anywhere public. `CustomProvider.initialize()` is a no-op, so it satisfies `initializeAppCheck` without a DOM (ReCaptcha providers need one). `GenerationConfig.temperature` exists (`ai-public.d.ts`); `FirebaseEngines.model()` now passes it through for `judge.v1`. Whether `@firebase/ai` cloud calls work end to end from Node is **unverified** — check on the first permitted live run. Code: `web/bench/live.ts` (`connectLive`). | 🔍 source only |
| Web Remote Config (`@firebase/remote-config` 0.10.0): `getRemoteConfig`, `activate`, `fetchAndActivate`, `getAll` → `Value.getSource()` (`static`/`default`/`remote`) + `asString()`; `settings.minimumFetchIntervalMillis` / `fetchTimeoutMillis`. Cached in IndexedDB `firebase_remote_config`. Verified live 17 Nov: 29 keys fetched from the dev project. Needs `https://firebaseremoteconfig.googleapis.com` in the CSP `connect-src`. | ✅ typings + live |

| **Cut-off answers (20 Nov, `@firebase/ai@3.1.0` `ai-public.d.ts`):** each candidate has `finishReason?: FinishReason`; `FinishReason.MAX_TOKENS` = `"MAX_TOKENS"` means the reply hit `maxOutputTokens`. Streamed chunks carry candidates too, so the last chunk shows it. `GenerationConfig.thinkingConfig` has `thinkingBudget` (0 = off, -1 = dynamic) and `thinkingLevel`; setting both errors, and Gemini 2.5 models reject `thinkingLevel`. Observed live on 20 Nov: a 1,500-token limit cut a ~600-word answer mid-sentence on a Gemini 3.x Flash model, consistent with reasoning tokens counting against `maxOutputTokens` (not confirmed in docs). We raised limits (deep answers 8,192, quick 1,024, `infer.v1` 4,096) instead of changing thinking settings, and surface `truncated` with a Continue action. Code: `web/src/ai/firebaseEngines.ts`, `web/src/engine/answer.ts`. | ✅ source + live |

## 6c. Android SDK facts (verified 17 Nov in source jars: `firebase-ai` 18.2.0 (BoM 35.2.0), `firebase-ai-ondevice` 16.0.0-beta08)

| Fact | Status |
|------|--------|
| Hybrid lives in the main SDK: `FirebaseAI.generativeModel(modelName, generationConfig?, safetySettings?, tools?, toolConfig?, systemInstruction?, requestOptions, onDeviceConfig: OnDeviceConfig)` (`FirebaseAI.kt:106`). On-device inference needs the extra artifact `firebase-ai-ondevice` (beta only), which pulls ML Kit `genai-prompt` 1.0.0-beta5; without it, on-device modes resolve to `MissingOnDeviceGenerativeModelProvider`. | ✅ source |
| `OnDeviceConfig(mode, maxOutputTokens?, temperature?, topK?, seed?, candidateCount = 1, modelOption?, enableThinking?)` — `@PublicPreviewAPI`. **Unlike web, temperature/topK/seed are settable on device** (use greedy-ish settings for detection). | ✅ `OnDeviceConfig.kt:40` |
| `InferenceMode.PREFER_ON_DEVICE / PREFER_IN_CLOUD / ONLY_ON_DEVICE / ONLY_IN_CLOUD` (class with companion constants, not an enum). | ✅ |
| **Fallback semantics differ from iOS:** `PREFER_ON_DEVICE` → on-device, falls back to cloud on any exception. `PREFER_IN_CLOUD` → cloud, falls back on device **only if the device is offline** (`NetworkStatusChecker` precondition; `shouldFallbackInException = false`), i.e. a 503 does NOT fall back. Our model fallback chain (`model_cloud_fallback`) therefore matters on Android too. | ✅ `GenerativeModel.kt:384-405` |
| `GenerativeModel.onDeviceExtension: OnDeviceExtension?` → `suspend checkStatus(): OnDeviceModelStatus` (`UNAVAILABLE / DOWNLOADABLE / DOWNLOADING / AVAILABLE`), `download(): Flow<DownloadStatus>` (`DownloadStarted(bytesToDownload)`, `DownloadInProgress(totalBytesDownloaded)`, …), `suspend warmUp()`, `suspend getModelName()`. | ✅ `GenerativeModel.kt:454` |
| `GenerateContentResponse.inferenceSource: InferenceSource` (`ON_DEVICE` / `IN_CLOUD`) and `modelVersion: String?` (on-device responses report `"ondevice"`). | ✅ `type/GenerateContentResponse.kt` |
| `FirebaseAIException` subclasses: `ServerException` exposes **no HTTP status** — Airlock classifies it by message text (503/429/"overloaded" → transient) in `android/app/.../engines/ErrorMapper.kt`, never surfacing the message (INV-8). | ✅ source; ⚠ message-based |
| ML Kit `genai-prompt` stream chunks are treated as **deltas** (accumulated by Airlock). Not yet verified on Nano hardware (the emulator has no AICore). | 🔍 verify on a real device / Test Lab |
| Live, 17 Nov (API 36 emulator, dev project): on-device status UNAVAILABLE (no AICore) → rules + forced review (INV-9); sealed text answered by Gemini via Firebase AI Logic; `gemini-3.8-flash` stalled past the 15 s first-chunk guard → fallback chain answered with `gemini-3.5-flash-lite` (27.7 s). App Check debug token unregistered → 403 attestation logged but requests succeed (not enforced). | ✅ observed |

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

## FX-02 timing notes (22 Nov)

What the seal's time is made of, and where the numbers stand. **Nothing here is a live measurement on a real on-device model yet** — that run is still to do (protocol below); the figures marked *estimate* are arithmetic on the measured Chrome rate, not timings.

| What | Value | Basis |
|------|-------|-------|
| Vault + pattern rules (`rulesMs`) | under 10 ms (shows as 0.0 s) | Measured in the web demo engine, where the rules are the real ones. Highlights appear on the sealing screen at once (about 0.3 s including page render), against a target of 300 ms |
| Chrome on-device output rate | about 18 tokens/s | 17 Nov measurement above (`detect.v1`, Nano v3 GPU) |
| `detect.v1` reply for the 77-word fictional heater message (9 items) | about 297 output tokens ≈ 16.5 s, plus 3 sequential `gen.v1` calls (~1.4 s each, measured 17 Nov) | *Estimate*: reply built by hand in the exact `detect.v1` format, tokens at chars/3.2 (the app's own estimate) |
| `detect.v2` reply for the same message | about 94 output tokens ≈ 5.2 s, including the 3 general phrases; the phone and email hits are masked in the prompt, so they are not written back; no `gen.v1` calls | *Estimate*, same method |
| Net | ≈ 22 s → ≈ 5 s of output-bound time for detection and generalising, before the red-team check and prompt-processing time | *Estimate*. The new prompt is longer (rules and an example), so prompt processing rises a little; Nano prefill is fast but unmeasured |

Two things that do **not** help, measured on 17 Nov: running prompts in parallel (the GPU serialises them) and `responseConstraint` (no speed-up).

**Live check still to do** (needs desktop Chrome with Gemini Nano; fictional data only). Run `npm run dev` in `web/`, open `http://localhost:5173/?detect=v1` and then `?detect=v2` (the switch exists in dev builds only), pick **Help me with this**, seal the 77-word message, and read the **Timing** disclosure on Review. Do it twice per prompt (the first run after page load is cold). Record: time to Review, rows per stage, details protected, any name `detect.v2` misses that `detect.v1` finds, and the phrases it writes. Also try **Summarise**: the button should read "Answer on this device" and the answer should arrive with no Review screen. `detect_prompt_id` stays `detect.v1` until this is recorded here.
