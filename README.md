# Airlock

**The best AI, without giving yourself away.**

Airlock is an iOS app (with a Mac build from the same code) that lets people get help from frontier cloud AI with their most private material — a tense message thread, a lease, a hospital bill, an HR complaint — while the details that identify them stay on their phone.

A small model you own (Apple's on-device Foundation Model, reached through Firebase AI Logic) supervises a big model you rent (Gemini in the cloud):

1. **Seal** — the phone finds names, places, employers, contact details, IDs and secrets, and swaps them for placeholders like `[[PERSON_1]]`.
2. **Red-team** — the phone then attacks its own output ("from this, could someone guess who wrote it?") and generalises what would still give the user away.
3. **Gate** — a deterministic check proves no known identifier is left before anything leaves the device. Google's Model Armor stands behind it as a second net.
4. **Ask** — only the sealed text goes to Gemini. Gemini can ask the phone for facts (e.g. free calendar slots) through private tools, without seeing the underlying data.
5. **Restore** — the phone puts the real details back into the answer, locally.
6. **Prove** — every request gets a tamper-evident receipt showing exactly what left the phone.

Built for **#BuildHybridAI 2026** (Firebase AI Logic hybrid inference). Platform: **iOS** (Apple Foundation Models via Firebase AI Logic), plus macOS.

---

## Documentation map (read in this order)

| # | File | What it covers | Who reads it |
|---|------|----------------|--------------|
| — | [`AGENTS.md`](AGENTS.md) | Rules every coding agent must follow. Non-negotiable invariants. | Every agent, every session |
| — | [`docs/API-NOTES.md`](docs/API-NOTES.md) | Verified SDK facts vs. things still to verify. Corrections log. | Before touching any Firebase call |
| 01 | [`docs/01-PRODUCT.md`](docs/01-PRODUCT.md) | Problem, users, features (with IDs and priorities), non-goals | Everyone |
| 02 | [`docs/02-ARCHITECTURE.md`](docs/02-ARCHITECTURE.md) | Modules, types, routing, sequence flows, decisions | Engine + app agents |
| 03 | [`docs/03-PRIVACY-ENGINE.md`](docs/03-PRIVACY-ENGINE.md) | The seal pipeline in full detail: detect, merge, policy, red-team, gate, restore | Privacy-engine agents |
| 04 | [`docs/04-PROMPTS.md`](docs/04-PROMPTS.md) | Every prompt and output schema, versioned | Engine + eval agents |
| 05 | [`docs/05-FIREBASE-AND-GCP.md`](docs/05-FIREBASE-AND-GCP.md) | Projects, App Check, Auth, Firestore schema + rules, Remote Config, Functions, Model Armor, SDP, BigQuery | Cloud agents |
| 06 | [`docs/06-UI-UX.md`](docs/06-UI-UX.md) | Design system, every screen, states, motion, copy, accessibility | UI agents |
| 07 | [`docs/07-EVALUATION.md`](docs/07-EVALUATION.md) | Benchmark harness, datasets, metrics, ablations, report format | Eval agents |
| 08 | [`docs/08-BUILD-PLAN.md`](docs/08-BUILD-PLAN.md) | Work packages with acceptance criteria, day-by-day schedule, lanes | Humans assigning work |
| 09 | [`docs/09-TESTING.md`](docs/09-TESTING.md) | Unit, property, integration, UI, accessibility, performance tests | Every agent |
| 10 | [`docs/10-SUBMISSION.md`](docs/10-SUBMISSION.md) | Devpost checklist, description draft, video storyboard and script | Humans |
| 11 | [`docs/11-RISKS-AND-DECISIONS.md`](docs/11-RISKS-AND-DECISIONS.md) | Risk register, open questions, decision log | Humans |

---

## Key dates (IST = UTC+05:30)

| When | What |
|------|------|
| Mon 16 Nov | Day 1. Repo bootstrap + **API verification spike** (see `docs/08-BUILD-PLAN.md`) |
| Tue 17 Nov | Ask rule questions in the hackathon Discord (`#hackathon-help`) — see `docs/11-RISKS-AND-DECISIONS.md` |
| Wed 18 Nov | **Go/no-go**: on-device detector quality check on 30 synthetic docs |
| Sun 29 Nov, 23:59 | **Code freeze.** Video uploaded to YouTube (processing can take hours) |
| Mon 30 Nov, evening | Submit on Devpost |
| Tue 1 Dec, 03:30 | **Hard deadline** (Mon 30 Nov, 2:00 PM PT). Commits after this are not evaluated |
| 10–16 Dec | Judging. Firebase project and repo must stay live and free to test |

---

## Repo layout (target)

```
airlock/
├── AGENTS.md  CLAUDE.md  GEMINI.md  README.md  LICENSE (Apache-2.0)
├── project.yml                     # XcodeGen spec — the .xcodeproj is generated, never hand-edited
├── App/                            # SwiftUI app (iOS + macOS multiplatform target)
│   ├── AirlockApp.swift
│   ├── Features/{Onboarding,Ask,Review,Thread,Receipt,Ledger,Vault,Proof,Settings,Evidence}/
│   ├── DesignSystem/               # tokens, components
│   └── Resources/                  # Assets, Localizable.xcstrings, bundled prompts
├── Packages/AirlockKit/            # all logic, UI-free, fully unit-tested
│   ├── Sources/AirlockCore/        # types: RawText, SealedText, Entity, Policy, Receipt, Route
│   ├── Sources/AirlockDetect/      # vault matcher, pattern detectors, LLM detector, merger
│   ├── Sources/AirlockSeal/        # policy engine, sealer, red-team loop, egress gate
│   ├── Sources/AirlockRestore/     # streaming-safe restorer
│   ├── Sources/AirlockEngines/     # Firebase AI Logic wrappers (phone/cloud/hybrid), mocks
│   ├── Sources/AirlockRoute/       # router, task definitions
│   ├── Sources/AirlockTools/       # private tools (calendar, vault role, date context)
│   ├── Sources/AirlockProof/       # scam-check pipeline
│   ├── Sources/AirlockLedger/      # receipts, hash chain, stats
│   └── Tests/...
├── Bench/AirlockBench/             # macOS app: synthetic data, runs the real pipeline, exports results
├── firebase/                       # firebase.json, firestore.rules, indexes, remoteconfig.template.json
├── functions/                      # Cloud Functions (TypeScript): stats aggregation, SDP scan callable
├── eval/                           # Cloud Run scorer (Python), BigQuery schemas, reports/
├── scripts/                        # bootstrap.sh, gen.sh (xcodegen), test.sh, lint.sh
├── demo-samples/                   # fictional texts for judges and the video (never real data)
└── docs/
```

---

## Where Firebase AI Logic is used (for judges)

This table is kept current by agents (see `AGENTS.md` §10). Paths point to real code.

Firebase AI Logic iOS SDK **12.19.0** (the release with the documented `HybridModel` API — see `docs/API-NOTES.md` §7). Every call goes through `Packages/AirlockKit/Sources/AirlockEngines/`, the only module that imports `FirebaseAILogic`.

| Capability | Inference mode | Firebase AI Logic call | File |
|-----------|----------------|------------------------|------|
| Entity detection on raw text (`detect.v1`) | On-device only | `generativeModelSession(model: .systemModel(guardrails: .permissiveContentTransformations))` | `AirlockEngines/FirebaseEngines.swift` (`FirebasePhoneEngine`), used by `AirlockDetect/LLMDetector.swift` |
| Generalising phrases on raw text (`gen.v1`) | On-device only | same phone-only session | `AirlockSeal/SealPipeline.swift` |
| Red-team attack (`attack.v1`) | On-device only | same phone-only session | `AirlockSeal/RedTeam.swift` *(next WP)* |
| Quick tasks on sealed text | On-device first, cloud fallback | `.hybridModel(primary: .systemModel(), secondary: .geminiModel(...))` | `AirlockEngines/ModelPlan.swift`, `FirebaseEngines.swift` (`FirebaseSealedEngine`) |
| Deep answers on sealed text (streaming) | Cloud first, on-device fallback | `.hybridModel(primary: .geminiModel(...), secondary: .systemModel())`, `streamResponse` | same |
| Private tools (function calling) | Cloud only | `generativeModel(modelName:tools: [.functionDeclarations])` + `Chat` | `AirlockEngines/ToolAndSearchEngines.swift` (`FirebaseToolEngine`) |
| Fact check with Google Search | Cloud only | `generativeModel(modelName:tools: [.googleSearch()])` | `AirlockEngines/ToolAndSearchEngines.swift` (`FirebaseSearchEngine`) |
| Conversation titles from the **sealed** first message (`title.v1`) | On-device only | same phone-only session | `AirlockRoute/ThreadTitler.swift`, called from `App/Features/Session/AirlockSession.swift` |
| Which model answered | — | `response.rawResponse.modelVersion` | `AirlockCore/Route.swift` (`EngineResult.ranOnDevice`) |
| Phone model availability | — | `FirebaseAI.SystemLanguageModel.default.availability` | `AirlockEngines/ErrorMapper.swift` |

The iOS/macOS app (`App/`) never calls Firebase AI Logic directly: `App/Services/AppServices.swift` creates `FirebaseEngines` (live) or scripted demo engines (`-demo`, the Demo scheme, or no Firebase config), and `App/Features/Session/AirlockSession.swift` drives `SealPipeline` → `EgressGate` → `AnswerService`.

**Web app** (`web/`, `firebase@13.3.0`): every call is in `web/src/ai/firebaseEngines.ts`, the only web file that imports `firebase/ai` (lint-enforced).

| Capability | Inference mode | Firebase AI Logic call | File |
|-----------|----------------|------------------------|------|
| Detection, generalising, red-team on raw text | `InferenceMode.ONLY_ON_DEVICE` (Chrome Gemini Nano) | `getGenerativeModel(ai, { mode })`, `generateContent` | `FirebasePhoneEngine` |
| Preparing Chrome's model (user click) | `ONLY_ON_DEVICE` | `initializeDeviceModel(onProgress)` | `FirebaseEngines.initializeOnDevice` |
| Quick tasks on sealed text | `PREFER_ON_DEVICE` | `generateContentStream` | `FirebaseSealedEngine` |
| Deep answers on sealed text | `PREFER_IN_CLOUD` / `ONLY_IN_CLOUD`, model fallback chain | `generateContentStream(text, { signal, timeout })`, unary last resort | `FirebaseSealedEngine.stream` |
| Which side answered | — | `response.inferenceSource` (`on_device` / `in_cloud`) | `FirebaseSealedEngine` |

**Other Firebase services** (not AI calls, listed for completeness): Remote Config (`web/src/ai/remoteConfig.ts`), App Check (reCAPTCHA v3 on web, App Attest / Play Integrity on Apple / Android), anonymous Auth, Firestore sealed-history backup (`web/src/ai/sync.ts`, rules in `firebase/firestore.rules`), Hosting, and Cloud Functions in `functions/` (`aggregateStats`, `scanSealed` — Sensitive Data Protection on already-sealed text — and `deleteUserData`).

---

## Quick start (developers)

Requirements: Apple-silicon Mac, macOS 26+ with **Apple Intelligence turned on**, Xcode version whose iOS Simulator runtime matches the macOS version (the Simulator borrows the Mac's on-device model — mismatched versions fail).

```bash
brew install xcodegen
./scripts/bootstrap.sh          # checks tools, generates the Xcode project
# Put your own GoogleService-Info.plist in App/Resources/ (gitignored)
open Airlock.xcodeproj
# Run on an iPhone Simulator. Copy the App Check debug token from the console
# into Firebase console → App Check → Manage debug tokens.
./scripts/test.sh               # unit tests (mocked engines; runs anywhere)
```

Full cloud setup: `docs/05-FIREBASE-AND-GCP.md`.

---

## Honesty statement (also shown in the app)

Airlock hides **who you are**, not **what happened**. The cloud model still sees your situation in general terms. Detection is not perfect, which is why there are several layers and a review screen, and why we publish our measured leak rate including the misses. Airlock helps people understand and prepare; it does not give legal, medical or financial advice.

## License

Apache-2.0. Built with the help of AI coding agents (Claude Code, Antigravity, Cursor) using Firebase Agent Skills; every privacy-critical file was reviewed by a human.
