# 06 — UI and UX

Airlock must feel calm, trustworthy and quietly impressive. The user should *see* privacy happen, not read about it. Two moments carry the whole product: **the seal** (identifiers turning into chips and the airlock door closing) and **the return** (the answer arriving with real names flowing back in).

Native SwiftUI, iOS 26+ design language (Liquid Glass materials on iOS 27 via system components — don't fake glass with custom blurs). iPhone first; iPad and Mac use `NavigationSplitView`.

---

## 1. Design principles

1. **Show, don't promise.** Every claim ("14 details stayed on your phone") is backed by something the user can tap to see.
2. **The user is in control at the border.** Nothing leaves without a clear moment where the user can see it and stop it.
3. **Calm by default, loud only for risk.** Neutral surfaces; colour is reserved for meaning (sealed, on-device, cloud, review, risk).
4. **Honest words.** Never "100% private", "anonymous", "unhackable". Say what actually happens.
5. **Fast feels safe.** The seal step must feel quick: progressive reveal, skeleton states, no blocking spinners over 1 s without explanation.

## 2. Design tokens (`App/DesignSystem/Tokens.swift`)

### 2.1 Colour

All colours defined as asset-catalog colours with light/dark variants. Contrast ≥ 4.5:1 for text, ≥ 3:1 for chips and icons.

| Token | Light | Dark | Meaning |
|-------|-------|------|---------|
| `bg.base` | `#F6F7F9` | `#0B111C` | App background |
| `bg.raised` | `#FFFFFF` | `#141C2B` | Cards |
| `text.primary` | `#0E1726` | `#EEF2F8` | |
| `text.secondary` | `#4A5568` | `#A3AEC2` | |
| `seal` | `#0FA97E` | `#2BD9A6` | Protected / stayed on phone |
| `seal.tint` | `#E3F7F0` | `#123A30` | Chip background |
| `phone` | `#0FA97E` | `#2BD9A6` | On-device route (same family as seal on purpose) |
| `cloud` | `#3366E8` | `#6E97FF` | Cloud route |
| `review` | `#B7791F` | `#FFC062` | Needs your attention |
| `risk` | `#D64545` | `#FF7A6E` | Leak risk, blocked, secret |
| `stroke` | `#E2E6EC` | `#24304A` | Hairlines |

Category chip colours (icon + label always accompany colour):

| Category | SF Symbol | Tint (light/dark) |
|----------|-----------|-------------------|
| Person | `person.fill` | `#0FA97E` / `#2BD9A6` |
| Organisation | `building.2.fill` | `#5B5BD6` / `#9C9CFF` |
| Place | `mappin.circle.fill` | `#0E8FA3` / `#4CC9DB` |
| Contact | `envelope.fill` | `#3366E8` / `#6E97FF` |
| ID / number | `number.square.fill` | `#4A5568` / `#A3AEC2` |
| Date | `calendar` | `#9A6B1F` / `#E2B66A` |
| Health | `cross.case.fill` | `#C2417A` / `#FF8FBF` |
| Secret | `key.fill` | `#D64545` / `#FF7A6E` |
| Generalised | `wand.and.stars` | `#6B7280` / `#B8C0CC` |

### 2.2 Typography

System fonts only, Dynamic Type everywhere.

| Style | Font | Use |
|-------|------|-----|
| `display` | `.largeTitle.bold()` (SF Pro Rounded) | Onboarding, Ledger hero number |
| `title` | `.title2.weight(.semibold)` | Screen titles |
| `headline` | `.headline` | Card titles |
| `body` | `.body` | Text |
| `chip` | `.callout.weight(.medium)` | Chip labels |
| `mono` | `.footnote.monospaced()` | Placeholders in receipts, hashes |

### 2.3 Spacing, shape, elevation

- Spacing scale: 4, 8, 12, 16, 24, 32, 48.
- Corner radius: chips 8 (capsule when single word), cards 20, sheets system.
- Cards: `bg.raised`, 1-pt `stroke`, no heavy shadows (one soft shadow in light mode only, y=2 blur=8 alpha 0.06).

### 2.4 Motion

| Name | Spec | Reduce Motion fallback |
|------|------|------------------------|
| `seal.detect` | Detected spans fade to `review` highlight in reading order, 30 ms stagger, max 600 ms total | Instant highlight |
| `seal.morph` | Highlight morphs into chip (`matchedGeometryEffect`), spring(response 0.35, damping 0.8) | Crossfade 150 ms |
| `seal.door` | Two rounded panels slide shut over the outbound preview, 450 ms, then a small seal icon pulses once; `.success` haptic | Fade to sealed state, haptic kept |
| `return.flow` | Restored tokens get a 600 ms `seal` underline shimmer as they stream in | Static underline |
| `chain.verify` | Each receipt row ticks green in sequence, 40 ms stagger | All at once |

Haptics: `.selection` on chip toggle, `.success` on seal, `.warning` on risk card appear, `.error` on gate block.

## 3. Components (`App/DesignSystem/Components/`)

| Component | Description | Key states |
|-----------|-------------|-----------|
| `PlaceholderChip` | Inline token showing category icon + label ("Person 1 · landlord"). Tap: peek original (Face ID if from Vault). Long-press: menu (Reveal this time, Generalise, Always protect, Not private). | sealed, generalised, revealed (dashed outline), secret (coral, cannot reveal), low-confidence (amber dot) |
| `RouteBadge` | Capsule: icon + model + time. "iPhone · 0.6 s · nothing sent" or "Gemini 3.8 Flash · 2.1 s". Built from `EngineResult.modelVersion`. | phone, cloud, offline-fallback, blocked |
| `SealSummaryBar` | "14 details sealed · 2 generalised · amounts kept" + chevron to details | |
| `RiskCard` | Amber card: "A reader could still guess…", evidence quote, suggestion diff, buttons | pending, accepted, kept |
| `SealButton` | Primary button "Seal & send". Disabled with reason when gate would fail. | enabled, sealing (progress ring), blocked |
| `DiffView` | Side-by-side (regular width) or toggle (compact) "You wrote" / "Leaves your phone" | |
| `StreamingAnswer` | Markdown-lite renderer; restored tokens underlined; copy button copies restored text | streaming, done, error |
| `ToolConsentCard` | "Gemini asked your phone: free times next week" → preview of exactly what will be shared → Allow once / Always / Don't share | |
| `ReceiptRow` | Seq, time, route icon, counts, chain status dot | |
| `PrivacyDial` | 3-segment control with one-line description per segment | |
| `AvailabilityBanner` | Apple Intelligence state + fix | notEligible, off, downloading |
| `OfflineBanner` | "Offline — answers come from your iPhone" | |
| `EvidenceTile` | Big number + label + "how we measured" link | |
| `VerdictCard` | Proof result | likelyScam, unclear, likelyLegit |

All components have `#Preview`s in light/dark and at Dynamic Type XXXL.

## 4. Information architecture

iPhone tab bar (4 tabs):

1. **Ask** — compose, recent threads
2. **Proof** — check a message
3. **Ledger** — receipts, weekly report, verify chain
4. **Vault** — always-protect people, places, organisations

Settings: gear in Ask's toolbar. Evidence: Settings → "How Airlock is tested", and a card on the Ledger.

iPad/Mac: sidebar with the same 4 sections + Settings; thread list in the content column; thread in detail. Mac adds a menu command **File → New Sealed Request (⌘N)** and drag-and-drop of text/PDF/images onto the window.

## 5. Screens

### 5.1 Onboarding (4 pages, skippable after page 2)

| Page | Visual | Copy | Interaction |
|------|--------|------|-------------|
| 1 | A sample message whose names glow and turn into chips (scripted animation, no model call) | **AI is great. Oversharing isn't.** Airlock lets you ask the smartest AI about private things, while the details that identify you stay on your phone. | Continue |
| 2 | Diagram: phone (green) → door → cloud (blue) | **Your phone reads it first.** Apple's on-device model finds names, places and numbers, and seals them before anything is sent. Gemini gets the problem, not the person. | Continue |
| 3 | Vault form | **Who should always be protected?** Add your name, family, your city, your workplace. Stored only on this device, encrypted. | Text fields with "+ Add"; suggestions: "Me", "Partner", "Workplace", "Home city". Skip allowed |
| 4 | Availability check + dial | **Choose how careful to be.** Strict / Balanced / Open with one-line explanations. Availability banner if Apple Intelligence is off. | Done → Ask |

Availability handling on page 4:
- `.available` → green check "Apple's on-device model is ready."
- `.appleIntelligenceNotEnabled` → amber banner "Turn on Apple Intelligence in Settings → Apple Intelligence & Siri. Until then, Airlock uses strict rules and asks you to check everything." + Open Settings.
- `.modelNotReady` → "Apple's model is still downloading…" with auto-refresh every 10 s.
- `.deviceNotEligible` → explanation + rules-only mode.

### 5.2 Ask (home)

```
┌───────────────────────────────┐
│ Ask                     ⚙︎     │
│ ┌───────────────────────────┐ │
│ │ What do you need help     │ │
│ │ with? Paste anything.     │ │
│ │                           │ │
│ └───────────────────────────┘ │
│ [📋 Paste] [📷 Photo] [📄 PDF] │
│ Quick: Explain · Reply · Summarise · Questions to ask │
│                               │
│ This week: 182 details stayed │
│ on your phone ›               │
│                               │
│ Recent                        │
│ ▸ Heater repair dispute  ☁︎ 2h │
│ ▸ HR complaint draft     ☁︎ 1d │
│ ▸ Summary of offer letter 📱 3d│
└───────────────────────────────┘
```

- Compose field grows; placeholder text rotates through examples ("Paste a lease clause…", "Paste a tense text thread…").
- Intent chips set the task (`task.*.v1`); a free-text question field appears under the pasted content ("What do you want to know?").
- Photo: `PhotosPicker` → OCR on device (progress "Reading the image on your phone…"). PDF: `fileImporter` → PDFKit text.
- Primary action: **Continue** → starts the seal pipeline and opens Review.

### 5.3 Sealing (transition, not a separate screen)

Inline on Review while detection runs:
- Progress line: "Reading on your iPhone · section 2 of 3" with small `phone` icon. Never a full-screen spinner.
- Highlights appear progressively as chunks finish (`seal.detect`), then morph into chips (`seal.morph`).
- Red-team runs after; a subtle "Checking what someone could still guess…" line, then risk cards slide in.

### 5.4 Review (hero screen)

```
┌───────────────────────────────────────┐
│ ‹ Back            Review       Strict ▾│  (dial menu)
│ ┌─ You wrote ─┬─ Leaves your phone ─┐ │  (segmented on iPhone)
│ │ Hi [Person 1·landlord], the heater │ │
│ │ at [Place 1·your address] has been │ │
│ │ broken since Oct 28. I work nights │ │
│ │ at [a large hospital] and …        │ │
│ └────────────────────────────────────┘ │
│ 14 details sealed · 2 generalised ›    │
│ ┌ ⚠︎ A reader could still guess ─────┐ │
│ │ you live in a small town           │ │
│ │ because: "the only laundromat in   │ │
│ │ Hillsboro"                          │ │
│ │ Suggest: "the local laundromat"    │ │
│ │ [Use suggestion] [Keep] [Edit]     │ │
│ └────────────────────────────────────┘ │
│ Task: Help me reply firmly ▾           │
│ Answer with: Gemini (best) ▾           │
│ ┌──────────── Seal & send ───────────┐ │
└───────────────────────────────────────┘
```

Behaviours:
- Default segment: **Leaves your phone** (what matters).
- Tap any non-chip word → "Make this private" (adds a user entity, category picker).
- Tap chip → peek original. Chip menu: *Reveal this time*, *Generalise instead*, *Always protect* (adds to Vault), *Not private*.
- Same-person merge: two chips with an amber link icon "Same person?" → Merge / Keep separate.
- Low-confidence chips have an amber dot; VoiceOver says "possibly private".
- Answer-with menu: **Gemini (best)**, **iPhone only (nothing sent)**, **Best quality (Gemini 4 Hydrogen)**.
- Seal & send: runs the egress gate. Pass → `seal.door` animation → Thread. Fail → offending spans flash coral; banner "Airlock found something that would identify you: an email address. It's been highlighted."
- Strict always shows Review. Balanced auto-skips Review only when there are no risks and no low-confidence items — it then shows a 2-second "Sealed 6 details · Review" toast with Undo before sending.

### 5.5 Thread (answer)

```
┌───────────────────────────────────────┐
│ ‹ Heater repair dispute        ⓘ  ⋯   │
│                    ┌───────────────┐  │
│                    │ You (sealed)  │  │  user bubble shows chips
│                    │ Hi [Person 1]…│  │
│                    └───────────────┘  │
│ ┌ ☁︎ Gemini 3.8 Flash · 2.4 s ─────┐  │  RouteBadge
│ │ Here's a firm, polite reply you   │  │
│ │ can send to Raj: …                │  │  "Raj" underlined (restored)
│ │                                   │  │
│ │ [Copy reply] [Read aloud]         │  │
│ └ Receipt #42 · 14 sealed · ✓ ─────┘  │
│ ┌ What could Gemini still guess? ─┐   │  (F-25, collapsed)
│ └─────────────────────────────────┘   │
│ ┌───────────────────────────────────┐ │
│ │ Ask a follow-up…              ➤   │ │
└───────────────────────────────────────┘
```

- Restored tokens: subtle `seal` underline; tap → "Gemini wrote [[PERSON_1]]; your phone filled in 'Raj'."
- Copy copies restored text. "Copy sealed version" in the ⋯ menu.
- Follow-ups go through the same seal pipeline (fast path: reuse the thread's entity map; new entities get new ids).
- Tool consent card appears inline when Gemini requests a tool.
- Offline-fallback answers show badge "iPhone · offline answer" and a footer "Ask Gemini again when online".

### 5.6 Blocked states

| Cause | UI |
|-------|----|
| Egress gate | Back to Review, coral highlights, banner naming the type (never the value) |
| Model Armor | Sheet: shield icon. "Google's safety check stopped this request. Something identifying may have slipped past Airlock. Nothing was answered." Buttons: Review again / Learn more. Receipt saved with `armor: blocked` |
| Secret detected | Inline coral card at top of Review: "You pasted what looks like a one-time code or password. Airlock removed it. Never share these with anyone." |

### 5.7 Receipt detail

- Header: "Receipt #42 · Sat 21 Nov, 10:14"
- Route + model + latency (seal / network).
- "What left your phone" — the exact sealed text, monospaced placeholders, legend below.
- Counts by category with icons.
- Checks: G1–G7 listed with ticks and plain names ("No saved names", "No email/phone/ID patterns", …).
- Google checks: Model Armor status; button **Scan with Google** (F-45) → result inline.
- Chain: prev hash → this hash (truncated, tap to copy), "Verified ✓".

### 5.8 Ledger

- Hero: **182** "details stayed on your phone this week" (display style), sub: "23 requests · 9 answered fully on your iPhone · 0 blocked".
- Bar chart by day (Swift Charts): stacked sealed details by category.
- Card: "Your answers by route" donut-free — simple two-row bar: iPhone vs Gemini.
- List of receipts (`ReceiptRow`).
- Toolbar: **Verify chain** → `chain.verify` animation → "All 42 receipts verified. None were changed."
- Evidence card: "How well does Airlock work?" → Evidence screen.

### 5.9 Vault

- Sections: People, Places, Organisations, Other.
- Each entry: name (blurred until Face ID), role ("my sister"), aliases, "Always protect" toggle.
- Face ID gate (`LocalAuthentication`) to reveal names; works with the Simulator's enrolled Face ID.
- Empty state: "Add the people and places you never want to share. Airlock will catch them every time, even when Apple's model misses them."

### 5.10 Proof

```
┌───────────────────────────────────────┐
│ Proof                                 │
│ Got a message you're not sure about?  │
│ ┌───────────────────────────────────┐ │
│ │ Paste it here                     │ │
│ └───────────────────────────────────┘ │
│ [Check it]                            │
├───────────────────────────────────────┤
│ ┌ LIKELY A SCAM ───────────── 🛑 ──┐ │
│ │ Red flags (found on your phone)   │ │
│ │ [Urgency: "within 2 hours"]       │ │
│ │ [Asks for a code] [Odd link]      │ │
│ │ What the web says (Gemini+Search) │ │
│ │ Banks don't ask for one-time codes│ │
│ │ by text… Sources: 3 ›             │ │
│ │ Do: call the number on your card  │ │
│ │ Don't: reply, click, share codes  │ │
│ │ [Share warning with family]       │ │
│ └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

- Verdict words only: "Likely a scam", "Not sure — be careful", "Looks legitimate". No percentages.
- Offline: tactics-only card "We found 3 red flags on your phone. Connect to check against the web."
- Share warning: generates a sealed, friendly message ("Heads up: I got a fake bank text…") for family.
- Search grounding sources and suggestions displayed per Google's requirements.

### 5.11 Settings

- Privacy: dial, per-category switches, keep amounts, keep dates, red-team (off/suggest/auto), review (always/when needed).
- Answers: Auto / iPhone only / Best quality.
- Tools: Calendar access (Allow each time / Always / Never).
- Data: Back up sealed threads (sync), Back up sent text, Delete raw captures after N days, Delete everything.
- About: How Airlock works (diagram), How Airlock is tested (Evidence), Licences, Version.
- Developer (DEBUG only, hidden behind 5 taps on version): backend, model names, Remote Config values, last 20 `modelVersion`s, latency histograms, `debug_disable_gate` (red banner while on).

### 5.12 Evidence

- Tiles: **Leak rate**, **Names caught**, **Answer quality vs. unprotected**, **Answers fully on iPhone**, each with the number, a one-line definition and the dataset size.
- Ablation chart: Rules → +Apple model → +Red-team → +Review (simulated) — leak rate going down.
- "What we still miss" list with real examples from the benchmark (synthetic data).
- Footer: "Measured on {{n}} synthetic documents in {{languages}} on {{date}}. Method and code: github.com/…/eval."
- Data from `evidence_json` (Remote Config) with bundled fallback.

## 6. Empty, loading and error states

| Where | Empty | Loading | Error |
|-------|-------|---------|-------|
| Ask recent | "Your sealed conversations will appear here." | — | — |
| Review | — | progressive highlights | "Couldn't read part of this on your phone. Please check the highlighted section yourself." |
| Thread | — | skeleton lines + RouteBadge "Asking Gemini…" | "Gemini is busy. Trying again…" → "Answer on your iPhone instead?" |
| Ledger | "No receipts yet. A receipt is created every time something leaves your phone." | — | Chain mismatch: coral "Receipt #17 doesn't match. Something changed it." |
| Proof | — | "Checking on your phone…" → "Checking the web…" | Offline card |

## 7. Accessibility

- VoiceOver: chips read as "Protected person, Person 1, your landlord. Double-tap to peek." Generalised: "Generalised: a large hospital."
- Every colour-coded meaning also has an icon and text.
- Dynamic Type up to AX5; Review's side-by-side collapses to segmented at large sizes.
- Reduce Motion fallbacks (§2.4). Reduce Transparency respected (system materials handle it).
- Hit targets ≥ 44×44 pt. Chips have extra horizontal padding.
- `XCUIApplication().performAccessibilityAudit()` in UI tests for each main screen.
- Read aloud uses `AVSpeechSynthesizer` (on-device) — and it doubles as an accessibility feature.

## 8. Mac specifics

- Window min size 900×600; three-column split view.
- Review shows side-by-side always.
- Keyboard: ⌘N new, ⌘↩ Seal & send, ⌘⇧C copy sealed, ⌘R receipt.
- Drag and drop text, PDFs and images onto the compose area.

## 9. Copy rules

| Never say | Say instead |
|-----------|-------------|
| "100% private", "anonymous", "untraceable" | "The details that identify you stay on your phone." |
| "Gemini never sees your data" | "Gemini sees your situation, not your identity." |
| "Legal advice", "Your rights are…" | "Here's what this usually means, and questions to ask." |
| "Diagnosis", "You should take…" | "Here's what this term means. Ask your doctor about…" |
| "AI detected a scam" (certainty) | "This looks like a scam. Here's why." |
| Error codes | Plain sentences with one next step |

Voice: warm, brief, second person. Sentences under 20 words. Numbers as digits.

## 10. App icon and brand

- Name: **Airlock**. Tagline: *The best AI, without giving yourself away.*
- Icon: rounded-square, deep ink (`#0B111C`) background; two mint (`#2BD9A6`) arcs forming a closing door with a small gap of light between them. No text, no padlock cliché.
- Accent glyph used in the seal animation: the same two arcs.
- Launch screen: ink background with the icon glyph; no text.
