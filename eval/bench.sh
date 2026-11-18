#!/usr/bin/env bash
# AirlockBench helpers — MOCK ONLY. Nothing here makes a network call.
#   eval/bench.sh smoke         30 test items × D_llm → score → report in a temp dir (CI-safe, a few seconds)
#   eval/bench.sh mock-sample   test split × all configs → eval/reports/mock-sample/ (committed, labelled MOCK RUN)
#   eval/bench.sh test          scorer unit tests (Python, standard library only)
# Live runs are separate and need the repo owner's permission: see docs/07-EVALUATION.md "How to run".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -d web/node_modules ]] || (cd web && npm install --silent)

case "${1:-smoke}" in
  smoke)
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    (cd web && npm run bench --silent -- run --smoke --run-id smoke --out "$TMP" >/dev/null)
    python3 -I eval/scorer/score.py report --run-dir "$TMP/smoke" >/dev/null
    python3 -I - "$TMP/smoke/evidence.json" <<'PY'
import json, sys
ev = json.load(open(sys.argv[1]))
assert ev["mock"] is True and ev["label"] == "MOCK RUN — not real model results", "smoke evidence must be labelled mock"
assert ev["n"] == 30, ev["n"]
print(f"✔ bench smoke: 30 docs, D_llm (mock) doc leak {100 * ev['leakRate']['value']:.1f}%, names caught {100 * ev['namesCaught']['value']:.1f}%")
PY
    ;;
  mock-sample)
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    (cd web && npm run bench --silent -- run --run-id mock-sample --split test --out "$TMP")
    python3 -I eval/scorer/score.py report --run-dir "$TMP/mock-sample" --out eval/reports/mock-sample
    ;;
  test)
    (cd eval/scorer && python3 -m unittest discover -s tests -q)
    ;;
  *)
    sed -n '2,6p' "$0"
    exit 2
    ;;
esac
