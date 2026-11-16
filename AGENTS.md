# AGENTS.md — Rules for every coding agent working on Airlock

Read this file fully at the start of every session. If anything here conflicts with a task prompt, **this file wins** unless a human explicitly overrides it in writing in the PR.

---

## 0. What you are building

Airlock: an iOS/macOS SwiftUI app that seals private details on-device (Apple Foundation Models via **Firebase AI Logic hybrid inference**), sends only sealed text to Gemini in the cloud, restores details locally, and proves what left the phone. Product context: `docs/01-PRODUCT.md`. Architecture: `docs/02-ARCHITECTURE.md`.

The hackathon is judged on four equal criteria: **Technological implementation** (how well hybrid inference is used), **Design** (complete coherent product, not a proof of concept), **Potential impact**, **Quality of the idea**. Optimise every decision for those four.

---

## 1. Session start checklist

1. Read `AGENTS.md` (this file) and `docs/API-NOTES.md`.
2. Read the doc sections named in your work package (`docs/08-BUILD-PLAN.md`).
3. Run `./scripts/test.sh` before changing anything. If it fails on `main`, stop and report.
4. Write a short plan (≤10 bullets) in the PR description before writing code.

---

## 2. The privacy invariants (NEVER violate)

These are the product. A violation is a release blocker, not a bug.

