# 08 — Build plan: work packages, lanes and schedule

Each work package (WP) is sized for one agent session or a small series of PRs. Humans assign WPs; agents follow `AGENTS.md`. "Read" lists the doc sections the agent must read first.

---

## 1. Lanes (run in parallel)

| Lane | Owner (human + agents) | WPs |
|------|------------------------|-----|
| **A — Engine & privacy** | Strongest engineer; reviews every privacy PR | 01–08, 13, 14 |
| **B — App & UI** | Design-minded engineer | 09–12, 15–18, 21 |
| **C — Cloud & evaluation** | Backend/data person | 19, 20, 22 |
| **D — Story & submission** | Product/storyteller (can be the same person as B late in the schedule) | 23, 24, user tests |

With one human: run A in the morning, B in the afternoon, C overnight (eval runs), D in the final 3 days.

---

## 2. Work packages

**Status (16 Nov, end of day):** deterministic parts of WP-02, WP-04, WP-06, WP-07, WP-08 and the Ledger half of WP-16 are built and tested (`Packages/AirlockKit`, 65 tests incl. a 10,000-case gate property test; shared fixtures in `spec/fixtures/`). Also done (16 Nov, later): WP-00 project skeleton (`project.yml`, app shell), WP-01 source verification (runtime half pending Firebase config), WP-03 engines (Firebase AI Logic 12.19.0), WP-05 LLM detector + chunker + NL tagger, `SealPipeline`, WP-14 red-team, WP-15 engine side (`AirlockRoute`: Router, TaskCatalog, streaming `AnswerService`) and WP-16 logic (`ReceiptLedger`, stats, chain verify) and WP-13 local stores + crypto (`AirlockStore`: encrypted entity maps, Vault, raw captures, purge, delete-everything) — 137 Swift tests (1 Keychain test skipped outside a signed host). **Web engine port (TypeScript, `web/src/engine/`) done for detect/seal/gate/restore/hash-chain: 52 tests against the same shared fixtures, incl. the 10,000-case gate test.** Web still to do: engines over Firebase AI Logic web SDK (`InferenceMode`), pipeline/router, encrypted IndexedDB store, UI. Blocked on humans: Simulator (`xcodebuild -runFirstLaunch`) and Firebase console steps (HUMAN-TODO H-01b, H-02–H-04). Cut lines in §4 are retired by owner decision (no cuts).

### WP-00 Repo bootstrap — Lane A — Day 1

Read: `AGENTS.md`, `README.md` (layout), `02-ARCHITECTURE.md` §2.

Deliver:
- `project.yml` (XcodeGen): app target `Airlock` (iOS 26 + macOS 26 multiplatform), `AirlockKit` local package, test targets, `AirlockBench` macOS app target.
- Firebase SPM pinned exactly (≥ 12.13.0).
- `scripts/bootstrap.sh`, `gen.sh`, `test.sh`, `lint.sh`; `.gitignore` (plists, tokens, `.env`, DerivedData, user schemes).
- `LICENSE` Apache-2.0; GitHub repo public with license visible in About; `CODEOWNERS`.
- GitHub Actions: build + `swift test` + lint on macOS runner.

Accept: fresh clone → `./scripts/bootstrap.sh && ./scripts/test.sh` passes; app launches in Simulator to a placeholder screen.

### WP-01 API verification spike — Lane A — Day 1 (critical path)

Read: `API-NOTES.md` (all).

Deliver a throwaway `Spikes/HybridSpike.swift` screen (DEBUG) that:
1. Reports `SystemLanguageModel.default.availability`.
2. Runs one phone-only call, one phoneFirst, one cloudFirst, one cloudOnly; prints `modelVersion` and latency for each.
3. Streams one response and logs whether snapshots are cumulative or deltas.
4. Tries `GenerationOptions` with greedy sampling and max tokens; records what exists.
5. Searches the SDK source for structured-output / schema APIs for the system model.
6. Sends 5,000 tokens to phone-only to observe the context-limit error type.
7. Sends text that triggers Apple's guardrail (e.g. a medical description) to observe the refusal error type.
8. Cloud-only `generativeModel(…tools:)` with one dummy function declaration; confirms call/response round trip.

Accept: `API-NOTES.md` §8 "Verified in source" has ≥ 10 rows; every 🔍 item from §1–§2 is resolved or explicitly still open.

### WP-02 Core types — Lane A — Day 1–2

