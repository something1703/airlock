# 13 — Fix plan (build brief for the coding agent)

This turns the problems in [`12-REVIEW.md`](12-REVIEW.md) into work packages. Problem IDs (`PR-`, `UX-`, `CN-`, `EV-`) refer to that document; read it first, it has the failing inputs.

Work the packages in order. Each one says what to change, where, and how to prove it.

---

## 0. Rules for this work

1. Read `AGENTS.md` fully. Its invariants and its "stop and ask" list apply to everything here.
2. **Plan mode first** for any package marked 🔒. Those touch `AirlockSeal`, `AirlockEngines`, the egress gate's behaviour or a prompt, and the owner must approve the plan before code is written (`AGENTS.md` §11, `CLAUDE.md`).
3. **Fixture first.** Every privacy change starts as a failing case in `spec/tools/make_fixtures.py` → `spec/fixtures/*.json`. The TypeScript, Swift and Kotlin engines must all pass it. Do not fix one engine and leave the others.
4. **TypeScript is the reference.** Change `web/src/engine/` first, then port to `Packages/AirlockKit` and `android/core`. `android/core/PORTING-NOTES.md` lists the JavaScript behaviours the ports must copy.
5. **No cloud evaluation calls.** The benchmark's live mode stays off. Ordinary app use on the dev project is fine.
6. A changed prompt gets a new version id (`detect.v2`, not an edited `detect.v1`), in all three prompt sets, and an entry in `docs/04-PROMPTS.md`.
7. Commit as the configured git user, module-prefixed messages, no co-author or tool-attribution lines. Run `./scripts/test.sh` and `./scripts/lint.sh` before every push.
8. Record every design decision you make in `docs/11-RISKS-AND-DECISIONS.md`.

The red-team scripts that produced the review's findings may be on this Mac at `.preview/redteam/` (`h.ts` is the harness). If they are missing, the inputs in `12-REVIEW.md` §3.1 are enough to rebuild them.

---

## FX-00 — Pin the failures as tests

**Fixes:** nothing yet; makes every later package checkable.

- Add `web/tests/redteam.test.ts`. One test per input in `12-REVIEW.md` §3.1 (PR-02 to PR-14) and UX-13, asserting the *safe* outcome: the identifier is absent from `outbound` (sealed text + legend), or the result carries a review reason, or the gate blocks.
- Mark each as `test.fails` with the problem ID in its name. A later package flips its tests to plain `test`. A `test.fails` that starts passing fails the run, so nothing is fixed by accident and forgotten.
- Put the same inputs into `spec/fixtures` as a new `redteam` group with a `status: "open" | "fixed"` field. Swift and Kotlin suites skip `open` cases and must pass `fixed` ones.

**Done when:** the suite is green with every review finding represented as an expected failure.

---

## FX-01 — Readable, complete answers on the web

**Fixes:** UX-03, UX-04, UX-05. Web only for rendering; truncation applies to all three apps.

**1. Render Markdown** (`web/src/ui/components.tsx`, `RestoredAnswer`).
- Hand-written renderer, no new dependency. Support: `#`–`###` headings, `**bold**`, `*italic*`, `-`/`*`/`1.` lists with one level of nesting, `---`, inline `` `code` ``, paragraphs.
- It receives `RestoredSegment[]`, not a string. Restored values, hidden secrets and unknown placeholders must still render as their own marked elements inside headings, list items and bold text.
- **Never** render links, images or raw HTML. A URL stays plain text. (A restored value inside a link would send the real detail wherever the cloud model pointed it — PR-13.)
- Must be stable while streaming: an unclosed `**` renders as plain text until it closes; no layout jumps per chunk.
- Check how iPhone and Android render the same answer and bring them to the same subset.

**2. Detect and handle cut-off answers.**
- Add `truncated: boolean` to `EngineResult` and to stream completion, set from the response's finish reason. Confirm the field name in the SDK source for each platform and record it in `docs/API-NOTES.md` (`AGENTS.md` §5). 🔒 for the Swift engine.
- Raise budgets: deep answers 1500 → 4096 (`web/src/engine/answer.ts:45`), guess card 700 → 2048 (`web/src/engine/infer.ts:40`). Check in the SDK whether the cloud model's reasoning tokens count against `maxOutputTokens`; if they do and a control exists, document it and set it.
- When `truncated` is true the answer card shows "This answer was cut short." with a **Continue** button. Continue sends a follow-up on the existing sealed history ("continue from where you stopped"), through the gate like any follow-up, and appends to the same card.

