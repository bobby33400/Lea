<div align="center">

# Lea

**Your autonomous coding agent that works while you sleep.**

Lea is a cross-platform app that runs a **to-do queue automatically** using the
coding agent of your choice — **Claude Code, Codex, or both**. For Claude it
tracks your usage and, the moment your limit resets, picks up the next task and
runs it headlessly. Queue work before bed, wake up to it done.

On **macOS** it lives in the menu bar; on **Windows/Linux** it's a real windowed
application (with a tray icon too).

[![build](https://github.com/bobby33400/Lea/actions/workflows/build.yml/badge.svg)](https://github.com/bobby33400/Lea/actions/workflows/build.yml)
![platforms](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-informational)
![license](https://img.shields.io/badge/license-MIT-green)

### ⬇️ [Download for macOS · Windows · Linux](https://github.com/bobby33400/Lea/releases/latest)

</div>

<!-- TODO: a screenshot or GIF of the tray menu goes a long way on Show HN / Product Hunt.
     Save one as docs/screenshot.png and uncomment the next line:
<p align="center"><img src="docs/screenshot.png" alt="Lea tray menu" width="520"></p> -->

```
        ┌──────────────┐   reads    ┌───────────────────────────┐
        │  ccusage     │◀───────────│ ~/.claude/projects/*.jsonl │
        └──────┬───────┘            └───────────────────────────┘
               │ active block: tokens, cost, reset time
        ┌──────▼───────┐   "limit hit → wait for reset, then retry"
        │   Lea Runner │────────────────────────────────────────┐
        └──────┬───────┘                                         │
               │ claude -p / codex exec  (isolated per backend)  │
        ┌──────▼───────┐                                  ┌──────▼──────┐
        │  Your task   │  edits confined to project dir   │  tray icon  │
        │ (a project)  │                                  │  ◷ 2:14 · 3 │
        └──────────────┘                                  └─────────────┘
```

## Download

**[→ Grab the latest installer from Releases](https://github.com/bobby33400/Lea/releases/latest)** — `.dmg`/`.zip` (macOS), `.exe` (Windows), `.AppImage` (Linux).

> The installers are **not code-signed yet**, so your OS warns you the first time:
> - **macOS:** right-click the app → **Open** → **Open** (or System Settings → Privacy & Security → *Open Anyway*).
> - **Windows:** SmartScreen → **More info** → **Run anyway**.
>
> Prefer to build it yourself? See [Install & run (from source)](#install--run-from-source).

## What it does

- **Tracks tokens & the reset clock** from Claude Code's local transcripts (via
  [`ccusage`](https://github.com/ryoppippi/ccusage)) — live token count, cost,
  burn rate, and a countdown to your next usage-window reset.
- **Queues to-dos for your agent** — each is an instruction + a project folder,
  and can target **Claude Code** or **Codex** (per task, or a global default).
- **Runs them autonomously** with headless `claude -p` or `codex exec`. If a run
  hits the usage/rate limit, the task is requeued and retried automatically —
  Claude waits for the exact window reset; Codex waits a short backoff.
- **Isolates every run** so an unattended mistake can't wreck your machine
  (Seatbelt for Claude on macOS; Codex uses its own sandbox; Docker on any OS).
- **Keeps your computer awake** (only while tasks are pending) so overnight runs
  actually happen.

## Agents (Claude Code / Codex)

On first launch Lea asks which agent(s) to use and how to sign in — you can
change this any time in **⚙ Settings → Agents & sign-in**.

| Agent | Sign in with | Notes |
|---|---|---|
| **Claude Code** | `claude` + `/login`, or an `ANTHROPIC_API_KEY` | Precise reset-clock tracking via [`ccusage`](https://github.com/ryoppippi/ccusage). |
| **Codex** | `codex login` (ChatGPT), or an `OPENAI_API_KEY` | No ccusage equivalent, so after a rate limit Lea retries on a timed backoff rather than an exact reset. Codex brings its own sandbox. |

Each task shows which agent it ran on, and you can pick a different agent (and
model) per task in the **＋ Task** form.

## Requirements

- **macOS, Windows, or Linux**, Node 18+.
- At least one agent CLI installed and signed in:
  - **[`claude` CLI](https://docs.claude.com/en/docs/claude-code)** — verify with
    `claude --version` and `claude -p "hi"`; and/or
  - **[`codex` CLI](https://github.com/openai/codex)** — verify with
    `codex --version` and `codex login`.
- *(Windows/Linux only, optional)* **Docker** if you want sandboxed runs.

## Install & run (from source)

```bash
git clone https://github.com/bobby33400/Lea.git
cd Lea
npm install
npm start
```

A small ring icon appears in your menu bar / tray. On macOS it shows a live
countdown like **`◷ 2:14 · 3`** (2h14m to reset, 3 queued); on Windows/Linux the
countdown is in the tooltip. Click it to add and manage tasks.

> **Prebuilt installers** are published to [Releases](https://github.com/bobby33400/Lea/releases)
> on every `v*` tag (built by GitHub Actions for all three platforms). Or build
> locally with `npm run dist`.

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

**Codex** brings its own OS sandbox (Seatbelt on macOS, Landlock on Linux), so
Lea does **not** wrap it in `sandbox-exec`; it drives Codex with
`--sandbox workspace-write` (edits confined to the project folder) instead. With
the **None** backend, Codex runs with `--dangerously-bypass-approvals-and-sandbox`.

Whichever platform and agent you're on:

- Headless runs never block on a prompt (`--permission-mode bypassPermissions`
  for Claude; non-interactive `codex exec` for Codex) — which is exactly why
  isolation matters.
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

For **Codex** with the Docker backend, build its image instead and pass an
`OPENAI_API_KEY` (Settings → Agents & sign-in → Codex → API key):
```bash
docker build -t lea-codex:latest -f docker/Dockerfile.codex docker/
```

> Note: on a Windows host, make sure the drive containing your project is shared
> with Docker Desktop (Settings → Resources → File sharing).

## Configuration (⚙ Settings)

| Setting | Default | Meaning |
|---|---|---|
| Auto-run | on | Master switch for autonomous execution |
| Default agent | Claude Code | Runs new tasks unless a task picks another agent |
| Agents & sign-in | — | Per-agent sign-in (CLI login or API key) + models |
| Sandbox backend | auto | `auto` (Seatbelt on macOS, none elsewhere), `docker`, or `none` |
| Keep computer awake | on | Prevent sleep while tasks are pending |
| Quiet hours | off | Pause auto-run during a time window |
| Default model | opus / codex default | Model when a task doesn't specify one (per agent) |
| Task timeout | 30 min | Kill a task that runs too long |
| Max retries | 2 | Retries for non-limit errors |
| Token budget / block | off | Pause after N tokens per usage window |

Settings, tasks, and logs live in the app's data folder
(**Settings → Open data folder**): `~/Library/Application Support/Lea` (macOS),
`%APPDATA%\Lea` (Windows), `~/.config/Lea` (Linux).

## Project layout

```
src/
  main.js        Electron entry: shell, IPC, keep-awake, live title
  appshell.js    window+tray per OS: menu-bar (mac) / real app window (win/linux)
  preload.js     contextBridge API for the renderer
  config.js      settings + cross-platform claude/codex/ccusage/PATH resolution
  providers/     agent adapters (claude.js, codex.js) + registry (index.js)
  usage.js       polls ccusage → active usage-block snapshot
  store.js       the to-do queue (tasks.json)
  runner.js      autonomous orchestrator (run → classify → wait/retry)
  sandbox.js     isolation backends + headless claude/codex argv (pure, tested)
  classify.js    ccusage parsing + run-result classification    (pure, tested)
  icon.js        zero-dependency tray + app icon generator
  spawnutil.js   cross-platform buffered spawn (cross-spawn)
  renderer/      the UI (index.html, style.css, app.js)
docker/Dockerfile         image for the Claude Docker sandbox backend
docker/Dockerfile.codex   image for the Codex Docker sandbox backend
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

[MIT](LICENSE) © Lea contributors. Not affiliated with Anthropic or OpenAI.
“Claude” is a trademark of Anthropic; “Codex” is a trademark of OpenAI.
