# Airlock benchmark — run mock-sample (git 2b913af, prompts detect.v1/attack.v1/gen.v1)

> **⚠ MOCK RUN — not real model results.** The on-device model is `mock-oracle(recall=0.9)` (it reads the gold labels), answers, judge and attacker
> are scripted (`mock-scripted`, `mock-scripted`, `mock-string-match`). These numbers exercise the pipeline;
> they say nothing about Apple's, Chrome's or Gemini's models. Leak and recall in the rules-only row (`B_rules`) involve no model
> and do measure the TypeScript rules and egress gate; latency here is the pipeline with an instant mock model.

Test split: 120 synthetic documents · German, English, Spanish · Apple M5, darwin 27.2.0, Node v26.10.0
Engine: TypeScript privacy engine (web/src/engine), byte-compatible with Swift/Kotlin via spec/fixtures

| Config | Doc leak rate | Names caught | Re-ID ≥2 attrs | Quality win+tie | Seal p50/100w |
|--------|---------------|--------------|----------------|-----------------|---------------|
| Unprotected (`A_raw`) | 100% (by definition) | — | 100.0% | — | — |
| Rules (`B_rules`) | 97.5% (92.9–99.1) | 0.0% | 100.0% | 97.5% | 0.1 ms |
| +On-device model (`D_llm`) | 41.7% (33.2–50.6) | 93.8% | 25.5% | 81.7% | 1.0 ms |
| +Red-team (`E_redteam`) | 41.7% (33.2–50.6) | 93.8% | 25.5% | 81.7% | 1.0 ms |
| +Your Vault (`F_vault`) | 14.2% (9.0–21.5) | 94.8% | 0.0% | 47.5% | 1.0 ms |
| Redact (`G_naive_redact`) | 41.7% (33.2–50.6) | 93.8% | 25.5% | 2.5% | 0.9 ms |

What we still miss (3 examples): Person ‘Marcus’ (a parent in the writer's group chat) in an English group chat; Person ‘Miriam Kühnhold’ (the writer) in a German job offer; Person ‘Álvaro’ (a parent in the writer's group chat) in a Spanish group chat.
SDP findings on egress: not measured (Sensitive Data Protection runs only in the live scorer job).
Model Armor blocks during run: not measured.
Skipped `C_rules_nl`: D3 (Apple NaturalLanguage tagger) exists only in the Swift engine; the TypeScript engine has no NL tagger.

## Detail

### Leak, gate and review

| Config | Doc leak (all docs) | Doc leak (sent docs) | Gate blocked | Review required | Over-redaction | Quasi coverage |
|---|---|---|---|---|---|---|
| `B_rules` | 97.5% (92.9–99.1) | 100.0% (96.8–100.0) | 2.5% | 100.0% | 0.0% | 0.0% |
| `D_llm` | 41.7% (33.2–50.6) | 51.0% (41.3–60.7) | 18.3% | 26.7% | 0.0% | 0.0% |
| `E_redteam` | 41.7% (33.2–50.6) | 51.0% (41.3–60.7) | 18.3% | 100.0% | 0.0% | 89.8% |
| `F_vault` | 14.2% (9.0–21.5) | 29.8% (19.5–42.7) | 52.5% | 100.0% | 0.0% | 92.8% |
| `G_naive_redact` | 41.7% (33.2–50.6) | 51.0% (41.3–60.7) | 18.3% | 26.7% | 0.0% | 0.0% |

### Span recall by category (sent docs)

| Config | PERSON | ORG | LOCATION | CONTACT | ID | DATE | HEALTH | SECRET | Direct IDs |
|---|---|---|---|---|---|---|---|---|---|
| `B_rules` | 0.0% | 0.0% | 15.8% | 100.0% | 43.5% | 29.4% | 0.0% | — | 18.3% (16.1–20.8) |
| `D_llm` | 93.8% | 89.8% | 92.9% | 100.0% | 93.8% | 96.6% | 0.0% | — | 93.4% (91.6–94.9) |
| `E_redteam` | 93.8% | 89.8% | 92.9% | 100.0% | 93.8% | 96.6% | 83.3% | — | 93.4% (91.6–94.9) |
| `F_vault` | 94.8% | 96.5% | 96.5% | — | 90.0% | — | — | — | 95.5% (93.1–97.0) |
| `G_naive_redact` | 93.8% | 89.8% | 92.9% | 100.0% | 93.8% | 96.6% | 0.0% | — | 93.4% (91.6–94.9) |

DATE counts dates of birth only. Balanced keeps HEALTH and non-birth dates by design (docs/03 §2.1).

### Re-identification (attacker)

