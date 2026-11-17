# Porting notes — `android/core` (Kotlin) ⇄ `web/src/engine` (TypeScript)

`app.airlock.core` is a 1:1 port of `web/src/engine/*.ts` (itself a port of `Packages/AirlockKit`). Behaviour must
match byte-for-byte on spans, placeholders, sealed text, legend lines and hashes; the shared fixtures in
`spec/fixtures/*.json` are the contract, and the JUnit suites load them directly.

## File map

| TypeScript | Kotlin |
|---|---|
| `types.ts` | `Types.kt` |
| `foldedSearch.ts`, `normaliser.ts`, `validators.ts`, `patterns.ts`, `vault.ts` | same names, `.kt` |
| `merger.ts`, `chunker.ts`, `prompts.ts`, `engines.ts`, `mocks.ts` | `Merger.kt`, `Chunker.kt` (+ `SentenceBreaks.kt`), `Prompts.kt`, `Engines.kt`, `Mocks.kt` |
| `llmDetector.ts`, `restore.ts`, `terms.ts`, `homoglyphs.ts`, `money.ts`, `generaliser.ts`, `policy.ts`, `sealer.ts` | `LlmDetector.kt`, `Restore.kt`, … |
| `gate.ts` + `sealedInternal.ts` + `sha256.ts` | `Gate.kt` (the only file that creates `GateToken`/`SealedText`; `sha256Hex` uses `MessageDigest`) |
| `redTeam.ts`, `pipeline.ts`, `hashchain.ts`, `ledger.ts`, `answer.ts` | `RedTeam.kt`, `Pipeline.kt`, `HashChain.kt`, `Ledger.kt`, `Answer.kt` |

Promises become `suspend` functions, `AsyncIterable`s become `Flow`s, and `runStaged` takes a `CoroutineScope`
and returns `later` as a `Deferred<SealResult>?`. `today` is an `Instant`. Receipts flatten `gate` into
`gatePassed`/`gateChecks`; `HashChain.hashedFields` rebuilds the same nested JSON, so hashes are unchanged.
`CHROME_ON_DEVICE_MODEL` becomes `ON_DEVICE_MODEL = "gemini-nano-on-device"`. Pattern packs and prompts are classpath
resources copied from the Swift package at build time; `airlock/prompts/index.txt` is generated from the same files.

## JavaScript semantics on the JVM (`JsText.kt`)

Kotlin/Java defaults differ from JavaScript in ways that change results, so the port never relies on them:

- **Whitespace**: JS `\s`/`trim`/`split(/\s+/)` use the ECMAScript set (includes U+FEFF, excludes U+0085). Kotlin's
  `trim()` and Java's `\s` do not match it, so `Js.isWhitespace`, `Js.trim` and `Js.splitWhitespace` are used everywhere.
- **Regexes** (`Js.pattern`): pack regexes are translated, not passed through. Java's `\b` treats a combining mark that
  follows a letter as a word character (JS does not), and Java's `UNICODE_CASE` lets Turkish `İ`/`ı` match `i`/`I`
  (JS `iu` simple case folding does not, but it does fold `ſ`→`s` and Kelvin `K`→`k`). The translator emits explicit
  ASCII `\b`/`\w`/`\d`, the JS whitespace class, and explicit case-variant classes. Case-insensitive sources may contain
  only ASCII cased letters; anything else is rejected when the pattern is compiled.
- **`JSON.parse`**: `JsJson` is a strict parser with the same grammar; kotlinx-serialization is more lenient.
- **`Math.log2`**: `JsMath.log2` is a port of FreeBSD `e_log2.c`, which is V8's implementation. It is bit-identical to
  node on 280,211 values; `kotlin.math.log2` differed on 85,950 of them, which would move the `entropy >= 3.5`
  secret threshold.
- **UTF-8 for hashing**: lone surrogates encode as U+FFFD (like `TextEncoder`), not `?` (like `String.toByteArray`).
- **Sentences**: `java.text.BreakIterator` does not follow UAX #29 (for example, it doesn't break after a line feed).
  On random text it disagreed with `Intl.Segmenter` on 45% of inputs. `SentenceBreaks.kt` implements the UAX #29
  rules directly and matches `Intl.Segmenter` on 3,000/3,000 random documents.

## Verification

Beyond the ported suites, a throwaway differential harness ran the TS engine on randomized inputs and compared every
output with Kotlin. It covered:

- 3,000 each of: patterns, normalise, money, mixed scripts, folded search and chunking
- 5,000 validator inputs and 108 date cases
- 14,238 entity-term cases
- 2,500 full seals: merge, sealer, legend, gate verdict, entities, mentions and replacements
- 2,500 restores

The harness was not committed. The final run found 0 mismatches.

## Known, accepted differences

- **Unicode version**: JDK 21 implements Unicode 15.0, while node/ICU are newer. `\p{…}` categories, NFKC/NFKD,
  case mapping and grapheme clusters can differ for characters assigned after 15.0.
- **Sentence_Break properties** are derived from `Character` properties, and the Sentence_Terminal list covers the BMP.
  Rare scripts' terminators outside that list are treated as ordinary characters, so the only effect is where chunks start and end.
- **Money above ~1e21** (or other doubles whose shortest decimal form has a tie) may format differently, because Java's
  shortest-repr algorithm is used for `String(n)` / `toLocaleString`.
- **Timing fields** (`sealMs`, `latencyMs`) use `System.nanoTime`.

## Observations about the TypeScript source (not changed here)

- `redTeam.ts` `locate`: the case-insensitive pass uses `hay === text` to choose the needle. If the draft is already all
  lower-case, the second pass reuses the original-case needle, so "Near the old mill" is not found in "near the old
  mill". Ported as is.
- `homoglyphs.ts` `mixedScriptWords`: `wordStart` is only set when no Latin/Cyrillic/Greek letter has been seen yet.
  A word that starts with letters from another script gets a span that begins at its first Latin/Cyrillic/Greek letter.
  This only affects highlighting; the G6 verdict is the same. Ported as is.
- `generaliser.ts` `validDate`: `Date.UTC` maps years 0–99 to 1900–1999, so a four-digit year below 100 never parses.
  Ported as "invalid".
