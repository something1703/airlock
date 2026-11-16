#!/usr/bin/env bash
# Regenerates Airlock.xcodeproj from project.yml (never hand-edit the project; ADR-07).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v xcodegen >/dev/null || { echo "Install XcodeGen: brew install xcodegen" >&2; exit 1; }
[[ -f project.yml ]] || { echo "project.yml not created yet (WP-00, needs Xcode)" >&2; exit 1; }
xcodegen generate --spec project.yml