| Config | name | city | employer | occupation | age | ≥2 attrs |
|---|---|---|---|---|---|---|
| `A_raw` | 100.0% | 100.0% | 100.0% | 100.0% | 30.0% | 100.0% (96.9–100.0) |
| `B_rules` | 100.0% | 100.0% | 100.0% | 100.0% | 20.5% | 100.0% (96.8–100.0) |
| `D_llm` | 6.1% | 8.2% | 12.2% | 100.0% | 1.0% | 25.5% (17.9–35.0) |
| `E_redteam` | 6.1% | 8.2% | 12.2% | 100.0% | 1.0% | 25.5% (17.9–35.0) |
| `F_vault` | 0.0% | 0.0% | 0.0% | 100.0% | 0.0% | 0.0% (0.0–6.3) |
| `G_naive_redact` | 6.1% | 8.2% | 12.2% | 100.0% | 1.0% | 25.5% (17.9–35.0) |

### Answers

| Config | Quality win+tie | Mean quality (1–5) | Restore fidelity | Model name leaks | On-device share (quick tasks) | Routes |
|---|---|---|---|---|---|---|
| `B_rules` | 97.5% (92.9–99.1) | 5.00 (5.00–5.00) | 100.0% | 0 | 100.0% | blocked 3, cloudFirst 57, phoneFirst 60 |
| `D_llm` | 81.7% (73.8–87.6) | 5.00 (5.00–5.00) | 100.0% | 0 | 100.0% | blocked 22, cloudFirst 52, phoneFirst 46 |
| `E_redteam` | 81.7% (73.8–87.6) | 5.00 (5.00–5.00) | 100.0% | 0 | 100.0% | blocked 22, cloudFirst 52, phoneFirst 46 |
| `F_vault` | 47.5% (38.8–56.4) | 5.00 (5.00–5.00) | 100.0% | 0 | 100.0% | blocked 63, cloudFirst 18, phoneFirst 39 |
| `G_naive_redact` | 2.5% (0.9–7.1) | 1.22 (1.00–1.50) | 100.0% | 0 | 100.0% | blocked 22, cloudFirst 52, phoneFirst 46 |

### Seal latency (ms per 100 words)

| Config | p50 | p95 |
|---|---|---|
| `B_rules` | 0.14 | 0.30 |
| `D_llm` | 1.01 | 1.60 |
| `E_redteam` | 0.97 | 1.57 |
| `F_vault` | 1.05 | 1.31 |
| `G_naive_redact` | 0.85 | 1.24 |

### Doc leak rate by language

| Config | language=de | language=en | language=es |
|---|---|---|---|
| `B_rules` | 100.0% (91.2–100.0) | 92.5% (80.1–97.4) | 100.0% (91.2–100.0) |
| `D_llm` | 47.5% (32.9–62.5) | 37.5% (24.2–53.0) | 40.0% (26.3–55.4) |
| `E_redteam` | 47.5% (32.9–62.5) | 37.5% (24.2–53.0) | 40.0% (26.3–55.4) |
| `F_vault` | 17.5% (8.7–31.9) | 7.5% (2.6–19.9) | 17.5% (8.7–31.9) |
| `G_naive_redact` | 47.5% (32.9–62.5) | 37.5% (24.2–53.0) | 40.0% (26.3–55.4) |

### Run

- Mode: **mock** · engines: phone `mock-oracle(recall=0.9)`, answer `mock-scripted`, rawBaseline `mock-scripted`, attacker `mock-string-match`, judge `mock-scripted`
- Prompts: `detect.v1` a10a243c9e65, `detect-repair.v1` 4025a84f57e8, `gen.v1` 113f775613e6, `attack.v1` 437add328095, `cloud-system.v1` 9ad8911e2d6d, `cloud-user.v1` ed1da10867ab, `phone-system.v1` a81257b9ef6a, `task.help.v1` 934f914c51be, `task.explain.v1` 77ebad36506a, `task.questions.v1` f15022c21064, `task.summary.v1` c57ed2b76e42, `task.reply.v1` d79669246dd5, `task.actions.v1` 048a8b755c04, `judge.v1` 6ea3f49f9327, `attacker.v1` 9236d1993da7, `synth.v1` a67b9f8d6b42
- Models (Remote Config): deep `gemini-3.8-flash`, quick `gemini-3.5-flash-lite`, max `gemini-4-hydrogen`, fallback `gemini-3.5-flash-lite`
- Created 2026-11-18T08:22:52.763Z · finished 2026-11-18T08:22:54.623Z · records 720
- Intervals: Wilson 95% for rates, bootstrap (1,000 resamples) for means. Method: docs/07-EVALUATION.md.
