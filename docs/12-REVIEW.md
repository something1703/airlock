# 12 — Review: is the vision done? (20 Nov 2026)

**Short answer: the idea is built end to end on the web, and it runs with real models. But it is not yet the product `01-PRODUCT.md` describes.** Three things stand between us and that vision:

1. **The privacy promise has holes.** An independent red-team found many inputs where a real identifier leaves with the gate passing and no warning. The gate can only check what detection already found.
2. **It is too slow and too rough to use.** Sealing an 85-word message took 84 seconds in Chrome on this Mac. The answer came back as raw Markdown, cut off mid-sentence.
3. **Only the web app is complete, and nothing is measured.** iPhone/Mac and Android are missing whole features, their on-device models have not been seen running for real, and every number we show is from a mock run.

Each problem below has an ID so fixes can refer to it.

---

## 1. How this was checked

| What | How | Date |
|------|-----|------|
| Live web app, real models | Fresh origin (`…firebaseapp.com`), Chrome's built-in model + Gemini through Firebase AI Logic, fictional data. Onboarding → Ask → Review → answer → guess card → Ledger → Proof → quick task → Vault → Settings | 20 Nov |
| Privacy engine, adversarial | A separate agent ran throwaway scripts against the real `SealPipeline` + `EgressGate` in `web/src/engine/` with **mock** models, no network. Each finding below marked **RAN** was executed; **READ** was inferred from code | 20 Nov |
| Feature coverage | Code search for every feature in `01-PRODUCT.md` §5 on each platform | 20 Nov |
| iPhone / Android look | Existing screenshots in `docs/screenshots/` only | — |

**Not checked:** iPhone/Mac with the real Apple model, Android with real Gemini Nano, the Mac app by hand, VoiceOver/TalkBack by ear, the benchmark with real models. The red-team used mock models, so a real model will catch some of what the mock "missed" — but the gate behaviour it exposed does not depend on the model.

The red-team scripts (`h.ts`, `t1.ts`–`t7.ts`) are saved in `.preview/redteam/` on the owner's Mac. That folder is not in git. They should become regression tests (see §6).

---

## 2. What works today

- **The core loop works with real models on the web.** In the live run the on-device model caught two people who were not in the Vault (a neighbour, a doctor), the address, the email and the phone number, and generalised the hospital. Gemini answered with placeholders and the device put the real details back correctly.
- **The red-team step found a real leak.** It flagged the employer name the detector left in ("works nights at Jewel-Osco") and offered a rewrite.
- **Receipts are honest.** The receipt shows the exact sealed text and legend that left, the hash chain verifies, and an on-device answer says "nothing sent — no receipt needed".
- **Quick tasks stay on the device.** "Summarise" was answered locally in 6.3 s with a correct route badge.
- **Fail-closed parts held up under attack** (RAN): secrets are never restored, unknown placeholders are flagged, streaming restore matched unary restore in 8,952 split tests, every tool result passes the gate, `SealedText` cannot be built outside the gate, saved turns are re-gated on load, and no raw or restored text reaches the Firestore backup DTOs.
- **Engineering discipline is real:** three engines held to one fixture suite, CI on every push, App Check live on web.

---

## 3. Problems

Severity: 🔴 breaks the promise or the demo · 🟠 serious · 🟡 polish.

### 3.1 The privacy promise

**PR-01 🔴 The gate only knows what was already detected.**
The gate checks Vault strings, pattern hits and the surface forms of entities already in the map. A name the model misses passes every check with `requiresReview = false`. So "enforced in code" is true for *detected* details only. This is the root of most findings below, and a sceptical judge will ask for the miss rate — which we have not measured (EV-01).

**PR-02 🔴 Proof mode sends model-written claims to Gemini + Google Search with no review step.** (RAN)
Input: a fake-police message naming an inspector, a police station, a neighbourhood, a son and a UPI ID. With the detector finding only the son's name, the claims went out containing the inspector's name, the station, the neighbourhood and `rajeshk@okhdfcbank`. `proof.ts:327,347` calls the gate directly; there is no Review screen on this path. Proof uses the Strict dial, which the docs say means "always review".

