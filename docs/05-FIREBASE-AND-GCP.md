# 05 — Firebase and Google Cloud

Steps marked **👤 human** need console access, billing or an Apple ID. Agents prepare everything else (config files, rules, functions, scripts) and leave clear instructions in the PR.

---

## 1. Projects

| Project | Purpose | AI backend | Billing |
|---------|---------|-----------|---------|
| `airlock-dev` | Day-to-day development, emulators, eval | Gemini Developer API (`.googleAI()`) | Spark (free) is enough; Blaze optional |
| `airlock-demo` | The build in the video and for judges; Model Armor second net | **Agent Platform** (formerly Vertex AI) — needed for Model Armor | Blaze, with budget alert + cap |

Remote Config key `ai_backend` (`googleAI` | `agentPlatform`) selects the backend at launch. If billing on `airlock-demo` is blocked, the demo falls back to the Developer API and the Model Armor section of the video is replaced by the SDP "Scan with Google" button (F-45).

Keep `airlock-demo` alive and funded until **16 Dec 2026** (end of judging).

## 2. Setup checklist

1. 👤 Create both projects. Register two Apple apps in each: `app.airlock.ios` and `app.airlock.mac`. The Mac build is a native multiplatform SwiftUI target, not Mac Catalyst.
2. 👤 Firebase console → **AI Services → AI Logic → Get started**. Choose Gemini Developer API on `airlock-dev`; Agent Platform Gemini API on `airlock-demo`.
3. 👤 Download `GoogleService-Info.plist` for each; put them at `App/Resources/Firebase/dev/` and `…/demo/` (gitignored). Build configuration `Debug-Dev` / `Debug-Demo` copies the right one (XcodeGen pre-build script).
4. Agent: add SPM package `https://github.com/firebase/firebase-ios-sdk` pinned **exactly** (≥ 12.13.0) in `project.yml`.
5. 👤 App Check → register the app → enforce for **Firebase AI Logic**, **Firestore**, **Cloud Functions**.
6. 👤 Authentication → enable **Anonymous** and **Google**.
7. 👤 Firestore → create database (Native mode, region close to users, e.g. `nam5` for the US-centred demo).
8. Agent: `firebase deploy --only firestore:rules,firestore:indexes,functions,remoteconfig` from `firebase/`.
9. 👤 AI Logic → per-user rate limit: **30 requests/minute** (default is 100).
10. 👤 Google Cloud console → API key restrictions: iOS app restriction to the bundle ids; API restrictions to the Firebase services used, including `firebasevertexai.googleapis.com`.
11. 👤 Billing (demo) → budget alert at $10 and $25; consider a hard cap.
12. 👤 Enable AI monitoring in the Firebase console (shows cloud calls only — on-device calls are invisible there, which is itself a nice demo point).

## 3. App bootstrap (Swift sketch)

```swift
@main
struct AirlockApp: App {
    init() {
        #if DEBUG
        AppCheck.setAppCheckProviderFactory(AppCheckDebugProviderFactory())
        #else
        AppCheck.setAppCheckProviderFactory(AirlockAppCheckFactory())   // App Attest on device, DeviceCheck fallback
        #endif
        FirebaseApp.configure()                                          // after App Check factory
    }
    var body: some Scene { WindowGroup { RootView() } }
}
```

- The debug token is printed on first launch in the Xcode console. 👤 Register it under App Check → Apps → Manage debug tokens. Never commit it.
- To keep a stable token in the Simulator, set the scheme environment variable `FIRAAppCheckDebugToken` in a **user-specific, gitignored** scheme (🔍 confirm the variable name in the SDK).

## 4. Authentication

