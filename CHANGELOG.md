# Changelog

All notable changes to Lea are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [0.1.2] — 2026-07-20

### Added
- **Codex support — Lea now runs on Claude Code _or_ Codex (or both).** Pick the
  agent per task, or set a global default. A provider abstraction
  (`src/providers/`) makes the two interchangeable and leaves room for more.
- **First-run onboarding + Settings → Agents & sign-in.** Choose your default
  agent and sign in per agent via CLI login (`claude /login` / `codex login`) or
  an API key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`).
- **Per-task agent + model selectors**, and each task row shows which agent ran.
- **Real windowed app on Windows/Linux.** Instead of a tray-only applet, Lea now
  opens a proper resizable window with a taskbar entry (plus a tray icon).
  Closing hides to the tray so the queue keeps running; Quit exits.
- **NSIS installer** now creates Start Menu + Desktop shortcuts and lets you
  choose the install directory.
- **`docker/Dockerfile.codex`** for the optional Codex Docker backend.

### Changed
- Codex runs headlessly via `codex exec --json` and uses its **own** sandbox
  (`--sandbox workspace-write`), so it isn't wrapped in Seatbelt. Because there's
  no `ccusage` for Codex, rate limits fall back to a timed retry
  (`codexRetryMinutes`) instead of an exact reset.
- macOS keeps the native menu-bar experience.

### Fixed
- Horizontal scrollbar in the task list: long follow-up lines and the action
  column could overflow sideways — the list now clips horizontally and wraps.

## [0.1.1] — 2026-06-26
- Universal macOS installers (arm64 + x64); CI publishes installers to a draft
  GitHub Release on tag; reset-window precision cache + tray countdown in seconds.

## [0.1.0]
- Initial release: autonomous, reset-aware task queue for headless Claude Code,
  with usage tracking (ccusage), per-platform sandboxing, and change reports.

[0.1.2]: https://github.com/bobby33400/Lea/releases/tag/v0.1.2
[0.1.1]: https://github.com/bobby33400/Lea/releases/tag/v0.1.1