**PR-03 🔴 A name on its own, or in another letter case, gets through.** (RAN, all silent)
- Vault has `Maya Chen`, `Priya Sharma`, `José García`. These leave unchanged: `Ms Chen`, `M. Chen`, `Ms Sharma called.`, `Mr. García raised the rent.`, `José raised the rent.` — a user's own surname goes to the cloud. Cause: G1 checks whole canonical/alias strings only (`gate.ts:146`).
- After `Rajesh Kumar` is detected: `later kumar denied it`, `Signed: KUMAR`, `then rajesh ran`, `The Kumars' lawyer`, `rajesh_kumar.pdf` all pass. Cause: single-word terms are case-sensitive, need 3+ letters and exclude common words (`terms.ts:44,54,60`), so `Li`, `Rose`, `Hunter` also slip.
- The same holes apply to follow-up messages in a thread.

**PR-04 🔴 Hindi, Bengali and Tamil names are not matched at all.** (RAN)
Vault entry `राहुल वर्मा`, input `कल राहुल वर्मा आया था।` → sent unchanged, silently. `foldedSearch.ts:23` strips every combining mark, and vowel signs are marks, so the word-boundary test at line 89 rejects the match. It also over-matches (`राम` hits `रोम` and `रम`). The Swift and Kotlin ports will share this if they are faithful. For an India-based team this is the most embarrassing one to be shown.

**PR-05 🔴 Imperfect model output is dropped silently.** (RAN)
If the model returns a span that doesn't match the text exactly — `Mr. Rajesh Kumar` for `Rajesh Kumar`, a name across a line break, two spaces, `Jose Garcia` for `José García`, a curly apostrophe, an unknown type label like `FULL_NAME` — nothing is sealed and no review is forced. `hallucinatedDropped` is counted (`llmDetector.ts:198`) but never read (`pipeline.ts:200-215`).

**PR-06 🔴 Rules can undo a correct model answer.** (RAN)
`Patient, F, 04/03/1989` with the model correctly tagging a date of birth → sent unchanged. The date pattern hits the same span as a plain date, patterns outrank the model (`merger.ts:77`), and Balanced keeps plain dates (`policy.ts:52`).

**PR-07 🔴 Role hints carry free text to the cloud unchecked.** (RAN)
A model role like "the writer's oncologist at Tata Memorial Mumbai" goes into the outbound legend as `[[PERSON_1]] — the user's oncologist at Tata Memorial Mumbai`. The check (`sealer.ts:156-161`) only rejects long hints, `[[`, known surface forms and pattern hits. The `get_entity_role` tool returns the raw hint even when the legend was made generic (`tools.ts:652`); with "Always allow" there is no consent card.

**PR-08 🟠 Identifier formats the patterns miss.** (RAN)
A sample; the full list is in the red-team report:
- The same card number written a second way: `4111 1111 1111 1111` is sealed, `4111.1111.1111.1111` beside it is not, and the gate passes.
- Spelled-out email (`bob dot smith at example dot com`), en-dash SSN, lower-case IBAN, Devanagari/Arabic/Persian digits.
- UPI IDs, URLs without a scheme, social handles, lower-case PAN, GSTIN, vehicle registration, coordinates, IPv6.
- Postcodes and non-US addresses (`Jodhpur 342001`, `H.No. 12-B, Sardarpura`, `Hauptstraße 12, 10115 Berlin`).
- Dates of birth in words or with the keyword far away; OTPs and passwords without a trigger word; the JWT header segment.

**PR-09 🟠 Partial seals that pass the gate.** (RAN)
`josé.garcía@example.com` → `josé.garcí[[CONTACT_1]]`; `ftp://rahul:hunter2@files…` → `ftp://rahul:[[CONTACT_1]]/home/rahul`; Vault `Priya Sharma` in `…/team/priya-sharma` → `…/team/[[PERSON_1]]-sharma`.

**PR-10 🟠 Natural variants defeat the Vault.** (RAN)
`Anne Marie` for `Anne-Marie`, `Zoe Mueller` for `Zoë Müller`, `Rajeshji`, `Raju`, `#PriyaSharma`, `priyasharma.com`, `Mercy` alone for `Mercy General Hospital`, and any cross-script spelling (`Priya Sharma` vs `प्रिया शर्मा`).

**PR-11 🟠 "Mandatory review" is only a banner.** (READ, `Review.tsx:143,221`)
When the on-device model is unavailable the app shows a warning line, but Send stays enabled, there is no acknowledgement, and nothing marks which words went unchecked. The Android live screenshot shows the result: rules-only mode left `Mercy General Hospital` in the sent text.

**PR-12 🟠 Red-team findings are opt-in.** (live run)
The employer name stayed in the outgoing text until I pressed "Use suggestion". Send was enabled the whole time. A privacy tool should default to the safer choice and let the user undo it.

