# 03 — The Privacy Engine (seal → red-team → gate → restore)

This is the most important document. Everything in `AirlockSeal`, `AirlockDetect` and `AirlockRestore` must match it. Human review required for any change.

---

## 1. Pipeline at a glance

| Stage | Module | Runs on | Deterministic? | Output |
|-------|--------|---------|----------------|--------|
| 1. Ingest & normalise | Detect | Device | Yes | `NormalisedText` + offset map |
| 2. Chunk | Detect | Device | Yes | `[Chunk]` within on-device budget |
| 3. Detect (D1 vault, D2 patterns, D3 NL tagger, D4 LLM) | Detect | Device | D1–D3 yes, D4 no | `[Candidate]` |
| 4. Merge & coreference | Detect | Device | Yes (+ D4 hints) | `[Entity]` with spans |
| 5. Policy | Seal | Device | Yes | each entity → action |
| 6. Draft seal | Seal | Device | Yes | `SealDraft` (string + legend) |
| 7. Red-team loop | Seal | Device (LLM) | No | `[Risk]` + suggested rewrites |
| 8. Human review | App | Device | — | user edits |
| 9. Egress gate | Seal | Device | **Yes** | `SealedText` or `GateBlocked` |
| 10. Send | Route | Cloud/Phone | — | stream |
| 11. Restore | Restore | Device | Yes | answer with real values |
| 12. Receipt | Ledger | Device (+sync) | Yes | `Receipt` |

---

## 2. Categories

| Category | Examples | Placeholder | Default action (Balanced) |
|----------|----------|-------------|---------------------------|
| `person` | Names, nicknames, usernames referring to a person | `[[PERSON_n]]` | placeholder + role hint |
| `org` | Employer, school, clinic, landlord company, client | `[[ORG_n]]` | generalise L2 ("a large hospital") |
| `location` | Street address, unit no., neighbourhood, small town, city | `[[LOC_n]]` | address → placeholder; city → generalise L2 (region) |
| `contact` | Email, phone, URL with identifiers, social handle | `[[CONTACT_n]]` | placeholder |
| `id` | Gov ID, passport, account, card, IBAN, policy/case/claim/order no., licence plate | `[[ID_n]]` | placeholder |
| `date` | DOB, exact dates tied to the person | `[[DATE_n]]` | DOB → age range; other dates **kept** (answers depend on them) |
| `health` | Named condition, medication, procedure tied to a person | `[[HEALTH_n]]` | keep in Open; generalise in Balanced ("a chronic condition") **only if user enables Health category**; default keep (the question is usually about it) |
| `secret` | Passwords, OTP codes, API keys, recovery phrases, PINs | `[[SECRET_n]]` | **block**: always replaced and the user is warned ("You pasted a one-time code. Never share these.") |
| `quasi` | Rare job titles, unique events, distinctive details found by red-team | — (rewritten in place) | generalise when red-team flags it |

