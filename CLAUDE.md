# CLAUDE.md

@AGENTS.md

Claude Code specifics:

- Load Firebase skills: `claude plugin marketplace add firebase/agent-skills` then `claude plugin install firebase@firebase`.
- Prefer XcodeBuildMCP (if installed) for building, launching the iOS Simulator and taking screenshots.
- Use plan mode for any work package touching `AirlockSeal`, `AirlockEngines` or `firebase/firestore.rules`.
- When verifying a Firebase AI Logic API, search the SDK checkout under DerivedData `SourcePackages/checkouts/firebase-ios-sdk/FirebaseAI/` and write findings to `docs/API-NOTES.md`.
