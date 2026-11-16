# 02 — Architecture

## 1. System overview

```
┌──────────────────────────────── iPhone / Mac ────────────────────────────────┐
│                                                                              │
│  SwiftUI App ──► Feature models (@Observable) ──► AirlockKit                 │
│                                                                              │
│  AirlockKit                                                                  │
│  ┌──────────┐   ┌───────────┐   ┌───────────┐   ┌────────────┐               │
│  │ Capture  │──►│  Detect   │──►│   Seal    │──►│ EgressGate │──► SealedText │
│  │ text/OCR │   │ vault     │   │ policy    │   │ (only way  │       │       │
│  │ /PDF     │   │ patterns  │   │ red-team  │   │  out)      │       │       │
│  └──────────┘   │ LLM ●     │   │ ●         │   └────────────┘       │       │
│                 └───────────┘   └───────────┘                        ▼       │
│  ● = PhoneOnlyEngine (Apple Foundation Models via Firebase AI Logic)  Router │
│                                                                   │          │
│        ┌──────────────────────┬───────────────────┬──────────────┤          │
│        ▼                      ▼                   ▼              ▼          │
│  PhoneFirstEngine       CloudFirstEngine     CloudOnlyEngine  ToolLoop       │
│  (quick tasks)          (deep answers)       (Proof+Search)   (function     │
│        │                      │                   │            calling)     │
│        └──────────────┬───────┴───────────────────┘              │          │
│                       ▼                                           │          │
│                  Restorer ◄── EntityVault (Keychain-encrypted map)┘          │
│                       │                                                      │
│                       ▼                                                      │
│              Answer (real names, local only) ──► Ledger (receipts, chain)    │
│                                                                              │
│  Local stores: SwiftData (.complete protection) · Keychain                   │
└──────────────────────────────────────────────────────────────────────────────┘
                 │ sealed text only                     │ sealed turns, receipts (hashes/counts)
                 ▼                                      ▼
┌─────────────────────── Google Cloud / Firebase ───────────────────────────────┐
│ Firebase AI Logic ─► Gemini (Developer API or Agent Platform)                 │
│                       └─ Model Armor floor setting (Agent Platform only)      │
│ App Check · Auth (anonymous/Google) · Remote Config · Firestore               │
│ Cloud Functions: aggregateStats (Firestore trigger), scanSealed (SDP callable)│
│ Cloud Logging (Armor logs, log-based metrics) · BigQuery (eval) · Cloud Run   │
│ Job (eval scorer) · Cloud Storage (eval artifacts) · Budget alerts            │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 2. Modules (Swift package `AirlockKit`)

| Module | Depends on | Responsibility | Imports Firebase? |
|--------|-----------|----------------|-------------------|
| `AirlockCore` | — | Value types: `RawText`, `SealedText`, `Entity`, `EntityMap`, `Category`, `Policy`, `Route`, `Receipt`, `AppConfig` protocol | No |
| `AirlockEngines` | Core | `PhoneOnlyEngine`, `PhoneFirstEngine`, `CloudFirstEngine`, `CloudOnlyEngine`, `ToolCapableEngine`; availability; `EngineResult`; mocks | **Yes (only module)** |
| `AirlockDetect` | Core, Engines | `VaultMatcher`, `PatternDetector`, `NLDetector` (flagged), `LLMDetector`, `Chunker`, `Merger`, `Coreference` | No |
| `AirlockSeal` | Core, Detect, Engines | `PolicyEngine`, `Generaliser`, `RedTeam`, `Sealer`, `EgressGate`, `SealPipeline` | No |
| `AirlockRestore` | Core | `Restorer` (streaming-safe), `PlaceholderParser` | No |
| `AirlockRoute` | Core, Seal, Restore, Engines | `Router`, `QuickTasks`, `DeepAnswer`, `ThreadContext` | No |
| `AirlockTools` | Core, Seal, Engines | Tool declarations, `ToolLoop`, `CalendarTool`, `EntityRoleTool`, `DateContextTool`, consent broker | No |
| `AirlockProof` | Core, Detect, Seal, Engines | `TacticScanner`, `ClaimExtractor`, `ClaimCheck` | No |
| `AirlockLedger` | Core | `ReceiptBuilder`, `HashChain`, `Stats` | No |

Rule: only `AirlockEngines` imports `FirebaseAILogic`. Everything else talks to protocols — which makes every module unit-testable with `MockEngines`, including on CI with no Apple Intelligence.

App target modules (folders): `Features/*`, `DesignSystem`, `Services` (`FirebaseBootstrap`, `RemoteConfigService`, `AuthService`, `SyncService`, `CalendarService`, `OCRService`, `PDFService`).

## 3. Core types (sketch — final names may differ, invariants may not)

```swift
// AirlockCore

/// User-provided text before sealing. Never leaves the device.
public struct RawText: Sendable, Hashable {
    package let value: String          // `package` access: visible inside AirlockKit only
    public let source: Source          // .paste, .photo, .pdf, .share
    public init(_ value: String, source: Source) { … }
}

/// Text that has passed the egress gate. The ONLY input type cloud engines accept.
public struct SealedText: Sendable, Hashable {
    public let value: String           // contains [[CATEGORY_n]] placeholders
    public let legend: [LegendLine]    // "[[PERSON_1]] — the user's landlord"
    public let gateReport: GateReport
    @_spi(EgressGate) public init(value: String, legend: [LegendLine], gateReport: GateReport)
    // Only AirlockSeal/EgressGate.swift may write `@_spi(EgressGate) import AirlockCore`
    // (lint + SealedTextConstructionTests). Not Decodable: stored sealed text must pass the gate again.
}

// Named PrivacyCategory (not Category) because Foundation's Objective-C runtime exports a `Category` type.
public enum PrivacyCategory: String, Sendable, CaseIterable, Codable {
    case person, org, location, contact, id, date, health, secret, quasi
}

public struct Entity: Sendable, Identifiable, Codable {
    public let id: String              // "PERSON_1"
    public let category: PrivacyCategory
    public var canonical: String       // "Raj Patel"
    public var surfaceForms: Set<String> // ["Raj Patel", "Dr. Patel", "Raj"]
    public var roleHint: String?       // "the user's landlord"
    public var action: Action          // .placeholder, .generalise(level), .keep, .block
    public var generalisedText: String? // "a large hospital"
    public var sources: Set<DetectorID>  // .vault, .pattern, .nl, .llm, .redteam, .user
    public var confidence: Confidence  // .high, .medium, .low
}

public enum Route: String, Codable, Sendable {
    case phoneOnly, phoneFirst, cloudFirst, cloudOnly
}

public struct EngineResult: Sendable {
    public let text: String
    public let modelVersion: String    // from rawResponse.modelVersion
    public let ranOnDevice: Bool       // modelVersion == "apple-foundation-models-system-language-model"
    public let latency: Duration
    public let blockedByArmor: Bool
}
```

Implementation notes (16 Nov, as built):

- **Spans are UTF-16 offsets** everywhere (`TextSpan`), so Swift, TypeScript and Kotlin agree on positions and they line up with `NSRange`.
- **Why `@_spi` and not `internal`:** `SealedText` lives in `AirlockCore` because engines (which must not depend on `AirlockSeal`) accept it, while only `AirlockSeal` may create it. An `internal` initializer can't cross that module boundary, and moving the type into `AirlockSeal` would create a Seal → Engines → Seal cycle.
- **Cross-platform conformance:** `spec/fixtures/*.json` (generated by `spec/tools/make_fixtures.py`, which computes check digits and hashes independently) are loaded by the Swift tests today and will be loaded by the web and Android tests. Pattern rules live in `AirlockDetect/PatternPacks/*.json` and use only regex features common to ICU, JavaScript and Java.

Type-level guarantees:

- `RawText.value` is `package`-scoped: the app target cannot read it except through `AirlockKit` APIs that keep it on device (display uses `RawText.displayString` which is fine — the view is local).
- Cloud-capable engine protocols take `SealedText` only. There is no overload taking `String`.
- `SealedText` has no public initializer. A unit test (`SealedTextConstructionTests`) scans module interfaces to assert that.

## 4. Engines

**As built (16 Nov):** the protocols below live in `AirlockCore/Engines.swift` (no Firebase), so Detect/Seal depend only on contracts; `AirlockEngines` implements them with Firebase AI Logic 12.19.0; `AirlockEngineMocks` implements them for tests and previews; prompts live in `AirlockPrompts`. `ModelPlan.plan(route:config:quality:)` is the single route → model table:

| Route | Model |
|-------|-------|
| phoneOnly | `.systemModel(guardrails:)` |
| phoneFirst | `.hybridModel(primary: .systemModel(), secondary: .geminiModel(model_cloud_quick))` |
| cloudFirst | `.hybridModel(primary: .geminiModel(deep \| max), secondary: .systemModel())` — note the SDK falls back on **any** first-turn cloud error, so every answer is labelled from `modelVersion` |
| cloudFirst + `armor_expected` | cloud only, manual phone retry **only when offline** (so a Model Armor block is shown) |
| cloudOnly | `.geminiModel(deep \| max)` |


```swift
public protocol PhoneOnlyEngine: Sendable {
    func respond(_ prompt: PhonePrompt, options: PhoneOptions) async throws(EngineError) -> EngineResult
    var availability: PhoneAvailability { get }
}

public protocol SealedEngine: Sendable {   // phoneFirst, cloudFirst, cloudOnly
    var route: Route { get }
    func respond(_ text: SealedText, task: TaskSpec, history: SealedHistory?) async throws(EngineError) -> EngineResult
    func stream(_ text: SealedText, task: TaskSpec, history: SealedHistory?) -> AsyncThrowingStream<EngineChunk, Error>
}

public protocol ToolCapableEngine: Sendable {
    func runToolLoop(_ text: SealedText, task: TaskSpec, tools: [ToolSpec],
                     executor: @Sendable (ToolCall) async -> ToolReply) async throws(EngineError) -> EngineResult
}
```

`PhonePrompt` is built from `RawText` or `SealedText` — phone-only is allowed to see both.

Firebase wiring (sketch — confirm against SDK, see `API-NOTES.md`):

```swift
// AirlockEngines/FirebaseEngines.swift
let ai = FirebaseAI.firebaseAI(backend: config.backend)          // .googleAI() or Agent Platform backend
let system = FirebaseAI.SystemLanguageModel.default

func cloud(_ name: String) -> some Model { ai.geminiModel(name: name) }

// phone only  (INV-3)
ai.generativeModelSession(model: system)
// phone first
ai.generativeModelSession(model: .hybridModel(primary: system, secondary: cloud(config.modelQuick)))
// cloud first
ai.generativeModelSession(model: .hybridModel(primary: cloud(config.modelDeep), secondary: system))
// cloud only
ai.generativeModelSession(model: cloud(config.modelDeep))
// tools / search (classic API)
ai.generativeModel(modelName: config.modelDeep, tools: [...], systemInstruction: ...)
```

Each call creates a new session (INV-4) unless it is a sealed multi-turn thread, where the engine replays `SealedHistory` into a fresh session.

## 5. Routing

| Task | Input | Route | Why this route | Fallback behaviour |
|------|-------|-------|----------------|--------------------|
| Detect entities | Raw | phoneOnly | Raw text may only be seen on device | Unavailable → rules + mandatory review |
| Red-team attack | Sealed draft (pre-gate) | phoneOnly | Draft may still contain cues | Skip loop; force review; show "red-team unavailable" |
| Generalise phrase | Raw fragment | phoneOnly | | Use category ladder text |
| Thread title | Sealed | phoneOnly | Free, instant | Use first 5 words |
| Quick tasks (summary, explain, actions, tone) | Sealed | phoneFirst | Free + instant; cloud if phone can't | Phone unavailable → cloud on sealed text (fine) |
| Deep answer / draft reply | Sealed | cloudFirst | Needs the strongest model | Offline → phone answers, labelled "offline answer" |
| Long docs > on-device limit | Sealed | cloudOnly | Exceeds 4,096 tokens on device | Offline → summarise per chunk on device |
| Private tools | Sealed | cloudOnly (tool loop) | Function calling | Offline → disabled |
| Proof tactics | Raw | phoneOnly | Scam message may include user's data | Rules-only tactics |
| Proof claim check | Sealed claims | cloudOnly + Search | Search grounding is cloud-only | Offline → tactics verdict only |
| "What can the cloud guess?" | Sealed | cloudOnly | Must be the same kind of model that received the text | Offline → disabled |

User override (Settings → Answers): **Auto** (table above), **Phone only** (never call cloud; deep answers become phone answers), **Best quality** (deep tasks use `model_cloud_max`).

## 6. Main flows

### 6.1 Ask (deep answer)

```
User      App/AskModel       SealPipeline            EgressGate   Router/CloudFirst   Restorer   Ledger
 │ paste ─► capture(Raw)
 │          ├─► seal(raw, policy) ──► vault+patterns+LLM detect (phoneOnly)
 │          │                        merge, coref, policy, sealDraft
 │          │                        redTeam(draft) (phoneOnly, ≤2 rounds)
 │          │◄── ReviewModel(draft, risks)
 │ review ─►│ (toggle chips, accept suggestions)
 │ Seal&Send►── finalize ───────────────────────────► gate(draft) → SealedText | GateBlocked
 │          ├────────────────────────────────────────────────────► stream(sealed, task)
 │          │◄────────────────────────── chunks ─────────────────── (modelVersion)
 │          ├──────────────────────────────────────────────────────────────────► restore(chunk)
 │◄ answer (real names, route badge)
 │          └──────────────────────────────────────────────────────────────────────────► receipt
```

### 6.2 Quick task

Same seal path; Router picks phoneFirst. If `modelVersion` is on-device, badge says "On this iPhone · Nothing sent". If the SDK fell back to cloud, badge says "Gemini (phone couldn't handle this)" and a receipt is created (receipts exist only when something left the phone).

### 6.3 Tool loop (draft reply needing calendar)

```
CloudOnly(tools) ─► functionCall find_free_slots(start,end)
ToolLoop ─► ConsentBroker ─► UI ToolConsentCard ("Gemini asked for your free times next week. Share 2 slots?")
user Allow ─► CalendarTool (EventKit) ─► ["Tue 3:00–4:00 pm", "Thu 10:00–11:00 am"]
ToolLoop ─► EgressGate.seal(tool result) ─► functionResponse ─► model ─► final text ─► Restorer
```

Denied consent returns `{"error":"user_declined"}` and the model must continue without it.

### 6.4 Proof

```
Raw message ─► TacticScanner (patterns + phoneOnly LLM) ─► flags
            ─► ClaimExtractor (phoneOnly) ─► claims (raw) ─► SealPipeline (auto, Strict) ─► SealedText
            ─► ClaimCheck (cloudOnly + googleSearch) ─► verdict + sources ─► Restorer ─► VerdictCard
```

### 6.5 Offline

Router observes `NWPathMonitor`. Offline: deep answers go cloudFirst anyway (the SDK falls back to phone when offline), UI shows the offline banner, tool loop and Proof check are disabled with explanation, quick tasks work normally.

## 7. Data storage

**As built (16 Nov):** raw captures, entity maps and the Vault are implemented in `AirlockStore` as AES-256-GCM encrypted records (`EncryptedFileStore`, `AirlockStores`) rather than SwiftData rows — see the decision log. The table below still describes *what* is stored where; "SwiftData" there now reads "encrypted record".


| Data | Where | Protection | Synced? |
|------|-------|-----------|---------|
| Raw captures | SwiftData `CaptureRecord` | File protection `.complete`; deletable; auto-purge after N days (setting, default 30) | Never |
| Entity map per thread | SwiftData blob encrypted with AES-GCM, key in Keychain (`ThisDeviceOnly`) | | Never |
| Vault (always-protect entries) | Same as entity map; Face ID gate to view | | Never |
| Sealed turns | SwiftData + Firestore | Owner-only rules, forbidden-key + pattern rules | Opt-in (default on) |
| Restored answers | Memory + SwiftData (local) | `.complete` | Never |
| Receipts | SwiftData + Firestore (hashes + counts + sealed text hash, not raw) | Create-only rules | Opt-in |
| Settings | UserDefaults (non-sensitive) | | No |
| Remote Config cache | SDK | | — |

Because the entity map never syncs, a sealed thread opened on another device shows placeholders as chips with role hints ("your landlord"). That's a feature: it proves the cloud copy is sealed.

## 8. Concurrency

- `SealPipeline`, `Router`, `ToolLoop`, `Ledger` are actors.
- Feature models are `@MainActor @Observable`.
- On-device calls are serialised through one `PhoneQueue` actor (the on-device model handles one request at a time well; parallel calls queue anyway and complicate cancellation).
- Chunks are detected sequentially with progress reporting (UI shows "Reading section 2 of 4").
- Cancellation: every pipeline step checks `Task.isCancelled`. If the app goes to background (on-device only runs in foreground), pause on-device steps and resume on `scenePhase == .active`.

## 9. Error taxonomy

| Error | Source | User sees | Recovery |
|-------|--------|-----------|----------|
| `PhoneAvailability.notEligible` | Device | "This device can't run Apple's on-device model. Airlock will use strict rules and ask you to review everything." | Rules + mandatory review |
| `.appleIntelligenceOff` | Device | Banner with steps to turn it on | Deep link to Settings where possible |
| `.modelNotReady` | Device | "Apple's model is still downloading." | Rules-only meanwhile |
| `EngineError.contextTooLong` | Phone | (invisible) | Chunker shrinks budget, retries |
| `EngineError.refused` | Phone guardrail | "Apple's on-device model declined to read part of this. Please review that section yourself." Section highlighted | Rules-only for that chunk + forced review |
| `EngineError.parse` | Detector JSON | (invisible) | One repair retry, then rules + review |
| `GateBlocked(hits)` | Egress gate | Review screen reopens with the offending spans highlighted coral | User fixes |
| `EngineError.armorBlocked` | Model Armor | "Google's safety check stopped this request — something identifying may have slipped through." | Back to review |
| `EngineError.quota/429/503` | Cloud | "Gemini is busy. Trying again…" | Exponential backoff ×3, then offer phone answer |
| `EngineError.offline` | Network | Offline banner | Phone path |
| `AppCheckError` | App Check | Dev: debug-token instructions. Prod: generic error | |

## 10. Architecture decisions (ADR log)

| ADR | Decision | Reason |
|-----|----------|--------|
| ADR-01 | Placeholders use `[[CATEGORY_n]]` | Rare in natural text; easy to regex; models preserve double brackets better than single in our tests (verify in eval) |
| ADR-02 | Generalise rather than delete; legend lines carry role hints | PAPILLON showed redaction kills quality; role hints keep the task solvable |
| ADR-03 | Raw text only in phone-only sessions; never a HybridModel | A hybrid session can fall back to cloud silently — unacceptable for raw text |
| ADR-04 | Deterministic egress gate after all LLM steps | LLMs are probabilistic; the last line must be deterministic and testable |
| ADR-05 | Model Armor is a second net, not the first | It fails open and covers only `generateContent`; we can't depend on it |
| ADR-06 | No on-device tool calling in v1 | iOS API undocumented; cloud tool calling is documented and enough |
| ADR-07 | XcodeGen project | Agents edit YAML safely; pbxproj merges are a disaster |
| ADR-08 | Only `AirlockEngines` imports Firebase AI | Testability on CI; SDK churn contained in one module |
| ADR-09 | Entity map never syncs | Smallest possible blast radius if the cloud account is compromised |
| ADR-10 | One app target, iOS + macOS | Second platform for near-zero cost; judges favour multi-platform |