**3. Guess card** (`web/src/ui/screens/Thread.tsx`, `GuessCard`).
- Every failed state gets a **Try again** button.
- A truncated or unreadable reply is retried once automatically with the larger budget before showing the error.
- If the SDK supports a JSON response type on this route, use it; verify first.

**Tests:** renderer unit tests including a restored chip inside a bold list item and a half-streamed `**`; a truncated mock response shows Continue and the continuation is gated; guess card retry.

**Done when:** the review's heater message, sent live, shows formatted headings and bullets, ends on a full sentence or offers Continue, and the guess card returns a list.

---

## FX-02 — Cut the wait and fill it 🔒

**Fixes:** UX-01, UX-02, UX-09.

**1. Measure first.**
- Add `timings` to `SealResult`: `rulesMs`, `detectMs`, `detectCalls`, `generaliseMs`, `generaliseCalls`, `redTeamMs`, `redTeamCalls`.
- Show them in a small "Timing" disclosure on the receipt and log them with `privacy: .public` equivalents (numbers only, never content).
- Run the review's two messages on the live web app and write the numbers into `docs/API-NOTES.md` before changing anything else. The steps below are the expected wins; reorder them by what the numbers say.

**2. Show what the rules know at once** (`web/src/engine/pipeline.ts`, `prepare`).
- Vault and pattern detection are synchronous and take milliseconds. Emit `progress({ kind: "rulesReady", candidates })` before the first model call.
- The sealing screen highlights those spans immediately, in their category colours, with a line like "6 details found so far · the on-device model is still reading". Model findings animate in when they arrive.

**3. One model call instead of N+1.**
- Today each generalised detail costs its own `gen.v1` call, run one after another (`pipeline.ts:105`). Add `detect.v2`: each ORG / LOCATION / HEALTH item also returns `"general"`, a noun phrase of at most 6 words with no names ("a large hospital").
- Validate `general` with the same checks as a `gen.v1` rewrite, plus the shape check in FX-07. If it fails, use a fixed phrase for the category and subtype. Call `gen.v1` only as a last resort.
- Keep the output compact: short keys, no prose, and stop the model as soon as the JSON closes.

**4. Do not make on-device tasks wait for sealing.**
- For a `phoneFirst` task (`isQuick`, `web/src/engine/answer.ts:19`) with the on-device model available: answer straight away from the raw text in a phone-only session (INV-3 allows exactly this), and run the seal in the background so the thread has a sealed version ready.
- No "Check before sending" screen for this path. The thread header says "You wrote · stayed on this device", not "What Gemini saw".
- If the on-device answer fails, or a later follow-up needs the cloud, the normal seal → Review → gate flow runs then, covering every earlier turn in the thread. Nothing may reach the cloud on this path without passing Review once.
- Add tests that a quick task with a failing phone engine sends nothing until Review is confirmed.

**5. Session cost.** Each call creates a new on-device session (INV-4). Measure creation time. If it is significant, check whether the platform allows a pre-created session with the fixed system prompt that is cloned per call; a clone per call still satisfies INV-4. Record the finding either way.

**Targets:** first highlights in under 300 ms. Review shown as soon as detection ends, never waiting for the red-team. For the review's 85-word message on this Mac, time to Review at most half of the measured baseline. Record before and after.

---

## FX-03 — Names that slip past 🔒

**Fixes:** PR-03, the name parts of PR-09 and PR-10.

The current rule is "block in the gate if a known name part appears" with case-sensitive single words. The new rule is "seal it as the same person; only ask the user when the word is genuinely ambiguous".

**1. Name parts become mentions.**
- For every person, organisation and place — from the Vault or detected in this message or thread — derive its parts: each word of 2+ letters, minus titles (`Mr`, `Dr`, `Ms`, `Shri`, …) and initials.
- Any whole-word occurrence of a part, in any letter case, is a mention of that entity and is sealed with the same placeholder.
- Word boundaries for this search also include `_`, `.`, `-`, digits and lower→upper case changes, so `rajesh_kumar.pdf`, `RajeshKumar` and `#PriyaSharma` are caught. Possessives and simple plurals (`Kumar's`, `Kumars'`, `Sharmas`) count.
- A Vault match inside a slug or filename extends to the whole joined token: `…/team/priya-sharma` seals `priya-sharma`, not just `priya`.