Read: `02-ARCHITECTURE.md` §3, `03-PRIVACY-ENGINE.md` §2, §12.

Deliver: `AirlockCore` (RawText, SealedText, Category, Entity, EntityMap, Action, Policy, DialPreset, Route, EngineResult, Receipt, AppConfig + defaults, LegendLine, GateReport).

Accept: unit tests for Codable round-trips; `SealedTextConstructionTests` proves only `AirlockSeal` can construct it; `AppConfig.defaults` equals `firebase/remoteconfig.template.json` (test).

### WP-03 Engines — Lane A — Day 2

Read: `02-ARCHITECTURE.md` §4–5, `API-NOTES.md`.

Deliver: `AirlockEngines` with PhoneOnly/PhoneFirst/CloudFirst/CloudOnly/ToolCapable engines over Firebase; `PhoneQueue` actor; availability publisher; error mapping (§9 of architecture); `MockEngines` (scriptable responses, latency, failures).

Accept: integration test (tagged `.onDevice`) runs all four routes and asserts `ranOnDevice` matches route expectations; mocks used by all other module tests.

### WP-04 Pattern detectors + Vault matcher — Lane A — Day 2–3

Read: `03-PRIVACY-ENGINE.md` §5.1–5.2.

Deliver: `VaultMatcher`, `PatternDetector` with packs in JSON, validators (Luhn, mod-97, SSN rules, entropy), `patterns-golden` fixtures.

Accept: ≥ 99% recall and ≥ 95% precision on `patterns-golden`; property tests (random insertion of valid IDs into lorem text always detected).

### WP-05 LLM detector + chunker + NL tagger — Lane A — Day 3

Read: `03-PRIVACY-ENGINE.md` §3–5, `04-PROMPTS.md` §1.

Deliver: `Chunker` (token estimates, overlap, retry on contextTooLong), `LLMDetector` (`detect.v1`, lenient JSON parser, substring validation, repair retry), `NLDetector` (flagged).

Accept: on-device test on 30 smoke docs runs end-to-end without crashes; parse-failure rate logged; hallucinated spans dropped (test with mock returning fake spans).

### WP-06 Merge, coreference, policy, sealer — Lane A — Day 3–4

Read: `03-PRIVACY-ENGINE.md` §6–7, §2.1–2.2.

Deliver: `Merger`, `Coreference`, `PolicyEngine`, `Sealer` (right-to-left replacement, legend, PERSON_ME), `Generaliser` (`gen.v1` + validation + ladder defaults).

Accept: golden tests for overlap rules and coref ("Dr. Patel"/"Patel"/"Raj Patel"); ambiguity case ("Sam" × 2) yields two entities; dial presets produce the table in §2.1.

### WP-07 Egress gate — Lane A — Day 4 (human review mandatory)

Read: `03-PRIVACY-ENGINE.md` §9, `AGENTS.md` §2.

Deliver: `EgressGate` with G1–G7, `GateReport`, `GateBlocked` errors with span locations; `#if DEBUG` bypass.

Accept: property test — for 10,000 random drafts, inserting any surface form, vault alias, or D2-pattern string anywhere (including with zero-width chars, different case, diacritics) always blocks; zero false blocks on clean `synth` seals.

### WP-08 Restorer — Lane A — Day 4

Read: `03-PRIVACY-ENGINE.md` §11.

Deliver: `PlaceholderParser`, `Restorer` (streaming-safe, cumulative/delta handling, variants, possessives, unknown ids, SECRET never restored), restored-range tracking.

Accept: fuzz test splitting answers at every character boundary yields identical output to non-streaming restore; variant table covered.

### WP-09 Design system — Lane B — Day 2–3

Read: `06-UI-UX.md` §1–3, §7, §10.

Deliver: tokens (colours in asset catalog, typography, spacing), all components in §3 with previews (light/dark/XXXL), app icon v1.

Accept: preview screenshots attached to PR; accessibility labels on every component.

### WP-10 App shell, onboarding, availability — Lane B — Day 3–4

Read: `06-UI-UX.md` §4, §5.1; `05-FIREBASE-AND-GCP.md` §3–5.

Deliver: tab/split navigation; onboarding 4 pages; Vault entry form (local, encrypted store via WP-13 stub); availability banner; Remote Config service; anonymous auth.

Accept: fresh install flow works in Simulator with Apple Intelligence on and (simulated) off.

### WP-11 Ask + capture — Lane B — Day 4–5

