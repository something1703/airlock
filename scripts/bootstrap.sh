#!/usr/bin/env bash
# One-time setup check for a fresh clone.
set -euo pipefail
cd "$(dirname "$0")/.."
ok() { echo "✔ $1"; }; warn() { echo "• $1"; }
command -v swift >/dev/null && ok "$(swift --version 2>&1 | head -1)" || { echo "✘ Swift not found" >&2; exit 1; }
if xcode-select -p 2>/dev/null | grep -q CommandLineTools; then
  warn "Xcode not selected — AirlockKit tests work, the app needs Xcode: sudo xcode-select -s /Applications/Xcode.app"
else ok "Xcode: $(xcodebuild -version 2>/dev/null | head -1)"; fi
command -v xcodegen >/dev/null && ok "XcodeGen $(xcodegen --version | awk '{print $2}')" || warn "XcodeGen missing: brew install xcodegen"
command -v node >/dev/null && ok "Node $(node --version)" || warn "Node missing (web app, functions)"
command -v firebase >/dev/null && ok "Firebase CLI $(firebase --version)" || warn "Firebase CLI missing: npm i -g firebase-tools"
[[ -f project.yml ]] && ./scripts/gen.sh || warn "No project.yml yet — skipping project generation"
ok "Bootstrap done. Next: ./scripts/test.sh"