**PR-13 🟠 The cloud decides which real value appears where.** (RAN)
Every contact has the legend "contact details", so the cloud cannot tell an email from a phone number: `his email is [[CONTACT_2]]` restored to a phone number, with the fidelity check clean. Worse, a pasted scam message's phone number becomes `[[CONTACT_3]]`, and an answer saying "your bank's helpline is `[[CONTACT_3]]`" is restored to the scammer's number, shown as trusted restored data.

**PR-14 🟡 Smaller gate gaps.** (RAN)
- A name split across a hard chunk boundary is seen whole by no chunk (`chunker.ts:29-46,70`); the overlap the docs promise does not happen for single-sentence chunks.
- A fake placeholder such as `[[KUMAR_1]]` is masked from G1–G3 (`gate.ts:44`).
- Some invisible characters and look-alikes are not normalised (`Prıya`, `Pri⁪ya`), though the docs say that class is closed.
- The model's reply is backed up to Firestore without a client-side check (READ, `syncDto.ts`).

### 3.2 How it works in practice (live run)

**UX-01 🔴 Sealing is far too slow.**
| Step | Measured | Target (`01-PRODUCT.md` §9) |
|------|----------|------|
| First seal, 85 words (new origin, includes model warm-up) | 64.8 s to Review, 84.0 s with the red-team check | p50 ≤ 4 s for 300 words |
| Second seal, 36 words | 27.9 s | |
| Proof, 2 sentences | ~62 s on device, ~80 s total | |

A person can get a raw answer from any chatbot in 3 seconds. Nobody waits a minute to be private. This is the biggest threat to "potential impact".

**UX-02 🔴 The wait shows nothing.** For the whole detection step the raw text sits there with a sweep animation. Vault and pattern hits are known in milliseconds but are not highlighted until the model finishes. The design doc promises progressive highlights.

**UX-03 🔴 Answers show raw Markdown on the web.** `### What Is Going On`, `**Breach of Lease**`, `---` and `*` bullets appear as typed. The web has no Markdown rendering. (Android renders it.)

**UX-04 🔴 The answer was cut off mid-sentence** ("…and any receipts if you have had to purchase"). `maxOutputTokens` is 1500 for deep answers (`answer.ts:45`), and nothing tells the user it was truncated or offers to continue.

**UX-05 🔴 "What could Gemini still guess?" failed** with "Gemini's reply couldn't be read as a list. Try again." — and there is no button to try again. Likely the same cause: 700 output tokens (`infer.ts:40`) truncating the JSON. It still wrote a receipt and counted as a request.

**UX-06 🟠 Generalising breaks the text and hides useful facts.**
- `repairs within 14 days` became `repairs within Two-week turnaround required for repairs..` — a whole sentence dropped into the middle of one. "14 days" identifies nobody.
- `$1,850` was labelled an **ID** ("monthly rent") and hidden, although Balanced says amounts are kept. The cloud never saw the rent.
- After accepting the red-team suggestion the sent text read "I works nights at a local retail store on a local business on a main street".

**UX-07 🟠 Red-team findings are noisy.** On a harmless work message it warned "Someone could still guess 3 things about you": that the writer "works for a company that holds quarterly offsites" (because of "Q3 offsite") and is a "Team member" (because of "Team"). In the first run the second finding quoted its own earlier rewrite and suggested the text that was already there. False alarms teach people to ignore the real one.

**UX-08 🟠 Review is a long scroll before you can send.** Sealed text → guesses → "Protect something" → a 12-row details list → task chips → Send. On a laptop the Send button is about three screens down.

**UX-09 🟠 On-device tasks go through "Check before sending".** A "Summarise" request that never leaves the device still runs the full seal and red-team (28 s), shows "This is exactly what will leave your device", and its thread is headed "What Gemini saw". Gemini saw nothing.

**UX-10 🟠 Proof mode's web check does not work on the free tier.** "Gemini's web check has reached its limit for now." The three red flags shown were all tagged "rule"; a minute of on-device model time produced nothing visible. The verdict ("Likely a scam") was right and the failure was graceful, but the headline feature is absent.

**UX-11 🟠 The Ledger over-counts.** After one message with 12 protected details it showed "24 details kept off the cloud this week", because the guess request re-sent the same sealed text and was counted again (`ledger.ts:63`). An inflated privacy number in a privacy app is a credibility risk.

