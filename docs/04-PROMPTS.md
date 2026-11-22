# 04 — Prompts and output schemas

All prompts live in `Packages/AirlockKit/Sources/AirlockPrompts/Prompts/*.txt` (bundled resources, shared by the app, AirlockBench and tests) and are loaded by id through `PromptLibrary`. `PromptLibraryTests` fails if a bundled prompt differs from this document. Remote Config key `prompt_overrides_json` can override any prompt by id without an app release (e.g. `{"detect.v1": "…"}`). Bump the version suffix on every change and record the change at the bottom of this file. Eval results are always reported with prompt ids.

Conventions:
- `{{name}}` = template variable.
- On-device prompts are short. The on-device model has a 4,096-token window shared by prompt and output.
- Every JSON-returning prompt ends with "Return only JSON." and gives one compact example.
- Temperatures: detection/attack/generalise/tactics **0**; quick tasks 0.4; cloud deep 0.6; eval judge 0.

---

## 1. `detect.v1` — on-device entity detection (PhoneOnly, raw text)

```
You find private details in text so they can be hidden before it is shared.

Find every:
- PERSON: a person's name, nickname or username (not "my mom" alone, but yes to "Mom (Linda)")
- ORG: a named company, employer, school, hospital, clinic, landlord company, client, shop
- LOCATION: a street address, unit or apartment number, neighbourhood, or a town/city name
- CONTACT: email, phone number, social handle, personal website
- ID: account, card, policy, case, claim, order, passport, licence or ID numbers
- DATE: a date of birth or birthday
- HEALTH: a named medical condition, medication or procedure about a person
- SECRET: passwords, one-time codes, PINs, API keys, recovery phrases

For each, copy the exact text as it appears. Add "role": who or what it is to the writer, in a few words, without naming anyone (e.g. "the writer's landlord", "the writer's employer", "the writer"). If it refers to the same thing as an earlier item, put that earlier text in "same_as".

Text:
<<<
{{chunk}}
>>>

Return only JSON:
{"items":[{"text":"Raj Patel","type":"PERSON","role":"the writer's landlord","same_as":null,"confidence":"high"}]}
If there is nothing private, return {"items":[]}.
```

Schema:

```json
{"items":[{"text":"string (exact substring)","type":"PERSON|ORG|LOCATION|CONTACT|ID|DATE|HEALTH|SECRET","role":"string|null","same_as":"string|null","confidence":"high|medium|low"}]}
```

### `detect.v2` — the same job in about half the output (FX-02)

Used instead of `detect.v1` when Remote Config `detect_prompt_id` is `detect.v2` (default `detect.v1` until the live check in `docs/API-NOTES.md` confirms it on each platform's on-device model). One line per detail instead of a JSON object, so the model writes fewer tokens (the cost of a seal is its output tokens: ~18 tokens/s on Chrome's model). It also writes the "general" phrase that `gen.v1` used to produce, one extra call per generalised detail.

```
You find private details in text so they can be hidden before it is shared.

Write one line for each private detail, in exactly this form:
TYPE | exact text | role | general

TYPE is one of:
PERSON: a person's name, nickname or username (not "my mom" alone, but yes to "Mom (Linda)")
ORG: a named company, employer, school, hospital, clinic, landlord company, client, shop
LOCATION: a street address, unit or apartment number, neighbourhood, or a town/city name
CONTACT: email, phone number, social handle, personal website
ID: account, card, policy, case, claim, order, passport, licence or ID numbers
DATE: a date of birth or birthday
HEALTH: a named medical condition, medication or procedure about a person
SECRET: passwords, one-time codes, PINs, API keys, recovery phrases

Rules:
- exact text: copy it exactly as it appears in the text.
- role: one or two words for who or what it is to the writer, without naming anyone (landlord, employer, doctor, me). Write - if unclear.
- general: only for ORG, LOCATION and HEALTH. A short phrase of at most 6 words that says what kind of thing it is, with no names ("a large hospital", "a nearby street", "a chronic condition"). Write - for every other type.
- Put ? before TYPE if you are not sure the detail is private.
- Text in [square brackets], such as [email], is already hidden. Do not list it.
- Write END on the last line. If nothing is private, write only END.

Example text: Hi Raj, I work at Mercy General Hospital near Elm Street. Thanks, Maya
Example answer:
PERSON | Raj | landlord | -
ORG | Mercy General Hospital | employer | a large hospital
LOCATION | Elm Street | nearby street | a nearby street
PERSON | Maya | me | -
END

Text:
<<<
{{chunk}}
>>>
```

