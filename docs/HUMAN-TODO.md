# HUMAN-TODO — things only a person can do

Agents: add items here whenever you hit something needing a console, billing, a device, an account or a human decision (`AGENTS.md` §11). Tick items off with the date when they're done. Never put secrets in this file.

Google Cloud / Firebase account for Airlock: the team's Google account (decided 16 Nov).

---

## 🔴 Blocking coding work

| # | Task | How | Unblocks | Status |
|---|------|-----|----------|--------|
| H-01 | Finish installing **Xcode 27.x** + the **iOS 27 Simulator runtime**, open Xcode once to accept the licence, then run `sudo xcode-select -s /Applications/Xcode.app` | App Store / Xcode → Settings → Components | All iOS/Mac work, WP-01 API spike, app target | ⏳ downloading (16 Nov) |
| H-02 | **Add Firebase to both Cloud projects** (accept Firebase terms) | console.firebase.google.com → Create a project → "Add Firebase to Google Cloud project" → pick `airlock-hybrid-dev`; skip Analytics. Repeat for `airlock-hybrid-demo` | App registration, config files, rules deploy | ☐ |
| H-03 | **Enable AI Logic** on `airlock-hybrid-dev` | Firebase console → AI Services → AI Logic → Get started → **Gemini Developer API** | Any real AI call | ☐ |
| H-04 | Run **`firebase login`** in a terminal with the team's Google account, then tell the agent | Terminal | Agent registers iOS/Mac/Android/Web apps, downloads configs, deploys rules/Remote Config | ☐ |
| H-01b | Finish Xcode's **first-launch setup** so `xcodebuild` and the Simulator work: run `sudo xcodebuild -runFirstLaunch` (or just open Xcode once and let it install components), then **Xcode → Settings → Components → iOS 27 Simulator** | Terminal / Xcode | `xcodebuild` currently fails: CoreSimulator not installed | ☐ |
| H-05 | Confirm **Apple Intelligence is on** and its model has finished downloading on this Mac | System Settings → Apple Intelligence & Siri | On-device model in the Simulator | ☐ |

## 🟠 Needed this week

| # | Task | How | Deadline | Status |
|---|------|-----|----------|--------|
| H-06 | Enable **App Check** (enforce for AI Logic, Firestore, Functions) and **Anonymous auth**; create a **Firestore** database | Firebase console | Before first end-to-end run | ☐ |
| H-07 | Register **App Check debug tokens** (iOS Simulator, Mac, Android, web localhost) as each app first runs — the token prints in the console/logcat | Firebase console → App Check → Manage debug tokens. **Never commit them** | As each platform comes up | ☐ |
| H-08 | Set AI Logic **per-user rate limit to 30 req/min** | Firebase console → AI Logic → Settings | Before the web app is public | ☐ |
| H-09 | Restrict the **API keys** (iOS bundle ids `app.airlock.ios` / `app.airlock.mac`, Android package + SHA-1, web HTTP referrer = Hosting domain) | Google Cloud console → APIs & Services → Credentials | Before the web app is public | ☐ |
| H-10 | **Borrow a Gemini Nano-capable Android phone** for on-device testing + the video. The team's Galaxy S21 FE is *not* supported. Supported: Galaxy S25/S26 series, Z Fold7/Flip7 or newer, Pixel 9/10 series | Friend / college / family | Before Android on-device work (~WP Android-03) | ☐ |
| H-11 | Install **Android Studio** (+ Android SDK, an emulator image) | developer.android.com/studio | Android work | ☐ |
| H-12 | Enable **Gemini Nano in Chrome** on this Mac for web on-device testing: Chrome ≥ 148, `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` → Enabled, restart; keep ≥ 22 GB free | Chrome | Web on-device testing | ☐ |
| H-13 | Post the organiser questions in Discord `#hackathon-help` (filter tag #BuildHybridAI). Agent drafts them in `docs/11-RISKS-AND-DECISIONS.md` §1 — add Q-5: "Does a hosted web app + iOS + Android app of the same product qualify for multi-platform Grand Prize consideration?" | Devpost Discord | Tue 17 Nov | ☐ |

## 🟡 Money — ask before spending

| # | Task | Notes | Status |
|---|------|-------|--------|
| H-14 | Decide when to **link billing** (Blaze) to `airlock-hybrid-demo` | Needed for Cloud Functions, Agent Platform backend, Model Armor, SDP. Expected ~$10–25 through 16 Dec excluding the benchmark. Set a budget of $100 with alerts at 25/50/75/100% | ☐ |
| H-15 | **Benchmark runs last, only with explicit owner permission, on a separate Google Cloud account.** | Agents build and test the bench with mocks only until then | ☐ |
| H-16 | Request the **Google Account Quota, Sprint 3** (fits "benchmark last"): request by **Wed 25 Nov, 10:00 AM PT (11:30 PM IST)**; account arrives Fri 27 Nov, valid 4 days. ID + selfie verification first — start early | Devpost → #BuildHybridAI → Overview tab, section "Google Account Quota (optional)" → link "submitting this request form" (also Resources tab, step 2) | ☐ |

## 🟢 Later (submission)

| # | Task | When | Status |
|---|------|------|--------|
| H-17 | Push the repo to GitHub (public, Apache-2.0 visible in About). Pick the account and repo name | When the agent asks to commit/push | ☐ |
| H-18 | Recruit 3–5 testers for 20-minute sessions (`docs/07-EVALUATION.md` §8) | 27–28 Nov | ☐ |
| H-19 | Voice-over, YouTube upload (public, ≤ 3:00, English captions) | 29 Nov | ☐ |
| H-20 | A team contact email for judges (debug-token registration offer) | Before submission | ☐ |
| H-21 | Keep `airlock-hybrid-demo` funded and live until **16 Dec** | Through judging | ☐ |
