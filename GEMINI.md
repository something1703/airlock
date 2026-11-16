# GEMINI.md (Antigravity / Gemini CLI)

Follow [`AGENTS.md`](AGENTS.md). It is the single source of truth for rules, invariants, commands and workflow.

Antigravity specifics:

- Install Firebase skills at project level: `npx skills add firebase/agent-skills --agent=antigravity`.
- Antigravity cannot run the iOS Simulator itself; build and test through `./scripts/test.sh` and leave Simulator verification to a human or a Claude Code / Xcode session.
