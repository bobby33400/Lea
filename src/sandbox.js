'use strict';
/*
 * sandbox.js — builds the isolation wrapper + headless `claude` argv.
 *
 * PURE module (no electron, no fs side effects at import) so it stays
 * unit-testable. Supports three backends:
 *
 *   'seatbelt' (macOS) — wrap claude in `sandbox-exec` with a profile that
 *       confines file WRITES to the task's project folder. Zero install.
 *   'docker'  (any OS) — run claude inside a container with ONLY the project
 *       dir mounted writable. Cross-platform isolation; needs Docker + an image
 *       that has the Claude CLI, and (for subscription auth) a token env var.
 *   'none'    (any OS) — run claude directly. No isolation. The UI warns.
 *
 * Seatbelt semantics: the LAST matching rule wins, so ordering matters.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DOCKER_WORKDIR = '/workspace'; // where the project is mounted inside the container

// Model tiers, ranked by capability/cost (higher = more capable & pricier).
const MODEL_RANK = { haiku: 1, sonnet: 2, opus: 3 };

/**
 * Decide the --fallback-model to actually pass for a given primary model.
 *
 * The configured fallback (default 'sonnet') is only a valid safety net BENEATH
 * the chosen model. It's invisible while the model is the default 'opus', but
 * the moment you switch the model in Settings it becomes wrong:
 *   - 'sonnet' → '--model sonnet --fallback-model sonnet' (primary == fallback);
 *     a contradictory flag pair Claude rejects, so every run fails.
 *   - 'haiku'  → an overloaded haiku run silently ESCALATES to the pricier
 *     sonnet, defeating the reason you picked haiku.
 * So: drop the fallback when it duplicates the primary or isn't strictly cheaper.
 * Unknown aliases (custom model ids) keep whatever was configured.
 */
function chooseFallback(model, fallback) {
  if (!fallback || !model) return fallback || null;
  if (fallback === model) return null;
  const rm = MODEL_RANK[model];
  const rf = MODEL_RANK[fallback];
  if (rm != null && rf != null && rf >= rm) return null; // never duplicate or escalate
  return fallback;
}

function esc(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function subpaths(label, dirs) {
  const clean = (dirs || []).filter(Boolean);
  if (clean.length === 0) return '';
  return `(${label} ${clean.map((d) => `(subpath "${esc(d)}")`).join(' ')})`;
}

/** Build a macOS Seatbelt profile string that confines writes. */
function buildSeatbeltProfile(o) {
  const home = o.home;
  const claudeNeeds = [
    `${home}/.claude`,
    `${home}/.config`,
    `${home}/.npm`,
    `${home}/.cache`,
    `${home}/.cargo`,
    `${home}/Library/Caches`,
    `${home}/Library/Application Support`,
    `${home}/Library/Logs`,
    `${home}/Library/pnpm`,
    `${home}/.bun`,
    `${home}/Library/Keychains`, // Claude refreshes its OWN login token here — must be writable
  ];
  const writable = [o.cwd, o.dataDir, ...(o.extraDirs || [])].filter(Boolean);
  // Sensitive plaintext credential dirs we keep tamper-protected. NOTE: we do
  // NOT deny ~/Library/Keychains — Claude stores & silently refreshes its own
  // OAuth login token there; blocking it makes the token go stale and every
  // sandboxed run fail with "401 Invalid authentication credentials" until the
  // user manually /login. (Reads are open anyway, so this isn't an exfil change.)
  const protectedDirs = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.gcloud`,
    `${home}/.config/gcloud`,
    `${home}/.kube`,
    `${home}/.docker`,
  ];

  const lines = [
    '(version 1)',
    '',
    '; Allow everything by default — reads, exec, and network stay open so the',
    '; tools Claude drives keep working. We only clamp down on file WRITES below.',
    '(allow default)',
    '',
    '; 1) Deny writes to the entire home directory ...',
    `(deny file-write* (subpath "${esc(home)}"))`,
    '',
    '; 2) ... then re-allow the project + opted-in dirs (where edits should land)',
    subpaths('allow file-write*', writable),
    '',
    '; 3) ... and the dirs Claude needs to operate (its own config + caches)',
    subpaths('allow file-write*', claudeNeeds),
    '',
    '; 4) Finally, hard-deny the crown jewels so nothing above can expose them',
    subpaths('deny file-write*', protectedDirs),
    '',
  ];
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

/** claude's own argv (shared by all backends). addDirs override per backend. */
function buildClaudeArgs(o, addDirs) {
  // stream-json (+ required --verbose) so Lea can show live progress; the final
  // event is the same result object the json format emits.
  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', o.permissionMode || 'bypassPermissions'];
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId); // continue a chat thread
  if (o.model) args.push('--model', o.model);
  const fallback = chooseFallback(o.model, o.fallbackModel);
  if (fallback) args.push('--fallback-model', fallback);
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt);
  for (const d of addDirs || []) args.push('--add-dir', d);
  return args;
}

/**
 * Build the final {bin, args} to spawn for a given backend.
 * For 'seatbelt' the caller must have written `sbFile` (buildSeatbeltProfile).
 */
function buildCommand(o) {
  const backend = o.backend || 'none';

  if (backend === 'seatbelt') {
    const args = ['-f', o.sbFile, o.claudeBin, ...buildClaudeArgs(o, o.addDirs || [o.cwd])];
    return { bin: SANDBOX_EXEC, args };
  }

  if (backend === 'docker') {
    const image = o.dockerImage || 'lea-claude:latest';
    const args = ['run', '--rm', '-i'];
    if (o.containerName) args.push('--name', o.containerName);
    // Mount ONLY the project dir, writable, at a fixed workdir inside the container.
    args.push('-v', `${o.cwd}:${DOCKER_WORKDIR}`, '-w', DOCKER_WORKDIR);
    // Mount any image-attachment dirs read-only so Claude can Read them.
    for (const m of o.attachmentMounts || []) args.push('-v', `${m.hostDir}:${m.containerDir}:ro`);
    // Pass the subscription token through from the runner's environment (value
    // is NOT embedded in argv). Caller sets CLAUDE_CODE_OAUTH_TOKEN in env.
    if (o.dockerToken) args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN');
    for (const e of o.dockerEnvPass || []) args.push('-e', e);
    const dockerAddDirs = [DOCKER_WORKDIR, ...(o.attachmentMounts || []).map((m) => m.containerDir)];
    args.push(image, 'claude', ...buildClaudeArgs(o, dockerAddDirs));
    return { bin: 'docker', args };
  }

  // none
  return { bin: o.claudeBin, args: buildClaudeArgs(o, o.addDirs || [o.cwd]) };
}

module.exports = {
  buildSeatbeltProfile,
  buildProfile: buildSeatbeltProfile, // backwards-compatible alias
  buildClaudeArgs,
  buildCommand,
  chooseFallback,
  SANDBOX_EXEC,
  DOCKER_WORKDIR,
};