- First launch: `Auth.auth().signInAnonymously()`.
- Optional "Back up and sync" → link Google account (`GoogleSignIn` is a separate SPM package — **not allowed** by our dependency rule; use Firebase Auth's `OAuthProvider("google.com")` web flow 🔍 verify; if not feasible, ship anonymous-only and mark F-51 sync as C).
- Account deletion: Settings → Delete everything → deletes local stores, Keychain items, Firestore user tree (callable function `deleteUserData`), then the auth user.

## 5. Remote Config

Single source of truth: `firebase/remoteconfig.template.json`. Must match `AppConfig.defaults` in code (a unit test compares them).

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `ai_backend` | string | `googleAI` | `googleAI` or `agentPlatform` |
| `ai_location` | string | `global` | Agent Platform location |
| `model_cloud_deep` | string | `gemini-3.8-flash` | Deep answers, drafts, tool loop |
| `model_cloud_quick` | string | `gemini-3.5-flash-lite` | Cloud fallback for quick tasks |
| `model_cloud_max` | string | `gemini-4-hydrogen` | "Best quality" setting |
| `model_cloud_proof` | string | `gemini-3.8-flash` | Proof claim check with Search |
| `dial_default` | string | `balanced` | |
| `detect_chunk_tokens` | number | `1400` | On-device chunk budget |
| `redteam_enabled` | bool | `true` | |
| `redteam_rounds` | number | `2` | |
| `nltagger_enabled` | bool | `true` | Rule-question flag (Q-1) |
| `vision_ocr_enabled` | bool | `true` | Rule-question flag (Q-1) |
| `llm_structured_output` | bool | `false` | Switch to SDK structured output once verified |
| `pattern_packs_disabled` | string (JSON array) | `[]` | |
| `prompt_overrides_json` | string (JSON object) | `{}` | Hot-fix prompts |
| `feature_tools_calendar` | bool | `true` | |
| `feature_proof` | bool | `true` | |
| `feature_infer_card` | bool | `true` | |
| `feature_sync` | bool | `true` | |
| `evidence_json` | string (JSON) | bundled latest | Numbers for the Evidence screen |
| `min_supported_build` | number | `1` | Force-update prompt |
| `raw_purge_days` | number | `30` | Auto-delete raw captures |
| `armor_expected` | bool | `false` | `true` on `airlock-demo` when the Model Armor floor setting is live |
| `armor_force_unary` | bool | `false` | Use non-streaming deep answers so Model Armor screens them (until streaming coverage is confirmed) |

Fetch on launch with a 12-hour minimum interval (DEBUG: 0). Activate on next launch, except `prompt_overrides_json` and feature flags, which activate immediately.

## 6. Firestore

### 6.1 Data model

```
users/{uid}
  createdAt: timestamp
  dial: "open" | "balanced" | "strict"
  appVersion: string

users/{uid}/threads/{threadId}
  createdAt, updatedAt: timestamp
  title: string                    // generated from sealed text on device
  lastRoute: "phoneOnly"|"phoneFirst"|"cloudFirst"|"cloudOnly"
  turnCount: number

users/{uid}/threads/{threadId}/turns/{turnId}
  createdAt: timestamp
  role: "user" | "assistant"
  sealedText: string               // placeholders only — never restored text
  legend: string                   // the rendered legend exactly as sent (user turns); a string so the rules can check it
  route: string
  modelVersion: string
  receiptId: string | null

users/{uid}/receipts/{receiptId}
  seq: number
  createdAt: timestamp
  threadId: string
  route: string
  modelVersion: string
  outboundSha256: string
  outboundChars: number
  counts: map<string, number>
  gate: map
  armor: string
  latencyMs: map
  prevHash: string
  hash: string

users/{uid}/stats/{isoWeek}        // written by Cloud Function only
  requests: number
  sealedDetails: number
  onDeviceAnswers: number
  cloudAnswers: number
  byCategory: map<string, number>
```

### 6.2 Security rules (`firebase/firestore.rules`)

**As built (17 Nov):** the shipped rules are stricter than the sketch below — every collection uses a field **allow-list**, receipts are synced **without `outboundText`** (the exact text stays local; the hash proves it), `legend` is a string, thread titles also pass `looksSealed`, and everything outside `users/{uid}` is denied. Tested in `functions/test/rules.test.ts` against the emulator using the real web pipeline's sealed output and the web's own DTO builders (`web/src/app/syncDto.ts`). Clients sync only turn pairs whose answer has a receipt (already sent to Gemini), so on-device answers never leave the device.

Original sketch:

Defense in depth: even if an app bug tried to upload raw text, the rules reject obvious identifiers and forbidden fields.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function owner(uid) { return signedIn() && request.auth.uid == uid; }

    // Field names that must never exist in synced data.
    function noForbiddenKeys() {
      return !request.resource.data.keys().hasAny(
        ['raw', 'rawText', 'original', 'restored', 'entityMap', 'plaintext', 'surfaceForms']);
    }

    // Cheap server-side tripwire for sealed text. Not a substitute for the device gate.
    function looksSealed(s) {
      return s is string
        && s.size() <= 40000
        && !s.matches('(?s).*[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}.*')   // email
        && !s.matches('(?s).*[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{1,7}.*') // card-like
        && !s.matches('(?s).*[0-9]{3}-[0-9]{2}-[0-9]{4}.*');                        // SSN-like
    }

    match /users/{uid} {
      allow read, delete: if owner(uid);
      allow create, update: if owner(uid) && noForbiddenKeys()
        && request.resource.data.keys().hasOnly(['createdAt', 'dial', 'appVersion']);

      match /threads/{threadId} {
        allow read, delete: if owner(uid);
        allow create, update: if owner(uid) && noForbiddenKeys()
          && request.resource.data.title is string && request.resource.data.title.size() <= 80;

        match /turns/{turnId} {
          allow read, delete: if owner(uid);
          allow create: if owner(uid) && noForbiddenKeys()
            && looksSealed(request.resource.data.sealedText)
            && request.resource.data.role in ['user', 'assistant'];
          allow update: if false;   // turns are immutable
        }
      }

      match /receipts/{receiptId} {
        allow read, delete: if owner(uid);
        allow create: if owner(uid) && noForbiddenKeys()
          && request.resource.data.hash is string
          && request.resource.data.prevHash is string
          && request.resource.data.seq is int;
        allow update: if false;     // receipts are append-only
      }

      match /stats/{week} {
        allow read: if owner(uid);
        allow write: if false;      // Cloud Function only (Admin SDK bypasses rules)
      }
    }
  }
}
```

🔍 Test every regex in the Firestore emulator (`functions/test/rules.test.ts`) — RE2 syntax in rules differs from Swift regex.

### 6.3 Offline

Enable Firestore offline persistence (default on iOS). Sync is opportunistic; the app never waits for Firestore to show an answer.

## 7. Cloud Functions (`functions/`, TypeScript, v2)

**Status (17 Nov):** implemented and tested in the emulator (`functions/test/`); **not deployed** — Functions need the Blaze plan, and Blaze would make the dev project's Gemini Developer API usage billable. They deploy to the demo project (Blaze anyway for Model Armor) after an explicit cost check with the owner. `aggregateStats` is idempotent (a `statsSeen/{receiptId}` marker in the same transaction).

| Function | Trigger | What it does | App Check |
|----------|---------|--------------|-----------|
| `aggregateStats` | Firestore `onDocumentCreated('users/{uid}/receipts/{id}')` | Increments `users/{uid}/stats/{isoWeek}` | n/a |
| `scanSealed` | `onCall` | Runs Sensitive Data Protection `content.inspect` on **sealed** text (the user tapped "Scan with Google"), returns infoType findings. Rejects input > 20k chars. | `enforceAppCheck: true` |
| `deleteUserData` | `onCall` | Recursively deletes `users/{uid}` | `enforceAppCheck: true` |

`scanSealed` config: `infoTypes` = `ALL_BASIC` (or an explicit list: `EMAIL_ADDRESS, PHONE_NUMBER, CREDIT_CARD_NUMBER, IBAN_CODE, US_SOCIAL_SECURITY_NUMBER, PERSON_NAME, STREET_ADDRESS, LOCATION`), `minLikelihood: POSSIBLE`, `includeQuote: true`. The result card in the app says: "Google's Sensitive Data Protection found 0 personal details in what was sent." or lists findings with a "Fix" button.

Note: SDP is not a generative model; it is a classic detection service. It's used only on already-sealed text, by explicit user action.

## 8. Model Armor (demo project, Agent Platform backend)

Goal: a Google-side net behind our gate. Facts and caveats are in `API-NOTES.md` §5 — it fails open, covers `generateContent`, blocks rather than rewrites.

👤 Steps (commands to verify against current docs before running):

```bash
gcloud config set project airlock-demo
gcloud services enable aiplatform.googleapis.com modelarmor.googleapis.com dlp.googleapis.com logging.googleapis.com

