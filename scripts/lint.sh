#!/usr/bin/env bash
# Invariant checks (docs/09-TESTING.md §3) + formatting. Fails on the first class of violation found.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0
violation() { echo "✘ $1" >&2; shift; printf '    %s\n' "$@" >&2; fail=1; }

SWIFT_DIRS=(); for d in App Packages Bench; do [[ -d $d ]] && SWIFT_DIRS+=("$d"); done
src() { grep -rnE --include='*.swift' --exclude-dir=.build --exclude-dir=DerivedData "$1" "${SWIFT_DIRS[@]}" 2>/dev/null; }

# INV / ADR-08: only AirlockEngines imports FirebaseAILogic.
hits=$(src '^\s*import\s+FirebaseAILogic' | grep -vE 'Packages/AirlockKit/(Sources/AirlockEngines|Tests/AirlockEnginesTests)/' || true)
[[ -n "$hits" ]] && violation "FirebaseAILogic imported outside AirlockEngines" "$hits"

# AGENTS.md §3: no direct FoundationModels.
hits=$(src '^\s*(@preconcurrency\s+)?import\s+FoundationModels' | grep -v 'Packages/AirlockKit/Sources/AirlockEngines/' || true)
[[ -n "$hits" ]] && violation "FoundationModels imported outside AirlockEngines (all AI must go through Firebase AI Logic)" "$hits"

# FoundationModels may only be used for types inside AirlockEngines — never to run inference.
hits=$(grep -rnE --include='*.swift' --exclude-dir=.build 'LanguageModelSession\(' Packages/AirlockKit/Sources App Bench 2>/dev/null || true)
[[ -n "$hits" ]] && violation "Direct LanguageModelSession created — inference must go through Firebase AI Logic" "$hits"

# INV-8: no print( in app or package sources (tests allowed).
hits=$(grep -rnE --include='*.swift' '(^|[^A-Za-z_.])print\(' App Packages/AirlockKit/Sources Bench 2>/dev/null || true)
[[ -n "$hits" ]] && violation "print( found — use Logger with privacy: .private (INV-8)" "$hits"

# INV-2: only EgressGate.swift may use the SealedText SPI.
hits=$(src '@_spi\(EgressGate\)' | grep -v '/Tests/' | grep -vE 'Sources/AirlockCore/Sealed.swift|Sources/AirlockSeal/EgressGate.swift' || true)
[[ -n "$hits" ]] && violation "@_spi(EgressGate) used outside the egress gate (INV-2)" "$hits"

# No try! / force unwrap patterns that are easy to grep (outside tests).
hits=$(grep -rnE --include='*.swift' 'try!' App Packages/AirlockKit/Sources Bench 2>/dev/null || true)
[[ -n "$hits" ]] && violation "try! outside tests (AGENTS.md §7)" "$hits"

# AGENTS.md §5.4: model names only in AppConfig.swift (Swift), config files, docs and tests.
hits=$(grep -rnE --include='*.swift' --include='*.ts' --include='*.tsx' --include='*.kt' 'gemini-[0-9]' App Packages/AirlockKit/Sources Bench web/src android/app/src/main 2>/dev/null \
  | grep -vE 'AirlockCore/AppConfig.swift|web/src/core/appConfig.ts|AppConfig.kt' || true)
[[ -n "$hits" ]] && violation "Model name outside AppConfig defaults" "$hits"

# Analytics: no string literal params outside the allowlist (docs/05 §10).
hits=$(src 'Analytics\.logEvent\([^)]*"[^"]*"\s*:\s*"' || true)
[[ -n "$hits" ]] && violation "Analytics.logEvent with a string-valued parameter" "$hits"

# ---- Web (TypeScript) invariants ----
if [[ -d web/src ]]; then
  # INV-8: no console output in the engine or app sources (content could leak into logs).
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' 'console\.(log|info|debug|warn|error|trace)' web/src 2>/dev/null || true)
  [[ -n "$hits" ]] && violation "console.* in web/src — never log content (INV-8)" "$hits"

  # ADR-08: only web/src/ai/ may import the Firebase AI Logic SDK.
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' "from ['\"]firebase/(ai|app-check)['\"]|from ['\"]@firebase/ai" web/src 2>/dev/null | grep -v '^web/src/ai/' || true)
  [[ -n "$hits" ]] && violation "Firebase AI imported outside web/src/ai/" "$hits"

  # INV-2: the SealedText factory is used only by the gate.
  hits=$(grep -rln --include='*.ts' --include='*.tsx' '__createSealedText' web/src 2>/dev/null | grep -vE 'web/src/engine/(gate|sealedInternal)\.ts' || true)
  [[ -n "$hits" ]] && violation "SealedText factory used outside the egress gate (INV-2)" "$hits"

  # AGENTS.md §5.4: model names only in the config defaults.
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' 'gemini-[0-9]' web/src 2>/dev/null | grep -v 'web/src/core/appConfig.ts' || true)
  [[ -n "$hits" ]] && violation "Model name outside web AppConfig defaults" "$hits"
fi

# Secrets must never be tracked.
if git rev-parse --git-dir >/dev/null 2>&1; then
  hits=$(git ls-files | grep -E 'GoogleService-Info\.plist|google-services\.json|AppCheckDebugToken|debug-token|service-account|\.env$' || true)
  [[ -n "$hits" ]] && violation "Secret-bearing file tracked by git" "$hits"
  hits=$(git grep -nE 'AIza[0-9A-Za-z_-]{35}' -- ':!spec/fixtures' ':!spec/tools' ':!Packages/AirlockKit/Tests' 2>/dev/null || true)
  [[ -n "$hits" ]] && violation "Google API key literal in tracked files" "$hits"
fi

# Formatting (swift format ships with Swift 6 toolchains).
if swift format --version >/dev/null 2>&1; then
  out=$(swift format lint --recursive Packages/AirlockKit/Sources 2>&1 | grep -E 'warning|error' | head -20 || true)
  [[ -n "$out" ]] && echo "• swift format suggestions (not failing yet):" && echo "$out"
fi

if [[ $fail -ne 0 ]]; then echo "✘ lint failed" >&2; exit 1; fi
echo "✔ lint passed"
