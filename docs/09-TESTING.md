# 09 — Testing and quality

Privacy code is tested harder than anything else. The rule: **a privacy claim without a test does not ship.**

## 1. Test pyramid

| Layer | Tool | Runs on | When |
|-------|------|---------|------|
| Unit | Swift Testing (`@Test`) in `AirlockKit/Tests` | CI + local | Every PR |
| Property / fuzz | Swift Testing with seeded random generators | CI + local | Every PR |
| Golden files | Fixtures in `Tests/Fixtures/` | CI + local | Every PR |
| On-device integration | Tagged `.onDevice`, real Apple model | Local Mac with Apple Intelligence (`RUN_ON_DEVICE_TESTS=1`) | Before merging Lane A PRs; nightly |
| Firestore rules | Firebase emulator + `@firebase/rules-unit-testing` | CI (Node) | PRs touching `firebase/` |
| Functions | Emulator + Jest | CI | PRs touching `functions/` |
| UI | XCUITest flows with `MockEngines` (launch argument `-useMocks`) | CI + local | PRs touching `App/` |
| Accessibility | `performAccessibilityAudit()` per main screen | CI | PRs touching `App/` |
| Benchmark | AirlockBench (`07-EVALUATION.md`) | Local Mac | Milestones |
| Manual demo checklist | §7 below | Human | Daily from 26 Nov |

## 2. Must-have tests by module

### AirlockCore
- Codable round-trips for every type.
- `SealedText` has no public initializer: compile-time test via a module that tries to construct it inside `#if false` plus a source scan test.
- `AppConfig.defaults` matches `firebase/remoteconfig.template.json` key-for-key and value-for-value.

### AirlockDetect
- `patterns-golden`: recall ≥ 99%, precision ≥ 95%; each validator (Luhn, mod-97, SSN) with valid/invalid cases.
- Property: random valid card/IBAN/email/phone inserted into random text at random positions → detected with correct span.
- Vault: case, diacritics ("José"/"Jose"), possessives ("Raj's"), word boundaries ("Rajesh" must not match "Raj" unless alias), first-name aliases.
- Chunker: chunk estimates never exceed budget; overlap present; spans mapped back to correct global offsets (property test with random sentence lengths).
- LLMDetector with mocks: valid JSON; JSON in code fences; trailing prose; hallucinated span dropped; broken JSON → repair called once → then fallback.
- Merger: overlap priority table; coref cases; ambiguous "Sam" kept separate.

### AirlockSeal
- PolicyEngine: dial preset table (`03-PRIVACY-ENGINE.md` §2.1) as a parameterised test.
- Sealer: right-to-left replacement correctness; `PERSON_ME`; legend never contains surface forms.
- Generaliser validation: rejects outputs containing surface forms, > 8 words, empty, identical.
- **EgressGate property test (10,000 cases):** generate clean sealed drafts; mutate by inserting (a) a surface form, (b) a vault alias with random case/diacritics, (c) any D2 pattern instance, (d) zero-width joined variants, (e) homoglyphs (Cyrillic "а" for Latin "a") — every mutation must block; unmutated drafts must pass.
- RedTeam with mocks: risky guesses only when evidence is an exact substring; strict auto-apply; suggestion cap.
- INV-9: availability `.unavailable` → pipeline result has `requiresReview == true` and no engine call to cloud (spy on mock).

### AirlockRestore
- Variant table (`[PERSON_1]`, `PERSON_1`, `[[ PERSON_1 ]]`, …) restored only when id exists.
- Streaming fuzz: for 500 answers, split the text at every boundary into chunks (both cumulative and delta modes) → output identical to unary restore.
- `SECRET_n` never restored.
- Possessive handling; unknown id chip.
- "Model guessed a real name" detection.

### AirlockRoute / Engines
- Router table (`02-ARCHITECTURE.md` §5) as a parameterised test against mocks.
- `ranOnDevice` derived from `modelVersion == "apple-foundation-models-system-language-model"`.
- Offline: cloudFirst mock simulating offline fallback returns phone result labelled offline.
- Error mapping for 429/503 (backoff ×3), armor block, contextTooLong.
- A raw-text spy: any `SealedEngine` receiving a string not produced by `EgressGate` fails the test (debug assertion in mocks).

### AirlockTools
- Calendar free-slot computation (fixtures with overlapping events, all-day events, time zones).
- Tool results pass through gate (inject a surface form into a fake calendar title → must never appear in the tool reply).
- Consent denied → `{"error":"user_declined"}`.

