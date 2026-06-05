# Contributing to Lea

Thanks for your interest! Lea is a small, hackable Electron app.

## Dev setup

```bash
git clone https://github.com/OWNER/lea.git
cd lea
npm install
npm start          # launch the tray app
npm run selftest   # fast, offline logic tests (no tokens spent)
npm run check      # syntax-check all source files
```

You'll also need the [`claude` CLI](https://docs.claude.com/en/docs/claude-code)
installed and logged in.

## Project layout

| File | Role |
|---|---|
| `src/main.js` | Electron entry: tray, window, IPC, keep-awake, live title |
| `src/runner.js` | Autonomous loop: run → classify → wait for reset → retry |
| `src/usage.js` | Polls `ccusage` for the active usage block |
| `src/store.js` | The to-do queue (`tasks.json`) |
| `src/sandbox.js` | Per-OS isolation backends (Seatbelt / Docker / none) — **pure, tested** |
| `src/classify.js` | Usage parsing + run-result/limit detection — **pure, tested** |
| `src/config.js` | Settings + cross-platform binary/PATH resolution |
| `src/renderer/` | The tray UI |

## Guidelines

- Keep `sandbox.js` and `classify.js` free of Electron/Node side effects so they
  stay unit-testable. Add a case to `scripts/selftest.js` for any logic change.
- Run `npm run selftest && npm run check` before opening a PR.
- Be cautious with anything that weakens the sandbox or runs Claude with broader
  permissions — call it out explicitly in the PR.

## Platform notes

- **macOS** isolation uses `sandbox-exec` (Seatbelt) — no install needed.
- **Windows/Linux** isolation uses Docker (opt-in). Without it, runs are
  unsandboxed and the UI warns accordingly.

By contributing you agree your contributions are licensed under the MIT License.
