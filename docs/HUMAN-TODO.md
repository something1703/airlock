# HUMAN-TODO — things only a person can do

Agents: add items here whenever you hit something needing a console, billing, a device, an account or a human decision (`AGENTS.md` §11). Tick items off with the date when they're done. Never put secrets in this file.

Google Cloud / Firebase account for Airlock: the team's Google account (decided 16 Nov).

---

## ▶︎ Start here (18 Nov) — everything still waiting on a person, in order

All coding work is on `main` and the web app is live on the dev project. These are the only things left that an agent can't do.

**Quick (minutes, free)**
1. **App Check, web** (project `airlock-hybrid-dev-f1bb0`, not the other one): Firebase console → App Check → Apps → the web app → reCAPTCHA → paste the reCAPTCHA **secret** key → Save. Keep enforcement **off** for now.
2. **App Check debug tokens** (H-07): run each app once; it prints a debug token (browser console on localhost, Xcode console for the Simulator and the Mac, `adb logcat` for Android). Add each under App Check → Manage debug tokens. Never commit them.
3. **Optional but sensible:** the reCAPTCHA secret was pasted into a chat once. Rotate it at google.com/recaptcha/admin, then repeat step 1 with the new secret.
4. **Mac signing** (for the Keychain on macOS): Xcode → the Airlock target → Signing & Capabilities → Team → your free Apple ID. Tell the agent the Team ID (it isn't secret).
5. **Mac screenshots:** System Settings → Privacy & Security → Screen & System Audio Recording → allow Terminal (or the app running the agent).
6. **Chrome Gemini Nano** (H-12) and **Apple Intelligence on this Mac** (H-05): needed to see real on-device inference rather than the demo engines.
7. **Rate limit + key restrictions** (H-08, H-09) before sharing the web link widely.
8. **Check Anonymous sign-in is on** (sealed-history backup needs it): Authentication → Sign-in method → Anonymous → Enabled.

**Decisions only you can make**
9. **Proof mode's Search grounding returns 429** on the free tier. Options: leave Proof's claim-check on the demo engines for judges, or enable billing on the demo project (see 11).
10. **Publish the Android APK** as a GitHub release (public content; the agent will do it once you say yes).
11. **Demo project on Blaze** (H-14), with a $100 budget and alerts. This unlocks Model Armor, Cloud Functions deploy (already built and emulator-tested) and Sensitive Data Protection. The agent waits for your OK on the cost check.
12. **Swift "Protect this"**: web and Android have it. On iOS it touches `AirlockSeal`, so the agent needs you to approve a plan first.

**Benchmark (last, your explicit permission only)**
13. **Sprint 3 quota form** (H-16) by **Wed 25 Nov, 10:00 AM PT**. Then say the word, and the live AirlockBench run happens on that separate account. The Evidence screens update from Remote Config `evidence_json` without a redeploy.

**Submission**
14. Discord question (H-13), testers (H-18), voice-over and YouTube (H-19), contact email (H-20), keep the demo live until 16 Dec (H-21), Android on real Nano hardware via Test Lab or a borrowed phone (H-10).

### Done on 17–18 Nov
reCAPTCHA site registered (the site key is in the gitignored `web/.env.local`), repo public on GitHub (H-17), web app deployed to Hosting on dev.

### Done on 17 Nov
Xcode 27.2 + iOS 27.2 Simulator, Temurin 21 + Android command-line tools, Firebase projects, AI Logic (Gemini Developer API) on dev, `firebase login`. The agent then registered the iOS/Mac/Android/Web apps, downloaded their configs to gitignored paths, enabled the App Check and Firestore APIs, created the Firestore database (`nam5`) and deployed Remote Config (26 parameters, verified).

## ▶︎ Earlier list (16 Nov)

1. **Xcode setup** (unblocks the iOS/Mac app): in Terminal run
   `sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch`
   then Xcode → Settings → Components → install the **iOS 27 Simulator**.
2. **Firebase console** (unblocks every real AI call): H-02, H-03, then `firebase login` (H-04).
3. **Chrome Gemini Nano** (unblocks web on-device): H-12. Check `chrome://on-device-internals` shows the model as ready.
4. **Android tools, no Android Studio needed** (H-11): `brew install --cask temurin@21 android-commandlinetools` (asks for your password). The agent installs the SDK packages with `sdkmanager` and builds the APK from the command line.
5. **Android on-device testing** (H-10): no supported phone on the team. The plan is a real Pixel in **Firebase Test Lab** (free daily quota, runs on Spark), else **Samsung Remote Test Lab** (free with a Samsung account), else borrow a Pixel 9/10 or Galaxy S25+.
6. **Discord questions** (H-13) — Tue 17 Nov. **Sprint 3 quota form only** (H-16): the window opens **Mon 23 Nov** and closes **Wed 25 Nov, 10:00 AM PT (11:30 PM IST)**. Skip Sprint 2.

## 🔴 Blocking coding work

| # | Task | How | Unblocks | Status |
|---|------|-----|----------|--------|
| H-01 | Finish installing **Xcode 27.x** + the **iOS 27 Simulator runtime**, open Xcode once to accept the licence, then run `sudo xcode-select -s /Applications/Xcode.app` | App Store / Xcode → Settings → Components | All iOS/Mac work, WP-01 API spike, app target | ✅ 17 Nov |
| H-02 | **Add Firebase to both Cloud projects** (accept Firebase terms) | console.firebase.google.com → Create a project → "Add Firebase to Google Cloud project" → pick `airlock-hybrid-dev`; skip Analytics. Repeat for `airlock-hybrid-demo` | App registration, config files, rules deploy | ✅ 17 Nov |
| H-03 | **Enable AI Logic** on `airlock-hybrid-dev` | Firebase console → AI Services → AI Logic → Get started → **Gemini Developer API** | Any real AI call | ✅ 17 Nov |
| H-04 | Run **`firebase login`** in a terminal with the team's Google account, then tell the agent | Terminal | Agent registers iOS/Mac/Android/Web apps, downloads configs, deploys rules/Remote Config | ✅ 17 Nov |
| H-01b | Finish Xcode's **first-launch setup** so `xcodebuild` and the Simulator work: run `sudo xcodebuild -runFirstLaunch` (or just open Xcode once and let it install components), then **Xcode → Settings → Components → iOS 27 Simulator** | Terminal / Xcode | `xcodebuild` currently fails: CoreSimulator not installed | ✅ 17 Nov |
| H-05 | Confirm **Apple Intelligence is on** and its model has finished downloading on this Mac | System Settings → Apple Intelligence & Siri | On-device model in the Simulator | ☐ |

## 🟠 Needed this week

| # | Task | How | Deadline | Status |
|---|------|-----|----------|--------|
| H-06 | Enable **App Check** (enforce for AI Logic, Firestore, Functions) and **Anonymous auth**; create a **Firestore** database | Firebase console | Before first end-to-end run | ☐ |
| H-07 | Register **App Check debug tokens** (iOS Simulator, Mac, Android, web localhost) as each app first runs — the token prints in the console/logcat | Firebase console → App Check → Manage debug tokens. **Never commit them** | As each platform comes up | ☐ |
| H-08 | Set AI Logic **per-user rate limit to 30 req/min** | Firebase console → AI Logic → Settings | Before the web app is public | ☐ |
| H-09 | Restrict the **API keys** (iOS bundle ids `app.airlock.ios` / `app.airlock.mac`, Android package + SHA-1, web HTTP referrer = Hosting domain) | Google Cloud console → APIs & Services → Credentials | Before the web app is public | ☐ |
| H-10 | **Borrow a Gemini Nano-capable Android phone** for on-device testing + the video. The team's Galaxy S21 FE is *not* supported. Supported: Galaxy S25/S26 series, Z Fold7/Flip7 or newer, Pixel 9/10 series | Friend / college / family | Before Android on-device work (~WP Android-03) | ☐ |
| H-11 | Install **Android Studio** (+ Android SDK, an emulator image) | developer.android.com/studio | Android work | ✅ 17 Nov |
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
| H-17 | Push the repo to GitHub (public, Apache-2.0 visible in About). Pick the account and repo name | When the agent asks to commit/push | ✅ 17 Nov |
| H-18 | Recruit 3–5 testers for 20-minute sessions (`docs/07-EVALUATION.md` §8) | 27–28 Nov | ☐ |
| H-19 | Voice-over, YouTube upload (public, ≤ 3:00, English captions) | 29 Nov | ☐ |
| H-20 | A team contact email for judges (debug-token registration offer) | Before submission | ☐ |
| H-21 | Keep `airlock-hybrid-demo` funded and live until **16 Dec** | Through judging | ☐ |