Money amounts are **kept** by default in all dials except Strict (where they're bucketed: "about $1,200" → "around $1,000–1,500").

### 2.1 Privacy dial presets

| Category | Open | Balanced (default) | Strict |
|----------|------|--------------------|--------|
| person | placeholder | placeholder | placeholder |
| org | keep | generalise L2 | generalise L3 |
| location (address) | placeholder | placeholder | placeholder |
| location (city/town) | keep | generalise L2 | generalise L3 |
| contact, id | placeholder | placeholder | placeholder |
| date (DOB) | age range | age range | age decade |
| date (other) | keep | keep | relative ("3 weeks ago") |
| health | keep | keep (toggle) | generalise |
| money | keep | keep | bucket |
| secret | block | block | block |
| red-team | off | suggest (user accepts) | auto-apply |
| review screen | only if risk | if any low-confidence or risk | always |

### 2.2 Generalisation ladders

| Category | L0 (exact) | L1 | L2 | L3 |
|----------|-----------|----|----|----|
| location | "14 Elm St, Apt 3B, Springfield, IL" | "Springfield, IL" | "a mid-sized city in Illinois" | "a city in the US Midwest" |
| org | "Mercy General Hospital ICU" | "Mercy General Hospital" | "a large hospital" | "a healthcare employer" |
| age | "37" | "late 30s" | "30s" | "adult" |
| date (DOB) | "4 Mar 1989" | "1989" | "late 30s" | "adult" |
| job title | "Chief Perfusionist" | "perfusionist" | "a specialist clinician" | "a healthcare worker" |
| money (Strict) | "$1,240" | "about $1,200" | "$1,000–1,500" | "a four-figure amount" |

Generalised text for L2/L3 comes from the on-device generaliser prompt (`gen.v1`), validated: the output must not contain any surface form of the entity and must be ≤ 8 words. If validation fails, use the category's default L3 phrase.

---

## 3. Stage 1 — Ingest and normalise

- Unicode NFKC normalisation; collapse runs of whitespace; normalise smart quotes. Keep an **offset map** from normalised to original indices so the review UI highlights the original text correctly.
- Detect language with `NLLanguageRecognizer` (flagged with NL tagger; fallback "und"). Language affects token estimates and pattern sets.
- Strip zero-width characters (common in pasted chats and also a classic way to dodge filters).
- Max input: 60,000 characters (≈ 15k words). Above → ask the user to pick a section.

## 4. Stage 2 — Chunking for the on-device limit

The on-device model rejects requests over **4,096 tokens** (prompt + output). We can't count tokens through the SDK in hybrid mode, so we estimate conservatively:

| Script | Estimate |
|--------|----------|
| Latin scripts | `tokens ≈ chars / 3.2` |
| CJK, Indic, Arabic, Cyrillic | `tokens ≈ chars / 1.8` |

Budget per detector call: instructions (~650 tokens) + input chunk + output (reserve 1,100). Input chunk target = `detect_chunk_tokens` (Remote Config, default **1,400**).

Algorithm:

1. Split into sentences (`NLTokenizer(unit: .sentence)`; fallback regex `(?<=[.!?])\s+`).
2. Greedily pack sentences until the estimate reaches the budget.
3. Overlap: repeat the last sentence of chunk *k* at the start of chunk *k+1* (catches names split by boundaries).
4. A single sentence over budget → hard split at whitespace near the budget.
5. If the engine returns `contextTooLong`, halve the budget for that chunk and retry (max 2 times).

Detected spans are mapped back to global offsets; duplicates from overlaps are removed in merge.

## 5. Stage 3 — Detectors

Run in this order; all candidates go to the merger.

### 5.1 D1 — Vault matcher (deterministic, highest priority)

- Vault entries: `{canonical, aliases[], category, roleHint, alwaysAction}` set by the user (onboarding + Vault screen). E.g. *Maya Chen* (me), *Raj Patel* (my landlord), *Mercy General* (my employer).
- Matching: case-insensitive, diacritic-insensitive, word-boundary; also possessives ("Raj's") and first-name-only when the alias list includes it.
- Vault matches are `confidence: .high`, source `.vault`, and **cannot be un-sealed in review** without an explicit long-press "Reveal this time".

### 5.2 D2 — Pattern detectors

| Detector | Method | Validator |
|----------|--------|-----------|
| Email | regex (RFC-lite) | — |
| Phone | `NSDataDetector(.phoneNumber)` + E.164-ish regex | ≥ 7 digits |
| URL with identifiers | `NSDataDetector(.link)`; flag if path/query contains tokens like id, user, token, ≥ 8 alnum | — |
| Street address | `NSDataDetector(.address)` | — |
| Dates | `NSDataDetector(.date)` → category `date`; DOB if preceded by "born", "DOB", "birthday" | — |
| Card numbers | `\b(?:\d[ -]?){13,19}\b` | Luhn |
| IBAN | `\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b` | mod-97 |
| US SSN | `\b\d{3}-\d{2}-\d{4}\b` | not 000/666/9xx |
| UK NI | `\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b` | — |
| Generic national IDs | table-driven per country in `PatternPacks/*.json` (India Aadhaar/PAN, Canada SIN, etc.) | per-pack checksum |
| Passport-like | context word ("passport") within 5 tokens + 6–9 alnum | — |
| Policy/claim/case/order/ref no. | context word within 5 tokens + `[A-Z0-9-]{6,}` | — |
| OTP / codes | context ("code", "OTP", "verification") + 4–8 digits | → `secret` |
| API keys / secrets | known prefixes (`sk-`, `AIza`, `ghp_`, `xox`), high-entropy strings ≥ 24 chars | Shannon entropy ≥ 3.5 → `secret` |
| Licence plates | context word + plate-like token | — |
| Social handles | `@[A-Za-z0-9_.]{2,30}` not in an email | — |

Pattern packs are JSON files in the bundle; Remote Config can disable a pack (`pattern_packs_disabled`).

### 5.3 D3 — NaturalLanguage tagger (flagged `nltagger_enabled`)

`NLTagger(tagSchemes: [.nameType])` → `personalName`, `placeName`, `organizationName`. Confidence `.medium`. Cheap and fast; improves recall when the LLM detector misses. Fully optional so the app works if organisers say it's out of bounds.

### 5.4 D4 — On-device LLM detector

- Engine: `PhoneOnlyEngine`, temperature 0 (greedy if available).
- Prompt: `detect.v1` (`docs/04-PROMPTS.md`). Output is JSON with a fixed schema.
- **Why the LLM:** catches what patterns can't — "my landlord Raj", "the only clinic in Hillsboro", employer names without "Inc.", nicknames, coreference hints, role hints.
- Parsing:
  1. Extract the first `{…}` block. Strip code fences.
  2. Decode with a lenient decoder (unknown keys ignored, missing optional fields defaulted).
  3. **Validate every entity text is an exact substring of the chunk** (case-sensitive first, then case-insensitive). Drop hallucinated spans, log count to local metrics.
  4. On failure: one retry with `detect-repair.v1` including the broken output. Second failure → mark chunk `llmFailed`, rely on D1–D3, force review.
- If the SDK exposes a structured-output API for the system model (🔍 `API-NOTES.md`), switch to it behind `llm_structured_output` flag; keep the parser as fallback.
- Guardrail refusal → `EngineError.refused` → chunk marked, forced review, highlighted in UI.

## 6. Stage 4 — Merge and coreference

1. **Span overlap resolution.** Sort candidates by start. When spans overlap: higher-priority source wins (`vault > pattern > llm > nl`); on ties, longer span wins; category conflicts → priority category order `secret > id > contact > person > org > location > date > health > quasi`.
2. **Entity clustering (coreference).**
   - Normalise names: lowercase, strip titles (Dr, Mr, Mrs, Ms, Prof), strip possessive.
   - Same cluster if: exact normalised match; token subset ("Patel" ⊂ "Raj Patel") **and** same category **and** not ambiguous (only one candidate superset); or LLM `same_as` points to a mention in the cluster.
   - Ambiguity (two people share "Sam") → keep separate entities; mark both `.medium`; review UI shows "Are these the same person?" chip merge control.
3. **IDs** are assigned in order of first appearance per category: `PERSON_1`, `PERSON_2`, … stable for the whole thread (new entities in follow-ups continue numbering).
4. **Role hints** come from the LLM (`role`) or the Vault. Role hints must not contain identifying text themselves; they pass a mini-gate (no surface forms, no D2 patterns).
5. **Containment extension (as built, 16 Nov).** If a losing span *contains* exactly one winner of the same category (Vault "Raj" inside LLM "Raj Patel"), the winning mention grows to the whole span. Otherwise "Patel" would be left in the text.
6. **Losers are never forgotten.** A dropped candidate's text becomes a surface form of the same-category entity that beat it, so the gate (G2) still blocks it if it appears anywhere.
7. Clustering processes longer names first, so a short form sees every possible superset before it is assigned.

## 7. Stage 5–6 — Policy and draft seal

- Apply the dial preset, then per-category overrides from Settings, then per-entity user overrides from review.
- Build the sealed string by replacing spans **right to left** (offsets stay valid).
- Each action:
  - `placeholder` → `[[PERSON_1]]`
  - `generalise(level)` → generalised phrase inline (no placeholder — the cloud sees "a large hospital"). The restorer does not swap these back; the answer naturally talks about "the hospital", which is fine. If the user wants the real name in the final draft, the entity is also given a placeholder and the legend says "[[ORG_1]] — the user's employer, a large hospital".
  - `keep` → unchanged
  - `block` → `[[SECRET_n]]` and a warning; the legend says only "a secret the user should not share".
- **Legend** (sent with the text):
  ```
  [[PERSON_ME]] — the user
  [[PERSON_1]] — the user's landlord
  [[LOC_1]] — the user's apartment address
  [[ORG_1]] — the property management company
  ```
  The user's own name always maps to `[[PERSON_ME]]` with the legend "the user". Their name never appears in a legend line.

## 8. Stage 7 — Red-team loop

Purpose: catch quasi-identifiers — combinations of harmless-looking details that point to one person (small town + rare job + specific event).

```
draft₀ = sealDraft
for round in 1...redteam_rounds (default 2):
    guesses = PhoneOnly(attack.v1, draftᵣ)            // JSON guesses with exact evidence quotes
    risky   = guesses where confidence ≥ medium
                     and evidence is an exact substring of draftᵣ
                     and attribute ∈ {identity, location, employer, occupation, age, relationship, event}   // names as emitted by attack.v1
    if risky.isEmpty: break
    for each risky guess:
        rewrite = PhoneOnly(gen.v1, phrase=evidence, context=±1 sentence, task=userTask)
        validate(rewrite): shorter or equal specificity, no surface forms, keeps task-relevant meaning
        suggestions.append(Risk(guess, evidence, rewrite))
    if dial == strict: apply all suggestions → draftᵣ₊₁
    else: present suggestions in review; stop looping
```

- Max 2 rounds, max 6 suggestions per round (sorted by confidence).
- The loop never sends anything to the cloud.
- Each Risk card in the UI shows: *what a reader could guess* (in plain words), *because of* (quoted evidence), *suggested change*, buttons **Use suggestion** / **Keep as is** / **Edit**.
- **As built (16 Nov, `AirlockSeal/RedTeam.swift`):** evidence is matched as written in the draft (exact case first, then case-insensitive) and must not be only placeholders; a suggestion must pass `Generaliser.validate` (which now includes partial entity names) **and** keep exactly the evidence's `[[…]]` tokens, else the card offers only Keep/Edit. `RedTeam.apply` is deterministic and idempotent and skips evidence it can't find, so accepted suggestions survive chip toggles (`SealPipeline.reseal(acceptedRisks:)`). Pending risks add review reason `.risks(count)`; if the check can't run (unavailable / refused / unparseable) the reason is `.redTeamUnavailable` and Review is forced. `GateReport.counts["redteamApplied"]` counts applied rewrites.
- Inspired by feedback-guided adversarial anonymisation (ICLR 2025), adapted to a 3B on-device model by keeping each call small and validating every output deterministically.

## 9. Stage 9 — Egress gate (deterministic, the only constructor of `SealedText`)

Input: final draft string + legend + entity map + vault.

Checks (all must pass):

| # | Check | Fail action |
|---|-------|-------------|
| G1 | No vault canonical or alias appears (case/diacritic-insensitive, word boundary) | Block, highlight |
| G2 | No surface form of any entity whose action is placeholder/block appears | Block |
| G3 | Re-run all D2 pattern detectors on the draft and legend: zero hits for contact/id/secret/address | Block |
| G4 | Every placeholder in the draft is well-formed and exists in the legend | Block (bug) |
| G5 | Legend lines contain no surface forms and no D2 hits | Block |
| G6 | No zero-width or homoglyph tricks: draft re-normalised NFKC equals itself | Block |
| G7 | Size ≤ cloud limit for the chosen task | Route to chunked long-doc flow |

Additions as built (16 Nov; `AirlockSeal/EgressGate.swift`):

- **Homoglyph skeleton.** G1, G2 and G5 run on the text *and* on a copy where common Cyrillic/Greek look-alikes are mapped to Latin, so "Мауа" (all Cyrillic) still matches the Vault entry "Maya". G6 also blocks any word that mixes Latin with Cyrillic/Greek letters.
- **Name tokens (G2).** Besides whole surface forms, each person-name token of ≥ 3 letters is checked case-sensitively ("Patel" alone is caught). Tokens that are everyday words ("Will", "May", "Rose", titles) are excluded, so "I will call" doesn't false-block.
- **Partial names (G2).** For organisations and places too: contiguous sub-phrases of ≥ 2 words ("Mercy General" from "Mercy General Hospital") and distinctive capitalised words ≥ 4 letters ("Mercy"), excluding generic words ("Hospital", "Street"). Found when a test showed an on-device rewrite "the Mercy General campus" passing both validation and the gate; `Generaliser.validate` now uses the same terms, and the property test has a sixth mutation (partial organisation name).
- **Placeholders are masked** before G1–G3 so our own tokens (`[[PERSON_ME]]`) can never match a surface form.
- **Allowances.** Vault entries the user revealed this time are skipped by G1, and values the user explicitly marked "Not private" are skipped by G3. Both come from the Review screen, never from a model.
- **G4 also blocks unused legend lines** (a legend line is outbound text too).
- **G7 limit** defaults to 40,000 UTF-16 units of text + legend, the same limit as the Firestore `looksSealed` rule.
- **`GateBlocked` carries no values** — only the check, the category and a span to highlight (INV-8).
- **`GateReport.bypassed`** is true only for the DEBUG `sealBypassingChecks` path (compiled out of Release).
- Verified by a 10,000-case seeded property test (`EgressGatePropertyTests`): every mutation (surface form, Vault alias with random case/diacritics, card/IBAN/email/phone/SSN, zero-width variant, homoglyph variant) blocks; every clean draft passes.

Output: `SealedText(value, legend, gateReport{checksPassed, counts per category, hash})`. `outboundSha256 = sha256(value + "\n\n" + rendered legend)`.

The gate also runs on **tool results** (INV-5) and on **follow-up messages** in a thread.

Developer-only switch `debug_disable_gate` exists in DEBUG builds solely to demo the Model Armor second net in the video. It is compiled out of Release builds (`#if DEBUG`), and its use is shown on screen with a red banner.

## 10. Stage 10 — Cloud instructions

Every cloud call includes the system instruction `cloud-system.v1` (see prompts): keep placeholders exactly, never guess identities, refer to the user as "you", keep amounts/dates as given, no advice framing in regulated domains (explain + questions to ask + suggest a professional when relevant).

## 11. Stage 11 — Restore

### 11.1 Placeholder grammar

Canonical: `\[\[(PERSON|ORG|LOC|CONTACT|ID|DATE|HEALTH|SECRET)_(\d+|ME)\]\]`

Tolerated variants (models sometimes mangle): `[PERSON_1]`, `PERSON_1`, `[[ PERSON_1 ]]`, `[[Person_1]]`, `[[PERSON 1]]`, `【PERSON_1】`. The parser normalises them **only** when the id exists in the entity map; otherwise it leaves text alone.

### 11.2 Display form

- `PERSON_n` → canonical name the first time, then the shortest unambiguous surface form ("Raj").
- `PERSON_ME` → "you"/"I" are already natural; if the model wrote `[[PERSON_ME]]`, restore to the user's first name in drafts written *as* the user (signature), else "you".
- `SECRET_n` → never restored. Shown as a coral chip "hidden code".
- Possessives: `[[PERSON_1]]'s` → "Raj's".
- Unknown id (model invented `[[PERSON_9]]`) → shown as grey chip "unknown person" + a debug metric.

### 11.3 Streaming-safe algorithm

```
buffer = ""
for chunk in stream:
    delta = snapshotsAreCumulative ? chunk.content.dropFirst(lastLength) : chunk.content
    buffer += delta
    while true:
        if let start = buffer.firstIndex(of: "[") ?? lookalikeOpen(buffer):
            emit(restoreComplete(buffer[..<start]))
            if let end = closingIndex(buffer, from: start), end - start ≤ 32:
                emit(restoreToken(buffer[start...end])); buffer.removeFirst(upTo: end+1); continue
            if buffer.count - start > 32: emit(buffer[start]); buffer.removeFirst(start+1); continue
            break   // wait for more text
        else: emit(restoreComplete(buffer)); buffer = ""; break
flush(buffer)
```

Restored ranges are recorded so the UI can underline them and show the placeholder on tap.

### 11.4 Fidelity checks (after the full answer)

- Every placeholder in the answer resolved or flagged.
- No surface form appears in the answer *that wasn't introduced by restore* (would mean the model guessed a real name — log + show a coral notice "Gemini mentioned a name you didn't share").

## 12. Stage 12 — Receipt

```json
{
  "id": "rcpt_0042",
  "seq": 42,
  "createdAt": "2026-11-21T10:14:03Z",
  "threadId": "thr_7f3",
  "route": "cloudFirst",
  "modelVersion": "gemini-3.8-flash",
  "outboundSha256": "9c1e…",
  "outboundChars": 1840,
  "counts": {"person": 3, "org": 1, "location": 2, "contact": 1, "id": 1, "secret": 0, "generalised": 2, "redteamApplied": 1},
  "gate": {"passed": true, "checks": ["G1","G2","G3","G4","G5","G6","G7"]},
  "armor": "pass | blocked | notConfigured | unknown",
  "latencyMs": {"seal": 3120, "network": 2050},
  "prevHash": "4ab0…",
  "hash": "SHA256(prevHash || canonicalJSON(receipt without hash))"
}
```

The local receipt also stores the full sealed outbound text (so the user can see exactly what was sent). Firestore stores everything **except** the outbound text by default (setting "Back up sent text" adds the sealed text — still sealed).

"Verify chain" recomputes every hash from genesis; the UI animates each link turning green.

## 13. Known limitations (say these out loud in README and video)

1. A 3B on-device model will miss things. Layers D1–D3, red-team, review and the gate exist because of that.
2. Generalisation reduces specificity, not to zero. The cloud still learns the shape of the situation.
3. Writing style can identify people (stylometry). Out of scope for v1; Strict mode can offer "neutral rewrite before sending" (C).
4. Images are converted to text on device; the image itself is never sent.
5. If the user turns off review and Apple's model is unavailable, protection drops to rules — the app forces review in that case.
