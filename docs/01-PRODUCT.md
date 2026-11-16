# 01 — Product

## 1. One line

**Airlock lets you get the best AI's help with your most private problems, while the details that identify you never leave your phone.**

## 2. The problem

1. **People paste their lives into AI.** Leases, medical bills, HR disputes, breakup texts, family group chats. They get great help — and hand over names, addresses, employers, account numbers and other people's private details.
2. **AI products are asking for more, not less.** Personal-context assistants read mail, messages and photos; chat apps link bank accounts; agents shop and pay. Every new capability is a new reason to share more.
3. **"Just remove the names" doesn't work.** Research (ICLR 2024, *Beyond Memorization*) showed large models can still infer location, age and other attributes from text anonymised with commercial tools. Later work (2026, *From Weak Cues to Real Identities*) found LLM agents linking anonymised text back to real people.
4. **Blunt redaction breaks the help.** The PAPILLON research (2024) found simple redaction significantly drops answer quality; their best local+cloud pipeline kept quality on 85.5% of queries with leakage in 7.5%. That's research code, not a product anyone can use.
5. **The people with the most to lose** — a nurse reporting a colleague, a tenant in a dispute, an older person who got a strange "bank" text — either overshare or don't get help at all.

## 3. The insight

On-device models are small but private and free. Cloud models are brilliant but you have to hand over your data. **Use the small model as your agent at the border**: it reads everything, decides what leaves, attacks its own work, and translates the answer back. The cloud model gets the problem without the person.

Hybrid inference is the whole product here, not a fallback. Without the phone model there is nothing to protect you; without the cloud model there is no great answer.

## 4. Users

| Persona | Situation | What they need | Win for them |
|---------|-----------|----------------|--------------|
| **Maya**, 29, renter (Chicago) | Heater broken for 3 weeks; landlord stalling over texts; lease clause she doesn't understand | Plain-English explanation of the clause, questions to ask, a firm polite reply | Gets help without sending her address, landlord's name, unit number |
| **Daniel**, 41, ICU nurse | Wants to write to HR about a colleague's conduct | A clear, factual, calm complaint draft | Colleague names and hospital never leave the phone |
| **Aiko**, 34, freelance designer | Client contract with odd IP clause | Explanation of the clause and negotiation questions | Client name, fee and project details stay home (amounts kept only if she chooses) |
| **Ruth**, 67, retired teacher | Text from "her bank" asking her to confirm a code | Is this real? What should I do? | Verdict checked against the web; her account details never sent |
| **Sam**, 23 | Group chat fight with friends | How to apologise without making it worse | Friends' names and screenshots stay private |
| **Teams** (later) | Clinics, HR, small law firms banned from consumer AI | Policy-controlled safe use of frontier AI | Admin policy via Remote Config, audit trail |

## 5. Features

Priority: **M** = must (demo depends on it), **S** = should, **C** = could (stretch).

### 5.1 Core seal pipeline

| ID | Feature | Pri | Notes |
|----|---------|-----|-------|
| F-01 | Capture: paste/type | M | |
| F-02 | Capture: photo of a letter or chat screenshot → text (Vision OCR, on device) | S | Behind `vision_ocr_enabled` |
| F-03 | Capture: PDF import (PDFKit text extraction) | S | Text PDFs; scanned PDFs use F-02 per page |
| F-04 | Detect: Vault exact/alias match (always-protect list) | M | Deterministic, highest priority |
| F-05 | Detect: pattern rules (email, phone, URL, card w/ Luhn, IBAN, national IDs, dates, addresses via `NSDataDetector`, secrets like API keys/OTPs) | M | |
| F-06 | Detect: on-device LLM entity detection with role hints ("my landlord") and coreference | M | Phone-only session |
| F-07 | Merge + coreference ("Dr. Patel" = "Patel" = "Raj") | M | |
| F-08 | Policy engine: per category keep / generalise(level) / placeholder / block | M | |
| F-09 | Privacy dial: Strict / Balanced / Open presets | M | |
| F-10 | Red-team loop: on-device attacker guesses identity cues; generaliser rewrites them | S | Max 2 rounds |
| F-11 | Review screen: see exactly what leaves, toggle any chip, accept/reject red-team suggestions | M | Hero screen |
| F-12 | Egress gate: deterministic final check; the only way to create `SealedText` | M | |
| F-13 | Streaming-safe restore of answers | M | |

### 5.2 Getting help