**2. Ambiguous words go to review, not through.**
- If a part is also an everyday word (`Rose`, `Will`, `Hunter`, `May`) and the occurrence is lower-case, do not seal it automatically. Add it to `merge.ambiguous`, which already forces review, and show it on Review as "possibly Rose Hunter — protect?" with one tap to protect or leave.
- Capitalised mid-sentence, it is sealed like any other part.

**3. The gate enforces the same rule.**
- G1 and G2 use the same part list and the same folding. An ambiguous lower-case hit passes only if the user explicitly left it as written, recorded as an override.
- Initial + surname (`M. Chen`, `P. Sharma`) is treated as the full name when the surname matches and the initial fits.

**4. Variants in the Vault.**
- Fold hyphen, non-breaking hyphen, en dash and space as the same separator (`Anne Marie` = `Anne-Marie`).
- Fold `ö`→`oe`, `ü`→`ue`, `ä`→`ae`, `ß`→`ss` as well as bare stripping (`Mueller` = `Müller`).
- Common honorific suffixes joined to a name (`Rajeshji`, `Kumarsaab`, `Rajeshbhai`).
- For an organisation with a multi-word alias, the first distinctive word alone (`Mercy` for `Mercy General Hospital`) is an ambiguous hit: review, not auto-seal.
- Nicknames and cross-script spellings are not derivable. Onboarding and the Vault screen should say so and invite aliases: "Add other ways you write this name, including in other scripts."

**Tests:** all PR-03 inputs; follow-up turns using the thread's entity map; `Will will call` keeps the verb; restore still returns the exact original surface form for each mention.

---

## FX-04 — Names in Indian and other non-Latin scripts 🔒

**Fixes:** PR-04, native-digit part of PR-08.

- `web/src/engine/foldedSearch.ts:23` strips every combining mark. Strip only the marks that are accents on Latin, Greek and Cyrillic letters. Vowel signs, viramas and nuktas in Devanagari, Bengali, Tamil, Telugu, Gujarati, Gurmukhi, Kannada, Malayalam, and Arabic harakat that carry meaning, must be kept.
- At `foldedSearch.ts:89`, a mark that follows the last matched character belongs to that character; test the boundary after it.
- Convert every Unicode decimal digit to ASCII in the normaliser before pattern detection, so `९८७६५४३२१०` and `٠٥٠١٢٣٤٥٦٧` hit the phone rules. Restore must still return the digits as the user typed them.
- Arabic clitic prefixes (`و`, `ل`, `ب`) joined to a known name: treat as an ambiguous hit → review.

**Tests:** the four `ranges()` cases and the two seal cases from the review; `राम` must not match `रोम` or `रम`; mixed Hindi–English sentences.

---

## FX-05 — Trust the model's answer properly 🔒

**Fixes:** PR-05, PR-06, and the two root causes behind UX-06.

**1. Find the model's spans more forgivingly** (`web/src/engine/llmDetector.ts:84`, `occurrences`).
- Try in order: exact; case-insensitive; whitespace-folded (any run of spaces or line breaks equals one space); apostrophe- and diacritic-folded; with a leading title removed from the needle.
- Map type labels by containment (`FULL_NAME`, `Person Name` → person) before giving up.
- A HEALTH label on text that is a person-shaped name is treated as a person.

**2. Tell the user when the model's output could not be used.**
- If a PERSON / ORG / LOCATION item still cannot be located, or has an unusable type, add a review reason `modelUnclear` (`pipeline.ts`, `finalise`). Today `hallucinatedDropped` is counted and ignored.
- Review shows: "The on-device model mentioned something we couldn't find in your text. Please read it through."

**3. Dates.**
- `llmDetector.ts` gives every model date the subtype `dob`. Only the DOB type gets `dob`; DATE gets `date`.
- A model "date" that is not a calendar date — a duration or count such as `14 days`, `two weeks`, `3 months` — is dropped. It identifies nobody. This is what turned "within 14 days" into a rewritten sentence.

**4. The stricter finding wins.**
- In `web/src/engine/merger.ts` (`resolveOverlaps`), when a pattern hit and a model hit cover the same span in the same category, keep the stricter subtype: `dob` over `date`, `address` over `place`. Detector priority still decides between different categories.

