<div align="center">

# Lea

**Your autonomous Claude assistant that works while you sleep.**

Lea is a cross-platform **menu-bar / system-tray app** that tracks your Claude
usage and runs a **to-do queue automatically** — the moment your limit resets,
it picks up the next task and runs Claude headlessly. Queue work before bed,
wake up to it done.

[![build](https://github.com/OWNER/lea/actions/workflows/build.yml/badge.svg)](https://github.com/OWNER/lea/actions/workflows/build.yml)
![platforms](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-informational)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

```
        ┌──────────────┐   reads    ┌───────────────────────────┐
        │  ccusage     │◀───────────│ ~/.claude/projects/*.jsonl │
        └──────┬───────┘            └───────────────────────────┘
               │ active block: tokens, cost, reset time
        ┌──────▼───────┐   "limit hit → wait for reset, then retry"
        │   Lea Runner │────────────────────────────────────────┐
        └──────┬───────┘                                         │
               │ claude -p   (isolated by the sandbox backend)   │
        ┌──────▼───────┐                                  ┌──────▼──────┐
        │  Your task   │  edits confined to project dir   │  tray icon  │
        │ (a project)  │                                  │  ◷ 2:14 · 3 │
        └──────────────┘                                  └─────────────┘
```

## What it does

- **Tracks tokens & the reset clock** from Claude Code's local transcripts (via
  [`ccusage`](https://github.com/ryoppippi/ccusage)) — live token count, cost,
  burn rate, and a countdown to your next usage-window reset.
- **Queues to-dos for Claude** — each is an instruction + a project folder.
- **Runs them autonomously** with headless `claude -p`. If a run hits the usage
  limit, the task is requeued and retried automatically once the window resets —
  looping through your list overnight.
- **Isolates every run** so an unattended mistake can't wreck your machine.
- **Keeps your computer awake** (only while tasks are pending) so overnight runs
  actually happen.

## Requirements

- **macOS, Windows, or Linux**, Node 18+.
- The **[`claude` CLI](https://docs.claude.com/en/docs/claude-code)** installed and
  logged in to your Claude subscription. Verify with `claude --version` and
  `claude -p "hi"`.
- *(Windows/Linux only, optional)* **Docker** if you want sandboxed runs.

## Install & run (from source)

```bash
git clone https://github.com/OWNER/lea.git
cd lea
npm install
npm start
```

A small ring icon appears in your menu bar / tray. On macOS it shows a live
countdown like **`◷ 2:14 · 3`** (2h14m to reset, 3 queued); on Windows/Linux the
countdown is in the tooltip. Click it to add and manage tasks.

> **Prebuilt installers:** push a `v*` tag (or run the **build** workflow) and
> GitHub Actions produces a `.dmg`/`.zip` (macOS), `.exe` (Windows), and
> `.AppImage` (Linux). Or build locally with `npm run dist`.

## How the autonomous loop works

1. Queue tasks during the day; leave Lea running.
2. The runner takes the first queued task and runs it. If you still have
   capacity, it just runs.
3. If Claude reports the usage limit is hit, the task goes back to the front of
   the queue and the runner sleeps until the active block's reset time (plus a
   small buffer), then retries.
4. Successful tasks become **done**; repeated failures become **failed** (and can
   be requeued). Every run's full output is saved to a log.

## 🔒 Safety model (please read)

Autonomous, unattended Claude is powerful **and risky** — it edits files and runs
commands with nobody watching. Lea defaults to the safest option per platform.

| Platform | Default isolation | How it works |
|---|---|---|
| **macOS** | **Seatbelt sandbox** (built-in) | Each run is wrapped in `sandbox-exec`. File **writes** are confined to the task's project folder; `~/.ssh`, `~/.aws`, Keychains, etc. are hard-blocked. Reads, network, and commands stay allowed so Claude's tools work. Zero setup. |
| **Windows / Linux** | **None by default** (Docker opt-in) | No lightweight built-in sandbox exists. Lea runs Claude directly **and shows a warning**, unless you enable the Docker backend. |

Whichever platform you're on:

- `--permission-mode bypassPermissions` is used so headless runs never block on a
  prompt — which is exactly why isolation matters.
- **Start with low-stakes tasks** and review logs before trusting Lea with
  anything important. Use per-project git commits so changes are reversible.

### Docker sandbox (recommended on Windows/Linux)

This gives real isolation by running Claude in a container with **only the
project folder mounted writable**.

1. Install **Docker Desktop** (or Docker Engine) and make sure it's running.
2. Build the bundled image:
   ```bash
   docker build -t lea-claude:latest docker/
   ```
3. Get a subscription token for headless container auth:
   ```bash
   claude setup-token
   ```
4. In Lea → **⚙ Settings → Sandbox backend → Docker**, paste the token and
   confirm the image name (`lea-claude:latest`).

> Note: on a Windows host, make sure the drive containing your project is shared
> with Docker Desktop (Settings → Resources → File sharing).

## Configuration (⚙ Settings)

| Setting | Default | Meaning |
|---|---|---|
| Auto-run | on | Master switch for autonomous execution |
| Sandbox backend | auto | `auto` (Seatbelt on macOS, none elsewhere), `docker`, or `none` |
| Keep computer awake | on | Prevent sleep while tasks are pending |
| Quiet hours | off | Pause auto-run during a time window |
| Default model | opus | Model when a task doesn't specify one |
| Task timeout | 30 min | Kill a task that runs too long |
| Max retries | 2 | Retries for non-limit errors |
| Token budget / block | off | Pause after N tokens per usage window |

Settings, tasks, and logs live in the app's data folder
(**Settings → Open data folder**): `~/Library/Application Support/Lea` (macOS),
`%APPDATA%\Lea` (Windows), `~/.config/Lea` (Linux).

## Project layout

```
src/
  main.js        Electron entry: tray, window, IPC, keep-awake, live title
  preload.js     contextBridge API for the renderer
  config.js      settings + cross-platform claude/ccusage/PATH resolution
  usage.js       polls ccusage → active usage-block snapshot
  store.js       the to-do queue (tasks.json)
  runner.js      autonomous orchestrator (run → classify → wait/retry)
  sandbox.js     isolation backends + headless claude argv   (pure, tested)
  classify.js    ccusage parsing + run-result classification (pure, tested)
  icon.js        zero-dependency tray + app icon generator
  spawnutil.js   cross-platform buffered spawn (cross-spawn)
  renderer/      the tray UI (index.html, style.css, app.js)
docker/Dockerfile  image for the Docker sandbox backend
scripts/selftest.js  fast offline logic tests (no tokens spent)
```

Run the logic tests any time (no tokens spent):

```bash
npm run selftest && npm run check
```

## Notes & limitations

- Reset detection uses the rolling usage block reported by `ccusage`. Claude also
  enforces **weekly** limits; if one is hit, a run may fail in a way that isn't a
  normal short-window reset — check the task log.
- Lea uses **your own** Claude account and respects your own limits.
- Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Lea contributors. Not affiliated with Anthropic.
“Claude” is a trademark of Anthropic.