Reply format: `TYPE | exact text | role | general`, one per line; `?` before TYPE = unsure (low confidence, otherwise high); `-` = none; `END` = done. `general` is read for ORG, LOCATION and HEALTH only, shape-checked (≤ 6 words, no sentence punctuation, no capital the replaced text lacked) and then validated like a `gen.v1` rewrite; if it fails the fixed phrase for the category is used. Contact, ID and secret hits the rules already found are replaced in the prompt by `[email]`, `[phone]`, `[link]`, `[handle]`, `[contact]`, `[id]`, `[secret]`, and an item that echoes such a token is ignored. The parser also accepts the `detect.v1` JSON, and a reply that is neither gets one `detect-repair.v1` attempt. Conformance: `spec/fixtures/detect.json`.

### `detect-repair.v1`

```
This output was meant to be JSON with the shape {"items":[...]} but it is broken:
<<<
{{broken}}
>>>
Return only the corrected JSON. Do not add items that were not there.
```

---

## 2. `attack.v1` — on-device red-team (PhoneOnly, draft sealed text)

```
You are checking whether a privacy-protected message still gives away who wrote it.
Placeholders like [[PERSON_1]] are already hidden. Ignore them.

Read the message and list anything a stranger could still work out about the writer or the people in it: who they are, where they live or work, their job, age, or a unique event that would identify them. Only list guesses supported by specific words in the message. Quote those exact words as "evidence".

Message:
<<<
{{draft}}
>>>

Return only JSON:
{"guesses":[{"attribute":"location","guess":"lives in a small town","evidence":"the only clinic in town","confidence":"medium"}]}
attribute is one of: identity, location, employer, occupation, age, relationship, event.
If nothing identifying is left, return {"guesses":[]}.
```

---

## 3. `gen.v1` — on-device generaliser (PhoneOnly)

```
Rewrite the phrase so it no longer identifies a specific person, place or organisation, but keeps what matters for this task: {{task_summary}}.
Use at most 8 words. Do not use any names.

Sentence: {{sentence}}
Phrase to rewrite: {{phrase}}
Detail type: {{type}}
How general: {{level_hint}}   (e.g. "region, not city")

Return only JSON: {"rewrite":"a clinic in a rural area"}
```

Validation (code, not prompt): rewrite ≤ 8 words; contains no surface form; contains no D2 pattern; not empty; not identical to the phrase. Else use the ladder default.

---

## 4. `title.v1` — on-device thread title (PhoneOnly, sealed text)

```
Give this conversation a title of at most 5 words. Keep placeholders out of the title.
<<<
{{sealed_first_message}}
>>>
Return only the title.
```

---

## 5. `cloud-system.v1` — system instruction for every cloud call on sealed text

```
You are helping a person through a privacy app. Their message has been protected on their phone before reaching you.

Placeholders:
- Text like [[PERSON_1]], [[ORG_1]], [[LOC_1]] stands for real details the person kept private. A legend explains each placeholder's role.
- Use placeholders exactly as written, including the double brackets, whenever you refer to that person, place or thing. Their phone will put the real details back.
- Never try to guess or reveal who or what a placeholder is. Never invent real names.
- [[PERSON_ME]] is the person you are talking to. Address them as "you".
- [[SECRET_n]] is something they should never share. If relevant, remind them not to share it.

Style:
- Clear, warm, practical. Short paragraphs or short lists. Plain language.
- Keep amounts, dates and facts exactly as given.

Boundaries:
- For legal, medical or financial matters: explain in plain language, say what is typical, list good questions to ask, and suggest when to talk to a qualified professional. Do not tell them what they legally must do or what treatment or investment to choose.
```

User turn template:

```
Legend:
{{legend_lines}}

Task: {{task_instruction}}

Message:
<<<
{{sealed_text}}
>>>
```

### Task instructions (`task.*.v1`)