**5. Amounts are not IDs.**
- A model item typed ID or NUMBER whose text is a money amount (`findMoney`, `web/src/engine/money.ts`) is dropped as a candidate. Balanced and Open keep amounts as written; Strict buckets them as it already does.

**Tests:** every PR-05 line; the DOB case; `$1,850` stays in Balanced and is bucketed in Strict; `14 days` is untouched.

---

## FX-06 — Proof must not send unreviewed text 🔒

**Fixes:** PR-02, UX-10.

- After the on-device scan and sealing (`web/src/engine/proof.ts:321`), stop and show the sealed claims: "This is what will be checked on the web." Buttons: **Check on the web** and **Keep it on this device**. Nothing goes to Gemini before the tap. Proof uses the Strict dial, and Strict means always review.
- The on-device verdict (red flags and next steps) is shown first and is complete on its own; the web check adds to it.
- Each claim on that screen can be removed or have a word protected, reusing the Review components.
- Seal claims with everything detected in the **whole message**, not only Vault and pattern hits (`proof.ts:333`): a name the model found in the message is sealed in every claim.
- When the web check fails for quota, say so once in the verdict header and keep the claim cards compact. Do not repeat the error in each card.
- Show what the on-device model contributed. If it found tactics beyond the rules, tag them "on-device model"; today every flag reads "rule".

**Tests:** the review's fake-police message with a detector that finds only one name: nothing reaches the claim-check engine until the confirm action; after confirming, neither the inspector's name, the station nor the UPI ID is in what was sent (this also needs the UPI rule from FX-09).

---

## FX-07 — Safer defaults and better rewrites 🔒

**Fixes:** PR-07, PR-11, PR-12, PR-13, rest of UX-06, UX-07.

**1. Rules-only mode is a real stop** (`web/src/ui/screens/Review.tsx:143,221` and the native Review screens).
- Send and Copy stay disabled until the user ticks "I've read this and it's safe to send."
- Capitalised words that are not sentence-initial and that no rule classified get a dotted "not checked" underline, so the user knows where to look. Tapping one opens "Protect this".

**2. Red-team rewrites are applied by default.**
- Each accepted finding is shown as "Changed: *works nights at Jewel-Osco* → *works nights at a local store* · Undo".
- Only findings that survive the filter below are applied.

**3. Filter red-team findings** (`web/src/engine/redTeam.ts`).
- Drop a finding when: its evidence is a single everyday word; its suggestion equals the current text; its evidence overlaps a span that is already a placeholder or already generalised; the inferred attribute is generic ("is a team member", "works for a company").
- After any finding is applied, discard findings whose evidence no longer exists in the draft.
- At most 3 are shown. The banner reads "Airlock made 2 changes to hide more. Review them below." — not "Someone could still guess N things about you".

**4. Rewrites must fit the sentence.**
- A rewrite or `general` phrase is rejected if it contains sentence punctuation, starts with a capital letter that the replaced span did not, is longer than 8 words, or contains a finite verb when the replaced span was a noun phrase. Simple heuristics are enough.
- On rejection use the fixed phrase for the category and subtype.
- A rewrite replaces exactly the detected span. If the model's rewrite describes a neighbouring thing (the review's "Southport" → "a local business on a main street"), the shape check plus fixed phrases prevent it: a place becomes "a nearby street", never a business.

**5. Role hints from a fixed vocabulary** (`web/src/engine/sealer.ts:149-161`).
- A role hint is used only if, after `rewriteRole`, it is "the user's" plus one term from a fixed list of relationships and roles: landlord, tenant, neighbour, doctor, nurse, manager, colleague, employer, client, friend, partner, spouse, parent, child, sibling, teacher, lawyer, bank, school, workplace, home, and similar. Put the list in the shared packs so all engines use the same one.
- Anything else gives the generic line for the category. No free text from the model or from a Vault entry reaches the legend.
- `get_entity_role` (`web/src/engine/tools.ts:652`) returns the legend text, never the raw hint.

**6. Say what kind of contact or ID each placeholder is.**
- Legend lines for contacts and IDs come from the pattern subtype, as fixed strings: "an email address", "a phone number", "a web link", "a card number", "a bank account number", "an ID number". This stops the cloud swapping an email for a phone number.