| ID | Feature | Pri | Notes |
|----|---------|-----|-------|
| F-20 | Deep answer: cloud first (Gemini), on-device fallback when offline | M | |
| F-21 | Quick tasks on-device first: summarise, explain simply, list action items, rewrite tone | M | |
| F-22 | Draft a reply: Gemini drafts with placeholders, phone fills real names, one-tap copy | M | |
| F-23 | Private tools (function calling): `find_free_slots`, `get_entity_role`, `today_context` with per-call consent | S | Calendar via EventKit |
| F-24 | Follow-up questions in a thread (sealed history) | M | |
| F-25 | "What could the cloud still guess?" card | S | Cloud asked to infer from sealed text it already saw |
| F-26 | Read answer aloud with Apple's on-device voice | C | INV-10 |
| F-27 | Scrub & copy: produce a sealed version to paste anywhere (forum, adviser); paste-back restores | S | |

### 5.3 Proof mode (check before you trust)

| ID | Feature | Pri | Notes |
|----|---------|-----|-------|
| F-30 | On-device red-flag scan: urgency, secrecy, authority, unusual payment (gift cards, crypto, wire), credential/OTP requests, link mismatch | S | Raw text, phone-only |
| F-31 | Claim extraction on-device → seal → Gemini + Google Search check | S | Cloud only, respects Search display requirements |
| F-32 | Verdict card with sources and next steps | S | Words, not fake-precise percentages |

### 5.4 Trust and transparency

| ID | Feature | Pri | Notes |
|----|---------|-----|-------|
| F-40 | Receipt per request (outbound text, counts, route, model, latency, gate + Armor status) | M | |
| F-41 | Hash-chained ledger + "Verify chain" | S | |
| F-42 | Route badge on every answer from `modelVersion` | M | |
| F-43 | Weekly privacy report ("182 details stayed on your phone") | S | |
| F-44 | Evidence screen: our latest benchmark numbers, with misses | M | Judges love it |
| F-45 | "Scan with Google" button: Sensitive Data Protection scan of the sealed text via Cloud Function | C | |
| F-46 | Model Armor second net (Agent Platform backend) | S | Fails open — never primary |

### 5.5 Platform

| ID | Feature | Pri | Notes |
|----|---------|-----|-------|
| F-50 | Onboarding with Apple Intelligence check and Vault setup | M | |
| F-51 | Anonymous auth; optional Google sign-in to sync sealed threads | M / C | |
| F-52 | Firestore sync of sealed threads + receipts (opt-in toggle, default on) | S | |
| F-53 | Mac app (same target, NavigationSplitView) | S | Grand Prize favours multi-platform |
| F-54 | Share extension ("Ask Airlock" from any app) | C | Memory limits in extensions — test first |
| F-55 | `AirlockKit` open-source Swift package | S | Already the architecture; just document it |

## 6. Non-goals

- Not legal, medical or financial advice. Airlock explains, summarises and helps people prepare questions.
- Not perfect anonymity. We hide identity, not the situation.
- Not a deepfake detector. Proof mode checks claims and tactics, not pixels.
- Not a messaging app or E2E channel.
- Not an on-device replacement for Gemini — the point is to use Gemini safely.

## 7. Positioning

| Alternative | What it does | Why Airlock is different |
|-------------|--------------|--------------------------|
| Gemini / ChatGPT apps | Great answers | Raw data goes to the cloud |
| Apple Private Cloud Compute | Private processing for Apple's own models | Doesn't let you use other frontier models privately |
| Enterprise DLP / Model Armor | Blocks sensitive data | Blocks — doesn't help you get the answer. Airlock uses Model Armor as a safety net behind a helpful pipeline |
| Manual redaction | You delete names yourself | Slow, misses quasi-identifiers, ruins context |
| PAPILLON (research) | Local+cloud privacy delegation | Research code on desktop; Airlock is a phone product with review UI, restore, tools and receipts |

## 8. What winning looks like (hackathon metrics)

| Criterion | Our evidence |
|-----------|--------------|
| Technological implementation | All four inference modes used, each for a reason; type-level privacy invariants; red-team loop; private tool calling; Model Armor + SDP second nets; benchmark harness |
| Design | Complete app: onboarding → capture → review → answer → receipts → ledger → proof; iPhone + Mac; polished motion; accessible |
| Potential impact | Measured leak rate and quality vs. baselines; 5 real user tests with quotes; open-source `AirlockKit` |
| Quality of the idea | "The small model you own supervises the big model you rent" — a reusable pattern for every Firebase app |

## 9. Product targets (to measure, not to claim in advance)

| Metric | Target |
|--------|--------|
| Document-level leak rate (synthetic set, Balanced) | ≤ 5% |
| Direct-identifier recall | ≥ 97% |
| Answer quality vs. raw-to-cloud (LLM judge, win+tie) | ≥ 85% |
| Restore fidelity (no orphan or wrong placeholders) | ≥ 99% |
| Seal latency, 300-word input, M-series Mac Simulator | p50 ≤ 4 s |
| Share of quick tasks answered fully on device | ≥ 70% |