# 1. Create a Model Armor template with the Sensitive Data Protection filter (basic config),
#    prompt-injection detection on, enforcement INSPECT_AND_BLOCK.
#    (Console: Security → Model Armor → Create template.)

# 2. Apply it project-wide to Vertex/Agent Platform Gemini via floor settings with Cloud Logging enabled:
gcloud model-armor floorsettings update \
  --full-uri=projects/airlock-demo/locations/global/floorSetting \
  ...   # flags per current docs: enable enforcement, integrated service = Vertex AI, INSPECT_AND_BLOCK, enable cloud logging
```

App handling:
- Response with `promptFeedback.blockReason == "MODEL_ARMOR"` → `EngineError.armorBlocked` → review screen with message (`06-UI-UX.md` §5.6). Receipt `armor: "blocked"`.
- Normal responses → `armor: "pass"` only when `ai_backend == agentPlatform` and `armor_expected == true`; otherwise `notConfigured`.
- Streaming coverage is unconfirmed: in the demo build, when Armor is the point being shown, deep answers use non-streaming `respond` (Remote Config `armor_force_unary`, default `false`). 🔍 Test streaming; if Armor screens streams, drop this flag.

Observability:
- Cloud Logging query saved as **"Airlock — Model Armor verdicts"**.
- Log-based metric `armor_blocks_count`; alert to email if > 0 in an hour (in the demo this proves the second net is wired).
- Screenshot for the README/video: the log view showing *zero* SDP findings across the benchmark run, and one intentional block during the demo.

## 9. Evaluation infrastructure

| Resource | Name | Purpose |
|----------|------|---------|
| Cloud Storage bucket | `gs://airlock-eval-<suffix>` | `datasets/`, `runs/{runId}/items.jsonl`, `reports/` |
| BigQuery dataset | `airlock_eval` | tables `runs`, `items`, `metrics` |
| Cloud Run Job | `airlock-scorer` (Python 3.12) | Reads a run, calls SDP `inspect` on each egress text, computes metrics, writes BigQuery, renders `reports/{runId}.md` |
| Looker Studio (optional) | "Airlock Evidence" | Charts for README/video |

