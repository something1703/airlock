#!/usr/bin/env bash
# Runs every test suite that can run on this machine (AGENTS.md §6).
#   ./scripts/test.sh                 mocked/unit tests
#   RUN_ON_DEVICE_TESTS=1 ./scripts/test.sh   also on-device model tests (Mac with Apple Intelligence)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶ Fixtures are up to date"
python3 -I spec/tools/make_fixtures.py >/dev/null
if ! git diff --quiet -- spec/fixtures 2>/dev/null; then
  echo "✘ spec/fixtures changed after regeneration — commit the regenerated files" >&2
  git --no-pager diff --stat -- spec/fixtures >&2 || true
fi

echo "▶ AirlockKit (swift test)"
SWIFT_FLAGS=()
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
# Prefer Xcode's toolchain (Swift 6.4 + macOS 27 SDK, needed for the iOS 27 error mapping) even if
# xcode-select still points at the Command Line Tools.
if [[ "$DEV_DIR" == *CommandLineTools* && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  DEV_DIR="$DEVELOPER_DIR"
fi
if [[ "$DEV_DIR" == *CommandLineTools* ]]; then
  # Command Line Tools ship Swift Testing outside the default search path.
  F="$DEV_DIR/Library/Developer/Frameworks"; L="$DEV_DIR/Library/Developer/usr/lib"
  SWIFT_FLAGS=(-Xswiftc -F -Xswiftc "$F" -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F" -Xlinker -rpath -Xlinker "$L")
fi
(cd Packages/AirlockKit && swift test ${SWIFT_FLAGS[@]+"${SWIFT_FLAGS[@]}"})

if [[ -f project.yml ]] && command -v xcodegen >/dev/null && xcodebuild -version >/dev/null 2>&1 && xcrun simctl list >/dev/null 2>&1; then
  xcodegen generate --spec project.yml --quiet
  DD="${TMPDIR:-/tmp}/airlock-derived-data"
  if grep -q "AirlockUITests" project.yml; then
    echo "▶ App (xcodebuild test, mock engines)"
    xcodebuild -project Airlock.xcodeproj -scheme "Airlock (Dev)" -destination 'platform=iOS Simulator,OS=latest,name=iPhone 18 Pro' -derivedDataPath "$DD" test -quiet
  else
    echo "▶ App (build iOS Simulator + macOS; no UI test target yet)"
    xcodebuild -project Airlock.xcodeproj -scheme "Airlock (Dev)" -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DD" build -quiet CODE_SIGNING_ALLOWED=NO
    xcodebuild -project Airlock.xcodeproj -scheme "Airlock (Dev)" -destination 'platform=macOS' -derivedDataPath "$DD" build -quiet CODE_SIGNING_ALLOWED=NO
  fi
else
  echo "• Skipping app tests (no Xcode project or Xcode not selected)"
fi

if [[ -f web/package.json ]]; then
  echo "▶ Web (typecheck + vitest)"
  [[ -d web/node_modules ]] || (cd web && npm install --silent)
  (cd web && npm run typecheck --silent && npm test --silent)
fi

if [[ -f android/gradlew ]]; then
  echo "▶ Android (gradle test)"
  (cd android && ./gradlew test -q)
fi

if [[ -f functions/package.json ]]; then
  echo "▶ Cloud Functions (npm test)"
  (cd functions && npm test --silent)
fi
echo "✔ All available test suites passed"