### AirlockLedger
- Hash chain: deterministic canonical JSON; verify after 1,000 receipts; single-byte tamper detected at the right index.

### App
- XCUITest flows (mocks): onboarding → paste → review → seal → answer → receipt; gate-block flow; offline flow; Proof flow; Vault Face ID (Simulator enrolled).
- Snapshot of each main screen in light/dark/XXXL attached to PRs (manual screenshots are fine; no snapshot library — dependency rule).

### Toolchain note (16 Nov)
`scripts/test.sh` runs `swift test` with `DEVELOPER_DIR=/Applications/Xcode.app/...` when Xcode is installed (Swift 6.4, macOS 27 SDK — required for Apple's iOS 27 `LanguageModelError` mapping), even if `xcode-select` still points at the Command Line Tools. App/UI tests run only once `xcodebuild -runFirstLaunch` has installed the Simulator.

### Web (`web/`)
`npm test` (vitest) runs the web engine against `spec/fixtures/` and ports the property/fuzz tests. `scripts/test.sh` also runs `npm run typecheck`. Tests were mutation-checked: disabling the partial-name defence makes the property and gate-fixture tests fail.

## 3. Lint and invariant checks (`scripts/lint.sh`)

- `swift-format lint --recursive`.
- Grep fails if:
  - `import FirebaseAILogic` appears outside `Packages/AirlockKit/Sources/AirlockEngines/`.
  - `import FoundationModels` appears anywhere in `App/` or `Packages/` (all AI via Firebase).
  - `print(` appears in `App/` or `Packages/*/Sources`.
  - `Analytics.logEvent` with a string literal parameter outside the allowlist.
  - A model name string (`gemini-`) appears outside `AppConfig.swift` and tests.
  - `GoogleService-Info.plist` or `AppCheckDebugToken` is tracked by git.

## 4. Performance budgets

| Measure | Budget (M-series Mac Simulator) |
|---------|--------------------------------|
| Cold launch to Ask screen | < 1.5 s |
| Seal, 300 words, Balanced, red-team on | p50 < 6 s, p95 < 10 s |
| Seal, 300 words, red-team off | p50 < 4 s |
| Time to first highlight | < 1.5 s |
| Restore overhead per streamed chunk | < 2 ms |
| Memory during seal | < 250 MB app footprint |

Measure with `ContinuousClock` around stages, logged to the Developer panel and AirlockBench.

### Keychain test (signed host only)
`KeychainKeyProviderTests` needs a Keychain entitlement. In an unsigned `swift test` host it is reported as **cancelled** (status -34018), not passed. Verify it by running the app (or the app's test target) once signed; the checklist below includes it.

## 5. Security review checklist (human, before 27 Nov)

- [ ] No raw text in any network request (Charles/Proxyman capture during a full demo run; search capture for test names).
- [ ] Firestore documents in console contain only placeholders.
- [ ] Keychain item accessibility is `WhenUnlockedThisDeviceOnly` and `KeychainKeyProviderTests` passes in the signed app (it is skipped under plain `swift test`).
- [ ] SwiftData store file protection is `.complete`.
- [ ] Logs (Console.app, filter subsystem `app.airlock`) show `<private>` for content.
- [ ] Release build has no `debug_disable_gate`.
- [ ] App Check enforced for AI Logic, Firestore, Functions in both projects.
- [ ] API keys restricted.
- [ ] Repo history has no secrets (`git log -p | grep -i -E "AIza|debug.?token|private_key"`).

## 6. Bug severity

| Sev | Definition | Response |
|-----|-----------|----------|
| S0 | Any raw identifier left the device, or receipt lies about what left | Stop the line. Fix + regression test before any other work |
| S1 | Demo path broken; gate false-blocks clean text; restore wrong name | Fix same day |
| S2 | Feature degraded with a workaround | Before freeze |
| S3 | Cosmetic | If time |

## 7. Daily demo checklist (from 26 Nov)

Run the 5 `demo-set` scenarios end to end on the Mac Simulator, in light and dark mode:
1. Landlord dispute → reply draft with calendar slots (tools).
2. HR complaint → strict dial → red-team suggestion accepted.
3. Contract clause → explain → "What could Gemini still guess?".
4. Bank scam text → Proof verdict with sources.
5. Wi-Fi off → quick summary + offline deep answer.
Then: Ledger verify chain; Evidence screen numbers; Mac build launches.