**7. Restore only what is clearly a placeholder** (`web/src/engine/restore.ts:18`).
- Stop restoring bare tokens such as `PERSON_1` without brackets. Bracketed forms only.

**8. Known limit to document, not solve:** a number that arrived inside a pasted scam message can be restored into advice ("call `[[CONTACT_3]]`"). Add it to "What Airlock does and doesn't do" and to `12-REVIEW.md` as an accepted risk.

**Tests:** PR-07 and PR-13 inputs; the offsite message produces no findings; the heater message's sealed text is grammatical.

---

## FX-08 — Review screen, Ledger and answer framing

**Fixes:** UX-08, UX-11, UX-12, UX-14. No plan approval needed unless a prompt changes (it does in item 3).

**1. Review layout** (web, then iPhone and Android).
- A bar fixed to the bottom of the screen holds the task, **Seal & send** and **Copy sealed version**. It is always visible.
- The details list is collapsed to one line ("12 details protected · Show") and opens in place.
- Counts read without overlap: "9 replaced · 3 made less specific · 1 sent as written".

**2. Ledger counts** (`web/src/engine/ledger.ts:56-63` and ports).
- Count sealed details once per distinct `outboundSha256`. A second request with the same sealed text (the guess card) adds a request, not details.
- In the receipt list, a receipt whose sealed text matches an earlier one is labelled "Asked again: what could Gemini guess". No change to the receipt schema or the hash chain.

**3. Answer framing.** 🔒 (prompt change)
- `cloud-system.v2`: keep the boundaries and add "Describe what is typical and what to ask. Do not state that a law was broken or name a legal doctrine as a conclusion about their case."
- Every cloud answer card ends with a quiet line: "Airlock helps you understand and prepare. This isn't legal, medical or financial advice." All three apps.

**4. Small fixes.**
- `Review.tsx:229`: "Gemini sees only the left-hand version" → "Gemini sees only the sealed version."
- Receipt: "Checks passed: G1 … G7" → "Final check passed (7 of 7)", with the codes behind a "Details" disclosure.
- A new thread shows "New conversation" until the on-device title arrives; if it never does, use the task name ("Help with a message"). Never "Hi someone the heater at a place".
- When the cloud addresses the user by their own placeholder ("Hello `[[PERSON_ME]]`"), restore it to the user's first name, not the word "you".
- iPhone: add bottom padding so the floating tab bar never covers buttons or the follow-up box.
- Onboarding: the primary button stays visible at 1280×680.

---

## FX-09 — Pattern coverage and the remaining gate gaps 🔒

**Fixes:** PR-08, PR-09, PR-14, UX-13.

**1. One general rule first: a sealed value must not reappear in another spelling.**
- For every value sealed as a contact, ID or secret, fold it to lower-case letters and digits only. Fold the outbound text the same way. If the folded value appears, the gate blocks with the usual hit, and the sealer should have caught it as another mention.
- This closes `4111.1111.1111.1111` next to `4111 1111 1111 1111`, en-dash SSNs, lower-case IBANs and line-broken card numbers without a rule per separator.

**2. New and fixed rules** (shared pattern packs; fixtures for each).
- Digit runs with any of space, `.`, `-`, `_`, `/` or a line break between groups are tested as card (Luhn), IBAN and phone after removing separators.
- UPI IDs (`name@bank` with a known handle list), URLs without a scheme (known TLD plus a path), upper-case schemes, URL userinfo (`user:pass@`), coordinates, IPv6, MAC.
- Email: Unicode local parts and domains; `(at)` / `(dot)` / ` at ` / ` dot ` forms; fix the ASCII-only look-behind in the email rule (`web/src/engine/packs/core.json`, line 10, and its source pack under `Packages/AirlockKit`) that seals half an address.
- India: PAN in any case and spacing, GSTIN, vehicle registration, Voter ID, 6-digit PIN codes as a **place** (never a secret), flat / plot / house-number address lines. Other: UK, Canadian and Dutch postcodes; German and French street formats.
- Dates of birth in words, with ordinal days, and with the keyword up to 12 tokens away; "born in 1989"; "37-year-old" as an age (generalise, do not keep).
- Handles after a platform word ("my insta is …", `u/…`, `name#1234`).
- Secrets: the whole JWT including its first segment; values after "password is", "pass is", "pw:", "seed phrase:"; 4–8 digit codes near "log in", "login", "verify", "code".