**UX-12 🟠 Answers read like legal advice.** The live answer was headed "Breach of Lease and Habitability" and cited the "implied warranty of habitability". The system prompt forbids this, the model drifts anyway, and the answer card carries no "not legal advice" line. This matters for our own non-goals and for Apple's acceptable-use rules.

**UX-13 🟠 Inputs that trap the user.** (RAN)
`My password is hunter2 which I set last week.` is blocked by the gate, and each "Protect this" only peels one more word. `PIN code 342001` (a postal code) becomes an unrestorable secret. Input over 60,000 characters is silently cut (`pipeline.ts:87`); over 40,000 it is blocked with only "a message that's too long".

**UX-14 🟡 Small things.**
- Review says "Gemini sees only the left-hand version" (`Review.tsx:229`); there is no left-hand version.
- The receipt says "Checks passed: G1 G2 G3 G4 G5 G6 G7" — meaningless to a user.
- Receipts for "what could Gemini guess" look identical to the original request.
- A new thread is first titled "Hi someone the heater at a place" until the on-device title arrives; on Android without Nano it stays that way.
- On Android the answer began "Hello you." (the "me" placeholder restored as the word "you").
- Counts on Review are confusing: "12 protected · 3 made less specific" where the 3 are inside the 12.
- On iPhone the floating tab bar covers the bottom buttons on Review and the follow-up box.
- The onboarding "Get started" button is below the fold on a 13-inch laptop.

### 3.3 The concept

**CN-01 Privacy rests on a small model's recall, and the user is the backstop.** The design is honest about this ("detection isn't perfect, so you review"). But review only works if people read it, and UX-07 and UX-08 push them to click through.

**CN-02 "Who, not what" leaves a lot.** The live request still told Gemini the writer has asthma, works nights in retail, rents, and the date the heater broke. For the personas with the most to lose — a nurse reporting a colleague — the story itself can identify them. The guess card is the right answer to this, when it works (UX-05).

**CN-03 Privacy costs answer quality, and we haven't measured how much.** Hiding the rent and mangling "14 days" made the request worse. The 85% quality target is untested.

**CN-04 The legend is a side channel by design.** "the user's doctor", "the user's neighbor's apartment" go to the cloud to keep answers useful. That is a fair trade, but it is extra signal, and PR-07 shows it is not controlled.

**CN-05 On the web, the user has to trust the website.** The page's code is served fresh on every visit, raw text is kept for 30 days in the same browser as its key, and Chrome's built-in model needs desktop Chrome with ~22 GB free. On Safari, Firefox or a phone the web app is rules-only — the weakest mode (PR-11). A native app can make stronger claims than a web page can.

**CN-06 Three engines triple every fix.** Each privacy fix above must land in TypeScript, Swift and Kotlin plus fixtures. That is the price of the multi-platform story.

**CN-07 Restore creates a new kind of trust problem.** Underlined restored values look verified, but the cloud chose where they go (PR-13).

### 3.4 Platform coverage

✅ in code · ⚠️ partly · ❌ not found.

| Feature | Web | iPhone / Mac | Android |
|---------|-----|--------------|---------|
| Seal, Review, gate, restore, receipts, Ledger, Vault, dial | ✅ | ✅ | ✅ |
| Red-team loop (F-10) | ✅ | ✅ | ✅ |
| "Protect this" (user adds a detail) | ✅ | ❌ (needs AirlockSeal plan approval) | ✅ |
| What could Gemini guess (F-25) | ⚠️ failed live (UX-05) | ✅ | ❌ |
| Scrub & copy (F-27) | ✅ | ✅ | ❌ |
| Private tools (F-23) | ✅ | ❌ | ❌ |
| Proof mode (F-30–32) | ⚠️ web check hits quota | ❌ | ❌ |
| Sealed-history backup (F-52) | ✅ | ❌ | ❌ |
| Evidence screen (F-44) | ✅ mock data | ✅ mock data | ✅ mock data |
| Photo / PDF capture (F-02, F-03) | ❌ | ❌ | ❌ (config flag only) |
| Read aloud (F-26), Scan with Google (F-45), Google sign-in (F-51) | ❌ | ❌ | ❌ |
| Share into the app (F-54) | ❌ | ❌ | ✅ |
| On-device model seen running for real | ✅ Chrome | ❓ no record; screenshots use demo engines | ❌ emulator has no Nano |
| Model Armor (F-46) | code only; needs the demo project | same | same |

The vision calls the iPhone the main product and Mac a bonus. In reality the web is the product and the two native apps are partial copies whose on-device inference is unproven.

