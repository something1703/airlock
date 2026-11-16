# 10 — Submission: Devpost, video, README

Deadline: **Mon 30 Nov 2026, 2:00 PM PT = Tue 1 Dec, 03:30 IST.** Submit on the evening of 30 Nov IST. Submissions lock at the deadline; later commits are not evaluated.

---

## 1. Requirements checklist (from the official rules and FAQ)

- [ ] Built with **Firebase AI Logic**, imported and called at runtime (point to files in README table).
- [ ] Uses **hybrid inference**: on-device (Apple Foundation Models via Firebase AI Logic) and cloud (Gemini). Each mode chosen per feature, explained.
- [ ] **App Check** in use (debug provider accepted).
- [ ] Platform selected on the form: **iOS** (mention the macOS build in the description).
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
- **Firebase AI Logic hybrid inference on iOS**, using all four modes on purpose:
  - *On-device only* for anything that touches raw text: entity detection, red-team, generalisation, scam-tactic scanning.
  - *On-device first* for quick tasks on sealed text (summaries, rewrites) — free and instant, cloud only if needed.
  - *Cloud first* for deep answers and reply drafts (Gemini 3.8 Flash), falling back to the on-device model when offline.
  - *Cloud only* for function calling (private tools) and Google Search grounding (Proof).
  - Every answer shows which model produced it, from `modelVersion`.
- **Type-level privacy:** cloud engines only accept a `SealedText` type that only the egress gate can create.
- **Firebase:** App Check, Anonymous Auth, Firestore (sealed text only, with server rules that reject identifiers), Remote Config (models, prompts, thresholds, feature flags), Cloud Functions.
- **Google Cloud:** Model Armor with Sensitive Data Protection as a second net behind our gate, Cloud Logging verdicts, a Cloud Run scoring job, BigQuery for benchmark results.
- **AirlockBench:** a Mac app that runs the same pipeline on {{n}} synthetic documents in {{languages}} and measures leak rate, re-identification by a strong attacker model, answer quality vs. unprotected, and restore fidelity.
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
Open-source `AirlockKit` so any Firebase app can add a privacy airlock; Android and Chrome versions with Gemini Nano; team policies for clinics and HR.

## 3. Video (≤ 3:00) — storyboard and script

Recording: Mac Simulator (iPhone 17 Pro frame) via QuickTime/Xcode recording at 60 fps; Mac app screen for one shot. Voice-over recorded separately; captions burned in English. Music: quiet, royalty-free.

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
| 2:35–2:52 | Evidence screen; ablation chart; Mac app window | "We don't just claim it. On {{n}} test documents, Airlock leaked a direct identifier in {{x}}% — and we show what it still misses. Same app on Mac." |
| 2:52–3:00 | Icon + tagline + GitHub URL | "Airlock. The best AI, without giving yourself away." |

Avoid: real brand names of other AI products, real personal data, any legal/medical "advice" phrasing. All names in the video are fictional.

## 4. README final checklist

- [ ] One-paragraph value proposition at the top.
- [ ] 20-second GIF of seal → answer.
- [ ] Architecture diagram (from `02-ARCHITECTURE.md` §1, rendered as an image).
- [ ] Table "Where Firebase AI Logic is used" with file paths (kept current).
- [ ] Inference-mode rationale table (from `02-ARCHITECTURE.md` §5).
- [ ] Evaluation results table with CIs and "what we still miss".
- [ ] Setup instructions (bootstrap, own Firebase project, App Check debug token).
- [ ] Honesty statement and limitations.
- [ ] Built during the submission period; AI agents used; licence.

## 5. Testing instructions (for the form)

```
Airlock is an iOS app (also runs on macOS). There's no TestFlight build (no paid Apple Developer account), so:

Option A — watch the demo video (all features shown on the iOS Simulator and the Mac app).

Option B — run it yourself (Apple-silicon Mac, macOS 26+ with Apple Intelligence enabled, Xcode with a matching iOS Simulator runtime):
1. git clone <repo> && cd airlock && ./scripts/bootstrap.sh
2. Create a Firebase project, enable AI Logic (Gemini Developer API), add an iOS app with bundle id app.airlock.ios, download GoogleService-Info.plist into App/Resources/Firebase/dev/.
3. Enable App Check for AI Logic; run the app once; copy the debug token from the Xcode console into App Check → Manage debug tokens.
4. Run the "Airlock (Dev)" scheme on an iPhone Simulator.
Sample texts to paste are in /demo-samples (all fictional).

If you'd like us to register your App Check debug token on our demo project instead, email <team address> and we'll do it within 24 hours (until 16 Dec).
```

## 6. Final hour checklist (30 Nov)

- [ ] Open repo in an incognito window: public, licence in About, README renders, no secrets.
- [ ] YouTube video public, ≤ 3:00, English captions.
- [ ] Devpost form: all fields, platform iOS, repo URL, video URL, testing instructions, existing-code statement (none).
- [ ] Demo Firebase project funded and live through 16 Dec.
- [ ] Tag the submitted commit `v1.0-submission`.