Read: `06-UI-UX.md` §5.2; `03-PRIVACY-ENGINE.md` §3.

Deliver: compose, intent chips, paste, PhotosPicker + Vision OCR (flagged), PDF import, raw capture store.

Accept: paste, photo and PDF paths produce `RawText` with correct source.

### WP-12 Review screen + seal animation — Lane B — Day 5–7 (hero)

Read: `06-UI-UX.md` §5.3–5.4, §2.4, §5.6.

Deliver: progressive highlights, chip morph, chip menus, merge control, risk cards, dial switch, answer-with menu, Seal & send with gate, door animation, blocked states.

Accept: screen recording (light + dark) attached to PR; VoiceOver walkthrough works; gate block flow demonstrated.

### WP-13 Local stores + crypto — Lane A — Day 5

Read: `02-ARCHITECTURE.md` §7; `AGENTS.md` INV-6.

Deliver: SwiftData models with `.complete` protection; `EntityVault` AES-GCM with Keychain key (`WhenUnlockedThisDeviceOnly`); raw purge job; Delete everything.

Accept: tests prove map is encrypted at rest (bytes on disk don't contain names); purge works.

### WP-14 Red-team loop — Lane A — Day 6

Read: `03-PRIVACY-ENGINE.md` §8; `04-PROMPTS.md` §2–3.

Deliver: `RedTeam` actor, risk generation, validation, strict auto-apply, suggestions for review.

Accept: on `synth-hard` smoke (20 docs), quasi coverage improves vs. without red-team; no suggestion ever contains a surface form (test).

### WP-15 Thread, routing, quick tasks, deep answers — Lane B + A — Day 6–8

Read: `02-ARCHITECTURE.md` §5–6; `04-PROMPTS.md` §5; `06-UI-UX.md` §5.5.

Deliver: Router, QuickTasks (phoneFirst), DeepAnswer (cloudFirst, streaming), follow-ups with sealed history, RouteBadge from modelVersion, offline banner and fallback, copy/copy sealed, read aloud (C).

Accept: Wi-Fi off on the Mac → deep answer still returns from phone with "offline answer" badge; quick summary shows "iPhone · nothing sent".

### WP-16 Receipts, ledger, chain verify — Lane B — Day 8

Read: `03-PRIVACY-ENGINE.md` §12; `06-UI-UX.md` §5.7–5.8.

Deliver: ReceiptBuilder, HashChain, Ledger screen, Receipt detail, weekly hero stats, verify animation, tamper test (DEBUG: corrupt one receipt → coral mismatch).

Accept: chain verifies after 50 requests; tamper detected.

### WP-17 Private tools + consent — Lane A + B — Day 9

Read: `02-ARCHITECTURE.md` §6.3; `04-PROMPTS.md` §6; `06-UI-UX.md` §5.5.

Deliver: tool declarations, ToolLoop (parallel calls supported), CalendarTool (EventKit read-only, free-slot computation), EntityRoleTool, DateContextTool, ConsentBroker + card, gate on results.

Accept: "Draft a reply proposing a meeting next week" produces a draft with two real free slots; declining consent still yields a sensible draft.

### WP-18 Proof mode — Lane B + A — Day 10

Read: `02-ARCHITECTURE.md` §6.4; `04-PROMPTS.md` §7; `06-UI-UX.md` §5.10; `API-NOTES.md` §2 (Search display rules).

Deliver: TacticScanner (patterns + `tactics.v1`), ClaimExtractor, ClaimCheck (cloudOnly + googleSearch), VerdictCard, sources, offline card, share warning.

Accept: 10 scam and 5 legitimate sample messages produce sensible verdicts; Search display requirements met.

### WP-19 Firebase backend — Lane C — Day 3–9

Read: `05-FIREBASE-AND-GCP.md` (all).

Deliver: `firebase/` (rules, indexes, RC template), `functions/` (aggregateStats, scanSealed, deleteUserData) with emulator tests, SyncService in app, rules tests.

Accept: emulator rules tests pass incl. forbidden keys and looksSealed regex; sync of sealed turns visible in console; stats update.

### WP-20 Model Armor + Agent Platform — Lane C — Day 10–11

Read: `05-FIREBASE-AND-GCP.md` §8; `API-NOTES.md` §5.

Deliver: backend switch, Armor floor setting (👤), block mapping, receipt armor status, log query + metric, demo script with `debug_disable_gate`.

Accept: with gate disabled (DEBUG), sending a fake card number is blocked by Armor and the app shows the Armor sheet; Cloud Logging shows the verdict.

### WP-21 Mac polish + Evidence + Settings — Lane B — Day 11–12

Read: `06-UI-UX.md` §5.11–5.12, §8.

Deliver: Mac layout, keyboard shortcuts, drag and drop; Settings; Developer panel; Evidence screen from `evidence_json`; "What could Gemini still guess?" card (F-25).

Accept: Mac build runs; Evidence shows real numbers from the latest run.

### WP-22 AirlockBench + scorer — Lane C — Day 2–12 (synthetic generator and smoke mode first)

Read: `07-EVALUATION.md` (all); `04-PROMPTS.md` §9.

Deliver: Bench app (generate/run/report), JSONL exports, GCS upload, Cloud Run scorer, BigQuery tables, report renderer, `evidence_json` generation.

Accept: smoke run by Day 3 (18 Nov); full test-split run by 25 Nov with report committed under `eval/reports/`.

### WP-23 Polish pass — all lanes — Day 13

Deliver: accessibility audit fixes, copy review against §9 rules, performance (seal latency), icon final, empty/error states complete, demo-set regression green.

### WP-24 Submission — Lane D — Day 12–14

Read: `10-SUBMISSION.md`.

Deliver: README final (with Firebase usage table, architecture diagram, eval table), Devpost text, video (≤ 3 min) uploaded to YouTube publicly, screenshots, testing instructions.

---

## 3. Calendar (IST)

| Date | Lane A | Lane B | Lane C | Lane D / humans |
|------|--------|--------|--------|-----------------|
| Mon 16 Nov | WP-00, WP-01, WP-02 | — | Firebase projects (👤) | Read docs, Discord questions drafted |
| Tue 17 Nov | WP-03, WP-04 | WP-09 | WP-19 start, synth generator | Ask Discord Q-1..Q-4 |
| Wed 18 Nov | WP-05 | WP-09 | **Smoke eval → go/no-go** | Decide pivot if needed |
| Thu 19 Nov | WP-06 | WP-10 | WP-19 | |
| Fri 20 Nov | WP-07, WP-08 | WP-10, WP-11 | WP-22 run mode | |
| Sat 21 Nov | WP-13 | WP-11, WP-12 | WP-22 | Recruit 5 testers |
| Sun 22 Nov | WP-14 | WP-12 | First full eval | |
| Mon 23 Nov | WP-15 (engine side) | WP-12, WP-15 | Prompt tuning | |
| Tue 24 Nov | WP-17 | WP-16 | WP-19 sync | Storyboard locked |
| Wed 25 Nov | WP-18 (engine) | WP-18 (UI) | **Prompt freeze, final eval**; quota form Sprint 3 deadline 10 AM PT | |
| Thu 26 Nov | Bug fixes | WP-21 | WP-20 Armor | Evidence numbers in app |
| Fri 27 Nov | WP-23 | WP-23 | WP-20 | User tests (×3) |
| Sat 28 Nov | WP-23 | WP-23 | Logs/screens for video | User tests (×2), record video |
| Sun 29 Nov | Freeze 23:59 | Freeze | Freeze | Edit + upload video, README |
| Mon 30 Nov | — | — | — | Submit by evening IST; verify all links in an incognito window |
| Tue 1 Dec 03:30 | — | — | — | **Deadline** |

## 4. Cut lines (if behind schedule)

Cut in this order, latest first:
1. F-54 share extension, F-26 read aloud
2. F-45 SDP "Scan with Google"
3. F-53 Mac polish (keep Mac build running, skip shortcuts and drag-drop)
4. F-23 private tools
5. F-30–32 Proof mode
6. F-46 Model Armor (keep the Developer API backend)

Never cut: seal pipeline, Review screen, egress gate, restore, receipts, route badges, Evidence with real numbers, video.

## 5. Go/no-go gates

| Date | Gate | If it fails |
|------|------|-------------|
| 16 Nov | WP-01: phone-only + cloud calls work in Simulator | Fix Mac/Xcode versions; worst case borrow a Mac with Apple Intelligence |
| 18 Nov | Smoke eval direct-ID recall with D_llm ≥ 85% | Make Vault + patterns + mandatory review the headline; red-team becomes C |
| 22 Nov | Review screen + seal + answer usable end-to-end | Cut Proof and tools now, not later |
| 26 Nov | Final eval numbers available | Ship with smoke numbers clearly labelled |