| ID | Invariant | How it is enforced |
|----|-----------|--------------------|
| **INV-1** | Raw user text never reaches any cloud model, cloud function, Firestore, Analytics, Crashlytics, logs, or Remote Config. | Type system: cloud APIs accept only `SealedText`. `RawText` has no public `String` accessor outside `AirlockDetect`/`AirlockSeal`. |
| **INV-2** | `SealedText` can only be constructed by `EgressGate.seal(...)` after the gate passes. | `SealedText.init` is `internal` to `AirlockSeal`; gate is the only caller. A test asserts no other module constructs it. |
| **INV-3** | Raw text is only ever processed by a **phone-only** session (`generativeModelSession(model: systemModel)` with no cloud model attached). Never a `HybridModel`. | `PhoneOnlyEngine` is the only engine type accepting `RawText`. |
| **INV-4** | Never reuse a `GenerativeModelSession` across two different documents or two different tasks. One session per call unless the task is explicitly multi-turn on sealed text. | Engines create sessions internally per call. |
| **INV-5** | Tool results returned to the cloud model pass through the egress gate too (tool output is outbound data). | `ToolLoop` wraps every result in `EgressGate.seal`. |
| **INV-6** | The entity map (placeholder → real value) lives only on device: encrypted with a Keychain-held key. Never synced. | `EntityVault` uses CryptoKit AES-GCM; key in Keychain `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. |
| **INV-7** | Restored answers (with real names) are never written to Firestore. Only sealed turns sync. | Firestore DTOs are built from `SealedText` only. Firestore rules reject forbidden keys. |
| **INV-8** | Logging: use `Logger` with `privacy: .private` for any content-derived value. Never `print()` user content. Never put user content in error messages that might be reported. | Lint script greps for `print(` in `Packages/` and `App/`. |
| **INV-9** | If on-device inference is unavailable or fails, **fall back to rules + mandatory human review**, never to the cloud. | `SealPipeline` handles `.unavailable` explicitly; covered by tests. |
| **INV-10** | Reading-aloud of restored answers uses Apple's on-device speech synthesis only, never cloud TTS. | No TTS model configured for restored text. |

If a task seems to require breaking an invariant, stop and ask a human in the PR.

---

## 3. Hackathon rules you must respect

- All AI inference in the app goes through **Firebase AI Logic** (Apple Foundation Models via Firebase on-device; Gemini in the cloud). Do not call Gemini REST APIs directly. Do not import Apple's `FoundationModels` framework anywhere **except `Packages/AirlockKit/Sources/AirlockEngines/`**, and there only to recognise Apple's error types and use `@Generable` schemas — never to create a `LanguageModelSession` or run inference (human override, 16 Nov; `docs/11-RISKS-AND-DECISIONS.md`).
- Firebase AI Logic must be **imported and actually called at runtime** — not just mentioned.
- **App Check is required.** Use the debug provider in Simulator. Never commit debug tokens.
- Never commit: `GoogleService-Info.plist`, App Check debug tokens, service-account keys, `.env` files, any API key. `.gitignore` covers them; check `git status` before every commit.
- Repo must stay public with an Apache-2.0 `LICENSE` at the root.
- Use **stable** model names only (from Remote Config). No `-preview`, no `-latest`.
- Apple's acceptable-use rules for the on-device model: do not build features that *provide* regulated healthcare, legal or financial services. Airlock explains and helps people prepare; copy must never claim to give advice. See `docs/06-UI-UX.md` §9.

Open rule questions (Apple Vision OCR, NaturalLanguage tagger, NSDataDetector): these are behind Remote Config flags (`vision_ocr_enabled`, `nltagger_enabled`). Build them, but keep the app fully working with them off. See `docs/11-RISKS-AND-DECISIONS.md` Q-1.

---

## 4. Tech stack (fixed — do not add to it without a human decision)

| Area | Choice |
|------|--------|
| Language | Swift 6, strict concurrency on |
| UI | SwiftUI, Observation (`@Observable`), NavigationStack / NavigationSplitView |
| Min OS | iOS 26 / macOS 26 (Foundation Models requirement). Prefer iOS 27 SDK features only behind `if #available`. |
| Project | **XcodeGen** (`project.yml`). Never hand-edit `.xcodeproj`. Run `./scripts/gen.sh` after changing targets. |
| Dependencies | Firebase iOS SDK via Swift Package Manager **only**, pinned **exactly to 12.19.0** in `project.yml` and `Packages/AirlockKit/Package.swift` (13.x removed the hybrid API; see `docs/API-NOTES.md` §7). Products: `FirebaseAILogic`, `FirebaseAppCheck`, `FirebaseAuth`, `FirebaseFirestore`, `FirebaseRemoteConfig`, `FirebaseFunctions`, `FirebaseAnalytics` (optional). No other third-party packages. |
| Local storage | SwiftData (store file protection `.complete`), Keychain for keys |
| Crypto | CryptoKit (SHA-256, AES-GCM) |
| Calendar | EventKit (read-only, user consent) |
| Cloud Functions | TypeScript, Functions v2, Node 22 |
| Eval scorer | Python 3.12 on Cloud Run Jobs |

---

## 5. Firebase API discipline

The iOS hybrid SDK is **experimental** and parts are undocumented ("coming soon"). Therefore:

1. **Never guess an API.** Before using a Firebase AI Logic type or method, open the SDK source in `~/Library/Developer/Xcode/DerivedData/*/SourcePackages/checkouts/firebase-ios-sdk/FirebaseAI/` and confirm the signature.
2. Record what you confirmed in `docs/API-NOTES.md` (section "Verified in source"), with the SDK version and file path.
3. Wrap every Firebase AI call behind the `Engine` protocols in `AirlockEngines`. No other module imports `FirebaseAILogic`.
4. All model names, thresholds and prompt overrides come from `AppConfig` (Remote Config with bundled defaults). Never hard-code a model name outside `AppConfig.defaults`.
5. Capture `response.rawResponse.modelVersion` on every response and return it in `EngineResult.modelVersion`. The UI route badge depends on it.

Use the Firebase Agent Skills and Firebase MCP server:

```bash
claude plugin marketplace add firebase/agent-skills
claude plugin install firebase@firebase
```

Note: the `firebase-ai-logic-basics` skill targets web apps. For Swift, the iOS docs and SDK source are the reference.

---

## 6. Build, run, test commands

```bash
./scripts/gen.sh                                  # regenerate Xcode project from project.yml
./scripts/test.sh                                 # swift test for AirlockKit + xcodebuild test for app (mock engines)
./scripts/lint.sh                                 # swift-format lint + invariant greps
xcodebuild -scheme Airlock -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

If XcodeBuildMCP is available, prefer it for build/run/screenshot in the Simulator.

Tests that need the real on-device model are tagged `.onDevice` and skipped by default. Run them locally with `RUN_ON_DEVICE_TESTS=1 ./scripts/test.sh` on a Mac with Apple Intelligence enabled.

CI (GitHub Actions, macOS runner) runs build + mocked tests + lint. CI cannot run the on-device model.

---

## 7. Code conventions

- Logic lives in `AirlockKit`; views are thin. A view never calls an engine directly — it calls a feature `@Observable` model that calls `AirlockKit`.
- Every public type in `AirlockKit` has a doc comment saying what it guarantees.
- Errors: use typed `enum` errors per module (`SealError`, `EngineError`, …). User-facing text for errors lives in `App/Resources/Localizable.xcstrings`, never in `AirlockKit`.
- No force-unwraps outside tests. No `try!`.
- Async: `async/await` and actors. No Combine. No completion handlers in new code.
- Previews: every view has a `#Preview` using `MockEngines` and fixture data from `App/PreviewContent/`.
- Strings shown to users: all localisable, English first. Follow the copy rules in `docs/06-UI-UX.md` §9.
- Accessibility labels on every interactive element and every placeholder chip.

---

## 8. Git and PR workflow

- Branch per work package: `wp/NN-short-name` (numbers from `docs/08-BUILD-PLAN.md`).
- Small PRs (aim < 600 changed lines). One work package may be several PRs.
- Commit messages: imperative, prefixed with module, e.g. `Seal: add egress gate surface-form check`.
- PR description template:
  ```
  WP: NN
  Plan: (bullets)
  Invariants touched: INV-x (or none)
  Tests added: (list)
  Docs updated: (list)
  Screenshots: (for UI)
  ```
- **Human review required** (CODEOWNERS) for: `AirlockCore`, `AirlockSeal`, `AirlockEngines`, `AirlockTools`, `firebase/firestore.rules`, `functions/`.

---

## 9. Definition of done (every work package)

- [ ] Acceptance criteria in `docs/08-BUILD-PLAN.md` met and demonstrated (test or screenshot).
- [ ] `./scripts/test.sh` and `./scripts/lint.sh` pass.
- [ ] New logic has unit tests; privacy logic also has property/fuzz tests (`docs/09-TESTING.md`).
- [ ] No invariant weakened. If an invariant is touched, a test proves it still holds.
- [ ] Docs updated: `API-NOTES.md` for any SDK fact, README table (§ "Where Firebase AI Logic is used") for any new AI call site.
- [ ] UI work: light + dark screenshots, Dynamic Type XXL screenshot, VoiceOver labels checked.

---

## 10. Keep these files current

| File | Update when |
|------|-------------|
| `docs/API-NOTES.md` | You verify or disprove any SDK behaviour |
| `README.md` table "Where Firebase AI Logic is used" | You add/move an AI call site |
| `docs/04-PROMPTS.md` | You change any prompt (bump its version id) |
| `firebase/remoteconfig.template.json` and `AppConfig.defaults` | You add a config key (both, same PR) |
| `docs/11-RISKS-AND-DECISIONS.md` | You make or need an architectural decision |

---

## 11. When to stop and ask a human

- Anything needing the Firebase/Google Cloud console, billing, Apple ID signing, or Discord.
- Any change to an invariant, a Firestore rule, or the egress gate's behaviour.
- An SDK API that does not exist or behaves differently from the docs (record it in `API-NOTES.md` first).
- Any copy that might read as legal/medical/financial advice.
- Scope changes: anything not in the work package.

---

## 12. Things that look like good ideas but are not

- Sending raw text to the cloud "just for detection quality". No (INV-1).
- Using a `HybridModel` for detection so it "falls back gracefully". No (INV-3).
- Server prompt templates — not supported with hybrid inference on iOS.
- Gemini Live API — not supported with hybrid inference.
- Counting tokens via the SDK — not supported with hybrid; estimate from characters (`docs/03-PRIVACY-ENGINE.md` §4).
- Cloud TTS of restored answers — leaks names (INV-10).
- Claiming "100% private" or "anonymous" anywhere in copy.