### 3.5 Evidence and claims

**EV-01 🔴 None of the six product targets is measured.**

| Target | Goal | Status |
|--------|------|--------|
| Document-level leak rate | ≤ 5% | Not measured. The only number in the app is 41.7%, from a mock run |
| Direct-identifier recall | ≥ 97% | Not measured |
| Answer quality vs raw | ≥ 85% | Not measured |
| Restore fidelity | ≥ 99% | Not measured on real models |
| Seal latency | p50 ≤ 4 s | 28–84 s observed on web |
| Quick tasks on device | ≥ 70% | Not measured; worked in the one case tried |

**EV-02 🟠 The mock numbers are in every app.** They sit under a "MOCK RUN" banner, but a judge skimming sees "Leak rate 41.7%" in large type. Until the real run, consider hiding the figures and showing only the method.

**EV-03 🟠 "User tests with quotes" and the weekly report claims in `01-PRODUCT.md` §8 have nothing behind them yet.**

---

## 4. Is the vision done?

| Part of the vision | Verdict |
|--------------------|---------|
| "The small model you own supervises the big model you rent" | **Demonstrated** on the web with real models |
| "The details that identify you never leave" | **Not yet.** True for what is detected; many silent misses (§3.1) |
| A complete, polished product | **Web: close but rough** (§3.2). **Native: partial** (§3.4) |
| Proof you can show a judge | **Receipts yes, numbers no** (§3.5) |
| All four hybrid modes used for a reason | On device, cloud, and on-device-first are exercised live on web. Worth re-checking that each mode is visible in the demo |

---

## 5. Suggested order of work

Ordered by what a judge would hit first.

1. **Make the web answer readable and complete** — UX-03, UX-04, UX-05. Small changes, large effect on every demo.
2. **Cut the wait and fill it** — UX-01, UX-02, UX-09. Show Vault and pattern hits at once; skip sealing for tasks that stay on the device; measure where the 28–84 s goes before optimising.
3. **Close the silent name leaks** — PR-03, PR-05, PR-06, then PR-04. Treat partial names and other letter cases as terms; force review when model spans are dropped; never let a pattern downgrade a model finding.
4. **Stop Proof sending unreviewed text** — PR-02.
5. **Make the safer choice the default** — PR-11, PR-12, PR-07. A real acknowledgement in rules-only mode; red-team rewrites applied unless undone; role hints limited to a fixed vocabulary.
6. **Fix what makes the output worse** — UX-06, UX-07, PR-13. Generalise to a phrase of the same grammatical shape; keep amounts in Balanced; filter trivial guesses; give contacts a subtype in the legend.
7. **Honest numbers** — UX-11, EV-02, then the real benchmark run (owner's permission).
8. **Decide the native story.** Either bring iPhone and Android up to the web (Proof, tools, backup, guess card, "Protect this") or say plainly that the web is the reference app and the native apps show the same engine. Both need one real on-device run each.
9. **Pattern coverage and the rest** — PR-08, PR-09, PR-10, PR-14, UX-13, UX-14.

Every privacy fix needs a fixture in `spec/fixtures` first, so all three engines must pass it.

## 6. Follow-ups for this document

- Turn the red-team scripts in `.preview/redteam/` into tests in the repo.
- Re-run §3.2 on the live site after the fixes and record new timings.
- Run the same walkthrough on a real iPhone or the Simulator with Apple Intelligence on, and on a Nano-capable Android phone.

## 7. Fix log

| IDs | Status | Commit / note |
|-----|--------|---------------|
| UX-01 sealing too slow | **Partly fixed, not yet measured live.** Timings are measured and shown (`1cd45f6`); `detect.v2` (about a third of the output, no per-detail `gen.v1` calls) is built but off until a live check on a real model (`e41e0ab`, `docs/API-NOTES.md` "FX-02 timing notes"); Review no longer waits for the red-team in any dial (`d83073b`) | Target not yet confirmed: p50 ≤ 4 s |
| UX-02 the wait shows nothing | **Fixed** | `5bd4041`: rule hits highlighted at once with "N details found so far" |
| UX-09 on-device tasks go through Review | **Fixed** | `026fe35`: quick tasks and "This device only" are answered from the raw message with no seal, Review or receipt; failures fall back to the normal flow. Cost: a cloud follow-up in such a thread does not see the earlier local exchange |
| UX-03, UX-04, UX-05 | Fixed on the web earlier | `99d0c88` |
