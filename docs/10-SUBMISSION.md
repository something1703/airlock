# 10 — Submission: Devpost, video, README

Deadline: **Mon 30 Nov 2026, 2:00 PM PT = Tue 1 Dec, 03:30 IST.** Submit on the evening of 30 Nov IST. Submissions lock at the deadline; later commits are not evaluated.

---

## 1. Requirements checklist (from the official rules and FAQ)

- [ ] Built with **Firebase AI Logic**, imported and called at runtime (point to files in README table).
- [ ] Uses **hybrid inference** on every platform: on-device (Apple Foundation Models on iPhone/Mac, Chrome's built-in Gemini Nano on the web, Gemini Nano via ML Kit/AICore on Android — all through Firebase AI Logic) and cloud (Gemini). Each mode chosen per feature, explained.
- [ ] **App Check** in use (debug provider accepted).
- [ ] Platforms selected on the form: **iOS, Web, Android** (mention the macOS build in the description).
- [ ] Public **GitHub** repo with all source, assets and run instructions; the README states the value proposition.
- [ ] Open-source licence file (Apache-2.0) **detectable in the repo's About section**.
- [ ] Text description: how Firebase AI Logic is used, features and functionality, value proposition.
- [ ] Demo **video ≤ 3 minutes**, on **YouTube, public**, showing the app running on the platform(s) built for, in English (or with English subtitles). Upload by 29 Nov — processing can take hours.
- [ ] Project is new (submission period started 11 Nov); state that it was built during the period.
- [ ] Free to use and test until judging ends (16 Dec).
- [ ] No production API keys, live secrets, confidential data or PII in repo, form or instructions.
- [ ] Testing instructions provided (see §5).
- [ ] All materials in English.
- [ ] Optional but encouraged: hosted/testable build, Google IDEs, Firebase agent skills (mention that agents used them).

## 2. Devpost text (draft — fill numbers from the final eval run only)

**Name:** Airlock
**Tagline:** The best AI, without giving yourself away.

### Inspiration
We paste our lives into AI: leases, hospital bills, HR complaints, family arguments. The help is real, and so is the oversharing — names, addresses, employers, account numbers, and other people's private details. Removing names by hand doesn't work either: research shows modern models can still infer where you live and what you do from "anonymised" text, and blunt redaction makes the answers worse. We wanted the best AI's help *and* our privacy, on the phone we already own.

### What it does
Airlock puts a small model you own between you and the big model you rent. Apple's on-device model, running through Firebase AI Logic, reads your text first. It seals names, places, contact details, IDs and secrets as placeholders with role hints ("[[PERSON_1]] — your landlord"), then attacks its own work to find what could still identify you, and suggests safer wording. A deterministic gate proves nothing known slipped through before anything leaves. Gemini gets the problem, not the person. When the answer comes back, your phone puts the real names back in. Gemini can even ask your phone for things — like your free times next week — through private tools that return only what's needed. Every request gets a tamper-evident receipt, and a Proof mode checks suspicious messages against the web without sending your details.

### How we built it
- **One privacy engine, three platforms.** The pipeline (detect → merge → policy → seal → red-team → egress gate → restore → receipts) is written in Swift (`AirlockKit`), TypeScript (web) and Kotlin (Android). All three must pass one shared conformance suite (`spec/fixtures`) byte-for-byte; the Kotlin port was also checked against TypeScript on ~50,000 random inputs.
- **Firebase AI Logic hybrid inference everywhere**, using all four modes on purpose:
  - *On-device only* for anything that touches raw text: entity detection, red-team, generalisation, scam-tactic scanning, titles — Apple Foundation Models (iOS/Mac), Chrome's Gemini Nano (web), Gemini Nano (Android).
  - *On-device first* for quick tasks on sealed text (summaries, rewrites) — free and instant; cloud only if needed.
  - *Cloud first* for deep answers and reply drafts (Gemini), with a model fallback chain and a first-chunk guard when a model is overloaded.
  - *Cloud only* for function calling (private tools), Google Search grounding (Proof) and "What could Gemini still guess?".
  - Every answer shows which model produced it.
- **Type-level privacy:** cloud engines only accept a `SealedText` type that only the egress gate can create — enforced by the type system and by source-scanning tests on all three platforms.
- **Firebase:** App Check (reCAPTCHA v3 / App Attest / Play Integrity), anonymous Auth, Firestore backup of sealed history only (allow-list rules tested in the emulator), Remote Config (models, thresholds, prompt overrides), Cloud Functions (stats, Sensitive Data Protection scan of sealed text, delete-my-data), Hosting.
- **Google Cloud:** Model Armor with Sensitive Data Protection as a second net behind our gate (demo project).
- **AirlockBench:** runs the same pipeline on {{n}} synthetic documents in {{languages}} and measures leak rate, re-identification by a strong attacker model, answer quality vs. unprotected, and restore fidelity.
- Built with coding agents (Claude Code / Antigravity / Cursor) using Firebase Agent Skills, with humans reviewing every privacy-critical file.

### Results
{{fill from evidence.json}} e.g. "On our held-out test set, Airlock leaked a direct identifier in X% of documents (CI …), caught Y% of names, and answers were as good or better than sending raw text Z% of the time. Z% of quick tasks never left the phone."

### Challenges
The on-device model's 4,096-token window (chunking with overlap), parsing structured output from a 3B model reliably, keeping placeholders intact through streaming, and designing a review screen that people actually understand.

### Accomplishments
A privacy pipeline we can measure, not just claim. A review screen testers understood in seconds. The moment the answer comes back with real names in it.

### What we learned
Hybrid isn't a fallback — it's a division of labour. The small model's job is judgement at the border; the big model's job is brilliance.

### What's next
Package the engine as a drop-in library for any Firebase app on all three platforms; Gemini Nano verification on more Android devices; team policies for clinics, legal aid and HR; more languages in the pattern packs and the benchmark.

## 3. Video (≤ 3:00) — storyboard and script

Recording: the web app in Chrome (live Gemini Nano + Gemini) for the main flow; iPhone Simulator (iPhone 18 Pro) and the Android emulator for the platform montage; Mac app for one shot. 60 fps. Voice-over recorded separately; captions burned in English. Music: quiet, royalty-free.

| Time | Visual | Voice-over |
|------|--------|-----------|
| 0:00–0:12 | Black screen; a text thread fades in with a name, address and employer highlighted in red one by one | "This is the kind of thing we paste into AI every day. A landlord's name. Your address. Where you work." |
| 0:12–0:22 | Same text sent to a generic chatbot (mock, no brand) → "Sent" | "The help is great. But all of this is now someone else's data. And deleting names by hand doesn't stop a model from working out who you are." |
| 0:22–0:30 | Airlock icon, door closing | "Airlock is the best AI, without giving yourself away." |
| 0:30–0:55 | Paste → highlights appear → chips morph → summary bar | "Your iPhone reads it first. Apple's on-device model, through Firebase AI Logic, finds people, places, numbers and secrets — and turns them into placeholders with roles." |
| 0:55–1:10 | Risk card: "A reader could still guess you live in a small town" → Use suggestion | "Then it attacks its own work. What could a stranger still guess? It fixes that too." |
| 1:10–1:20 | Seal & send → door animation → RouteBadge "Gemini 3.8 Flash" | "Only the sealed version leaves. A gate checks it before it does." |
| 1:20–1:40 | Answer streams; "Raj" underlines as restored; tool consent "Share 2 free slots?" → Allow → draft with times | "Gemini writes back with placeholders. Your phone puts the real names back in. It can even ask your phone for free times — and gets only two slots, nothing else." |
| 1:40–1:52 | Receipt detail: what left, checks, chain verified | "Every request has a receipt. Exactly what left, which model saw it, and a chain you can verify." |
| 1:52–2:05 | Developer switch: gate off → send fake card number → Model Armor sheet; quick cut to Cloud Logging verdict | "And behind our gate, Google's Model Armor stands as a second net. Even if we fail, it blocks." |
| 2:05–2:20 | Wi-Fi off → quick summary "iPhone · nothing sent" → deep answer "offline answer" | "No connection? Your iPhone still helps — summaries, rewrites, even full answers." |
| 2:20–2:35 | Proof: scam text → "Likely a scam" with flags and sources | "Proof mode checks a suspicious message against the web, without sending your details." |
| 2:35–2:52 | Evidence screen; then a 3-up montage: web in Chrome, iPhone Simulator, Android emulator, Mac window | "We don't just claim it. On {{n}} test documents, Airlock leaked a direct identifier in {{x}}% — and we show what it still misses. Same engine on the web, iPhone, Mac and Android." |
| 2:52–3:00 | Icon + tagline + GitHub URL | "Airlock. The best AI, without giving yourself away." |

Avoid: real brand names of other AI products, real personal data, any legal/medical "advice" phrasing. All names in the video are fictional.

## 4. README final checklist

- [ ] One-paragraph value proposition at the top.
- [ ] 20-second GIF of seal → answer.
- [x] Hero, how-it-works and architecture diagrams (`docs/images/*.svg`, light/dark).
- [ ] Table "Where Firebase AI Logic is used" with file paths (kept current).
- [ ] Inference-mode rationale table (from `02-ARCHITECTURE.md` §5).
- [ ] Evaluation results table with CIs and "what we still miss".
- [ ] Setup instructions (bootstrap, own Firebase project, App Check debug token).
- [ ] Honesty statement and limitations.
- [ ] Built during the submission period; AI agents used; licence.

## 5. Testing instructions (for the form)

```
Fastest — the web app (no install):
  https://airlock-hybrid-dev-f1bb0.web.app
  • Desktop Chrome with built-in AI: click "Enable on-device AI" once; sealing then runs on Gemini Nano in your browser.
  • Any browser: it still works with rules + mandatory review (no raw text is ever sent to the cloud).
  • Add ?demo=1 for a scripted tour that makes no AI calls at all.
  Sample texts (all fictional) are in /demo-samples — e.g. 01-landlord.txt with "Draft a reply".

Android — APK attached to the GitHub release. Sideload it; on phones with Gemini Nano (AICore) sealing runs on device, elsewhere rules + review.
  A "Try the demo" launcher shortcut runs the scripted tour.

iPhone & Mac — build from source (Apple-silicon Mac, macOS 26+ with Apple Intelligence on, Xcode 26+):
  1. git clone https://github.com/something1703/airlock && cd airlock && ./scripts/gen.sh
  2. Run the "Airlock (Demo)" scheme for scripted engines, or put your own GoogleService-Info.plist in
     App/Resources/Firebase/dev/ and run "Airlock (Dev)" (register the App Check debug token it prints).

Everything runs against our Firebase project until 16 Dec. All names in samples, screenshots and the video are fictional.
```

## 6. Final hour checklist (30 Nov)

- [ ] Open repo in an incognito window: public, licence in About, README renders, no secrets.
- [ ] YouTube video public, ≤ 3:00, English captions.
- [ ] Devpost form: all fields, platforms iOS + Web + Android, repo URL, live web URL, APK link, video URL, testing instructions, existing-code statement (none).
- [ ] Demo Firebase project funded and live through 16 Dec.
- [ ] Tag the submitted commit `v1.0-submission`.
