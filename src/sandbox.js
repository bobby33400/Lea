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
  ];
  const writable = [o.cwd, o.dataDir, ...(o.extraDirs || [])].filter(Boolean);
  const protectedDirs = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.gcloud`,
    `${home}/.config/gcloud`,
    `${home}/.kube`,
    `${home}/.docker`,
    `${home}/Library/Keychains`,
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
  const args = ['-p', o.prompt, '--output-format', 'json', '--permission-mode', o.permissionMode || 'bypassPermissions'];
  if (o.model) args.push('--model', o.model);
  if (o.fallbackModel) args.push('--fallback-model', o.fallbackModel);
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
    // Pass the subscription token through from the runner's environment (value
    // is NOT embedded in argv). Caller sets CLAUDE_CODE_OAUTH_TOKEN in env.
    if (o.dockerToken) args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN');
    for (const e of o.dockerEnvPass || []) args.push('-e', e);
    args.push(image, 'claude', ...buildClaudeArgs(o, [DOCKER_WORKDIR]));
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
  SANDBOX_EXEC,
  DOCKER_WORKDIR,
};