**3. Stop the gate trapping people** (UX-13).
- `My password is hunter2 which I set last week.`: after the secret is sealed the trigger must not fire again on the next word.
- A blocked send names the exact words and offers one tap to protect each. No loop of protecting one word at a time.
- Input over the size limit shows the limit and the current length and suggests sending in parts. No silent cut at 60,000 characters (`pipeline.ts:87`).

**4. Remaining gaps** (PR-14).
- Chunker (`web/src/engine/chunker.ts:29-46,70`): hard-split chunks overlap by at least 200 characters.
- Gate (`gate.ts:44`): mask only placeholders that exist in this draft's legend. Anything else shaped like a placeholder is ordinary text and is checked.
- Normaliser: strip all format and default-ignorable characters, not a fixed list. Extend the look-alike table (dotless `ı`, `ɑ`, Cherokee letters).
- Backup (`web/src/app/syncDto.ts`): run the gate's term and pattern checks on the model's reply before it is written to Firestore; skip the backup for that turn if they hit.

---

## FX-10 — Bring the native apps level

**Fixes:** `12-REVIEW.md` §3.4. The owner's standing decision is that no feature is cut.

Port every engine change above to Swift and Kotlin as part of its own package. This package is the missing **features**. The web is the reference for each.

| Gap | Platform | Reference on web | Note |
|-----|----------|------------------|------|
| "Protect this" | iPhone / Mac | `pipeline.protect`, `Review.tsx` `ProtectBar` | 🔒 touches `AirlockSeal` |
| Proof mode | iPhone / Mac, Android | `engine/proof.ts`, `ui/screens/Proof.tsx` | Build with the FX-06 confirm step from the start |
| Private tools + consent | iPhone / Mac, Android | `engine/tools.ts`, `Thread.tsx` `ConsentCard` | iPhone can use EventKit (read-only, with consent) instead of an imported file. Verify the function-calling API in each SDK first |
| Sealed-history backup | iPhone / Mac, Android | `ai/sync.ts`, `app/syncDto.ts`, `firebase/firestore.rules` | Same DTOs; the rules already exist. Do not deploy rules changes without approval |
| What could Gemini guess | Android | `engine/infer.ts`, `GuessCard` | |
| Scrub & copy | Android | `session.scrubAndCopy`, `restorePasted` | |

**Needs a person:** one real on-device run on each native platform (Apple Intelligence on the Mac for the Simulator; a Nano-capable Android phone or Firebase Test Lab), with screenshots that show a real route badge instead of "Demo". List it in `docs/HUMAN-TODO.md`.

---

## FX-11 — Honest numbers

**Fixes:** EV-01, EV-02, EV-03.

- **Evidence screen, all three apps:** when the only report is a mock run, show the method, the dataset description and "Results will appear here after the final evaluation run." The mock figures go behind a "See a sample report" disclosure, still under the MOCK RUN banner. A mock number is never the first thing on the screen.
- **Seal latency** is measurable now without the benchmark: FX-02's timings. Add the measured figures to the README's Evidence section with the machine and browser named.
- **`01-PRODUCT.md` §8:** remove or soften claims that have nothing behind them yet (user tests with quotes) until they exist.
- **The real benchmark run needs the owner's explicit go-ahead** and the separate Google Cloud account. Do not start it. After FX-03 to FX-09 land, re-run the mock pipeline end to end so the live run is one command.

---

## Checklist for every package

- [ ] Fixtures added or flipped from `open` to `fixed`; `redteam.test.ts` cases for this package pass as plain tests.
- [ ] TypeScript, Swift and Kotlin all pass; `./scripts/test.sh` and `./scripts/lint.sh` green.
- [ ] No invariant weakened; any invariant touched has a test proving it holds.
- [ ] Prompts versioned and documented; SDK facts in `docs/API-NOTES.md`; decisions in `docs/11-RISKS-AND-DECISIONS.md`.
- [ ] UI work: light, dark and large-text screenshots; labels for screen readers.
- [ ] `12-REVIEW.md`: mark the problem IDs fixed, with the commit.

## After everything

Repeat the live walkthrough from `12-REVIEW.md` §1 with the same two messages and the same Proof sample. Record the new timings and outputs in a short "Re-check" section at the end of that document.