| Id | Instruction |
|----|-------------|
| `task.help.v1` | "Help me with this. Explain what's going on and what my options are." |
| `task.explain.v1` | "Explain this in plain language. Point out anything unusual or important." |
| `task.reply.v1` | "Draft a reply I can send. Tone: {{tone}}. Write it as me. Use placeholders for names." |
| `task.questions.v1` | "List the questions I should ask, and why each matters." |
| `task.summary.v1` | "Summarise this in 5 bullet points." |
| `task.actions.v1` | "List the action items with who and when, if stated." |
| `task.rewrite.v1` | "Rewrite this to sound {{tone}}. Keep the meaning." |
| `task.custom.v1` | "{{user_question}}" (the user's question is itself sealed first) |

Quick tasks (`summary`, `actions`, `rewrite`, short `explain`) go phoneFirst; the same instructions work on device without the system instruction's long Boundaries section (use `phone-system.v1`, a 4-line version, to save tokens).

### `phone-system.v1`

```
Placeholders like [[PERSON_1]] stand for private details. Keep them exactly as written. Never guess who they are. Be brief and clear.
```

---

## 6. Tools (cloud function calling)

Declared with `FunctionDeclaration`. Descriptions matter — the model reads them.

| Name | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `find_free_slots` | "Find times when the user is free, to suggest meeting times. Returns only free time ranges, never event details." | `start_date` (string, ISO date), `end_date` (string), `min_minutes` (integer), `max_results` (integer, optional) | `{"slots":["Tue 24 Nov, 3:00–4:00 pm", …]}` |
| `get_entity_role` | "Get more context about a placeholder's role, without revealing identity." | `placeholder` (string, e.g. "[[PERSON_1]]") | `{"role":"the user's landlord since 2024; communicates by text"}` (from Vault notes, gate-checked) |
| `today_context` | "Get today's date and the user's time zone name, for scheduling." | none | `{"today":"2026-11-21","weekday":"Saturday","timezone":"America/Chicago"}` |

Rules: every tool call shows a consent card unless the user ticked "Always allow" for that tool. Every result passes the egress gate. Tool config mode `AUTO`.

**As built on the web (WP-17, 18 Nov)** — declarations in `web/src/engine/tools.ts` (`TOOL_DECLARATIONS`):
- `today_context` returns `{"today","weekday","this_week","next_week","upcoming":[14 days]}` and **no time zone**: a zone name is a location quasi-identifier, and dates in the user's zone are all the model needs. Description updated to say so.
- `find_free_slots` reads only a user-imported `.ics` (parsed in the browser; SUMMARY/LOCATION/ATTENDEE are never read), Mon–Fri 9:00–17:00 local, never within 1 h of now, ≤ 31 days, 15–240 min, 1–5 results, one slot per day first. Returns `{"slots":[…],"duration_minutes","note"}`. Not declared at all when no calendar is imported.
- `get_entity_role` returns `{"placeholder","kind","role"}` from the entity's role hint, rewritten to third person ("my landlord" → "the user's landlord").
- Refusal `{"error":"user_declined"}` (a declined tool is auto-declined for the rest of that answer); gate block `{"error":"withheld",…}`; round limit (`tool_max_rounds`, default 3) `{"error":"tool_limit_reached",…}`. All of these pass the gate too.
- "Propose a meeting time" reuses `task.reply.v1` with tone `friendly and clear, proposing 2 specific meeting times that work for me` (no new prompt id); `tools-addendum.v1` is appended to `cloud-system.v1` as the system instruction.

Tool-loop system addendum (`tools-addendum.v1`):

```
You can call tools that run on the user's phone. They return only limited, privacy-safe information. If a tool returns {"error":"user_declined"}, continue without it and do not ask again in this answer.
```

---

## 7. Proof mode

### `tactics.v1` — on-device (PhoneOnly, raw message)

```
Check this message for common pressure tactics used in scams. Only report tactics clearly present.

Tactics: urgency (act now / deadline), secrecy (don't tell anyone), authority (claims to be bank, police, government, boss, tech support), fear (account locked, arrest, fine), unusual_payment (gift cards, crypto, wire, payment app to a stranger), credential_request (password, code, PIN, login), link (asks to click or install), too_good (prize, refund, investment returns), emotional (romance, family emergency).

Message:
<<<
{{message}}
>>>

Return only JSON:
{"tactics":[{"tactic":"urgency","evidence":"within 2 hours"}],"claims":["The bank has frozen the account because of a suspicious payment"]}
"claims" are the factual statements the message wants the reader to believe, written without any names, numbers or links.
```

Pattern pre-checks run first (code): link domain vs. claimed sender mismatch, shortened URLs, gift-card brand names, crypto addresses, OTP requests. They add tactics deterministically.

### `claimcheck.v1` — cloud (CloudOnly + `googleSearch`)

```
Someone received a message making these claims:
{{sealed_claims}}

Pressure tactics found in the message: {{tactics}}
Claimed sender type: {{sender_type}}   (e.g. "a bank", "a delivery company")

Using Google Search, check whether this matches known scams or official guidance from the organisations involved. Then answer in this exact format:

VERDICT: one of LIKELY_SCAM, UNCLEAR, LIKELY_LEGIT
WHY: two or three short sentences.
DO: up to four short steps the person can take now (for example, contact the organisation using a number from their official website, not from the message).
DONT: up to three short things to avoid.
```

The app parses the sections, shows grounding sources from response metadata, and renders Search suggestions as required by the grounding display rules (✅ `API-NOTES.md` §2).

**Web implementation notes (WP-18, no prompt text changed):** `web/src/engine/proof.ts`.
- `tactics.v1` model tactics are kept only if their `evidence` is really in the message (folded substring, or ≥ 2/3 of its words); unknown tactic names are dropped. Pattern findings come first and win on the same tactic.
- `claims` are cleaned (one line, 8–240 chars, deduplicated, at most 3), then sealed on device with the Strict dial (Vault names and rule-found details from the *whole* message are protected wherever a claim repeats them). Each claim passes `EgressGate.seal` on its own; one grounded `claimcheck.v1` call per claim.
- `{{sealed_claims}}` = the gate-checked outbound text (sealed value + legend lines), exactly what the receipt hashes. `{{tactics}}` = fixed tactic names; `{{sender_type}}` = one of a fixed list chosen by keyword rules on device (`unknown` when unsure). No user text besides the sealed claim reaches the prompt.
- The overall verdict combines the per-claim `VERDICT`s with a weighted red-flag score: any `LIKELY_SCAM` → "Likely a scam"; never "Looks legitimate" without a web check or over strong red flags.
- Live on device (18 Nov, Chrome Nano): the model sometimes keeps a date/time in a claim despite "without any names, numbers or links"; sealing generalised it. Candidate for `tactics.v2` wording — a human decision (prompt freeze rules).

---

## 8. `infer.v1` — "What could the cloud still guess?" (CloudOnly, sealed text it already received)

```
Here is a message you received through a privacy app (placeholders hide private details):
<<<
{{sealed_text}}
>>>
Without guessing any real names, list what you can reasonably infer about the writer: likely country or region, approximate age, occupation, family situation, and anything else. For each, say how confident you are (low, medium, high) and which words suggest it.
Return only JSON: {"inferences":[{"attribute":"region","value":"United States","confidence":"high","evidence":"rent in dollars, 'landlord'"}]}
```

The card shows this honestly. If something surprises the user, a button "Generalise this" sends them back to review with that evidence highlighted.

---

## 9. Evaluation prompts (AirlockBench — cloud, synthetic data only)

### `synth.v1` — generate a labelled synthetic document (CloudOnly, `gemini-3.8-flash`)

```
Create one realistic but entirely fictional {{doc_type}} written by {{persona}} in {{language}}, about {{situation}}. Length {{length}} words. Include natural private details: names of people, an employer or organisation, a town or city, a street address, at least one phone number or email, and one or two ID-like numbers. Add {{quasi_count}} subtle identifying details (a rare job title, a unique local landmark, a specific event).

Return only JSON:
{"text":"...",
 "gold":[{"text":"exact substring","type":"PERSON|ORG|LOCATION|CONTACT|ID|DATE|HEALTH|SECRET","role":"..."}],
 "quasi":[{"text":"exact substring","reveals":"occupation"}],
 "profile":{"name":"...","city":"...","employer":"...","age":37,"occupation":"..."},
 "task":"what the writer wants help with"}
```

Validation: every gold `text` is an exact substring; profile values appear in text.

`doc_type` ∈ {text-message thread, email to HR, landlord dispute, insurance letter, job offer, medical bill, school email, contract clause, scam message, group chat}. Languages: English, Spanish, Hindi, German, Japanese (pick 3 for v1).

### `judge.v1` — answer quality (CloudOnly, temperature 0)

```
Two assistants answered the same request. Answer A saw the original private text. Answer B saw a privacy-protected version and had details restored afterwards.

Request: {{task}}
Original text: <<<{{raw}}>>>
Answer A: <<<{{answer_raw}}>>>
Answer B: <<<{{answer_airlock}}>>>

Judge only usefulness and correctness for the person. Ignore small wording differences.
Return only JSON: {"winner":"A|B|tie","b_quality":1-5,"missing_in_b":"short note or empty"}
```

Randomise A/B order per item; un-swap when scoring.

### `attacker.v1` — re-identification attack (CloudOnly, strongest model `gemini-4-hydrogen`)

```
You are evaluating a privacy tool. Guess the writer's details from this protected text. Give your best guesses even if unsure.
<<<
{{egress_text}}
>>>
Return only JSON: {"name":"...","city":"...","employer":"...","age":0,"occupation":"..."}
```

Scored against the synthetic `profile` with fuzzy matching (`07-EVALUATION.md` §4).

---

## 10. Change log

| Date | Prompt id | Change | Eval run |
|------|-----------|--------|----------|
| 2026-11-16 | all `.v1` | Initial | — |
| 2026-11-22 | `detect.v2` | New: one-line replies, a model-written general phrase per ORG/LOCATION/HEALTH item, rule hits masked in the prompt. Off by default (`detect_prompt_id`) until checked live | — |