BigQuery schemas (`eval/schemas/*.json`):

```
runs:    run_id STRING, created_at TIMESTAMP, git_sha STRING, prompt_ids STRING, dial STRING,
         config JSON, n_items INT64, notes STRING
items:   run_id STRING, item_id STRING, doc_type STRING, language STRING, words INT64,
         gold_count INT64, leaked_gold INT64, leaked_types ARRAY<STRING>, over_redactions INT64,
         sdp_findings INT64, attacker_hits JSON, judge_winner STRING, judge_quality INT64,
         restore_ok BOOL, seal_ms INT64, route STRING, on_device_answer BOOL
metrics: run_id STRING, metric STRING, value FLOAT64, ci_low FLOAT64, ci_high FLOAT64, slice STRING
```

The scorer is evaluation tooling only — it is not part of the app's runtime and does not run any generative model. Generative calls in evaluation (synthetic data, judge, attacker) run in **AirlockBench through Firebase AI Logic**, so every model call in the project goes through the hackathon's required SDK.

## 10. Analytics and Crashlytics

- Analytics (optional): event names only with numeric params — `seal_completed{entities, ms}`, `answer_shown{route}`, `gate_blocked{checks}`, `proof_verdict{verdict}`. No strings derived from user content. A lint check rejects `Analytics.logEvent` calls with string params outside an allowlist.
- Crashlytics: **not used in v1** (crash logs can capture in-memory strings; not worth the risk for a privacy product). Mention this in the README as a deliberate choice.

## 11. Cost guardrails

| Item | Expected | Guard |
|------|----------|-------|
| Gemini Developer API (dev) | Free tier for listed models | Per-user rate limit 30 RPM |
| Agent Platform Gemini (demo) | A few dollars | Budget alert $10/$25 |
| Model Armor | Free under 2M tokens/month | — |
| SDP inspect | Small (eval runs ≈ a few thousand items) | Run eval sparingly; cache results |
| Cloud Run Job, BigQuery, Storage | Cents | — |

If the team receives a hackathon Google Account Quota (4-day sprint accounts), use it on `airlock-demo` during the final sprint only. Sprint 3 request deadline: Wed 25 Nov, 10:00 AM PT; account sent Fri 27 Nov.
