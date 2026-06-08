'use strict';
/* report.js — writes a per-task changelog into the project being worked on.
 *
 * Before a task runs: create <cwd>/Lea_Reports/Lea_Task_<date>_<time>.md and
 * snapshot the project's files. After it finishes: diff the snapshot to list
 * what was added / modified / deleted, and write the full report.
 *
 * Lea writes these from the host (not through the sandbox), so it works for
 * every backend. The pure diff logic is unit-tested.
 */
const fs = require('fs');
const path = require('path');

const REPORT_DIRNAME = 'Lea_Reports';
const SKIP_DIRS = new Set([
  'node_modules', '.git', REPORT_DIRNAME, '.lea-attachments', 'dist', 'build', 'out', '.next', '.nuxt',
  '.expo', '.turbo', 'coverage', '.cache', 'Pods', '.gradle', 'DerivedData',
  'vendor', '.venv', '__pycache__', '.idea', '.vscode', '.svelte-kit',
]);
const MAX_FILES = 60000;

const pad = (n) => String(n).padStart(2, '0');
function stamp(d) {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  };
}

// Map relPath -> "mtimeMs:size", skipping heavy/noisy dirs. Bounded by MAX_FILES.
function snapshot(root) {
  const map = new Map();
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (count > MAX_FILES) return map;
      if (e.name === '.DS_Store') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        map.set(path.relative(root, full), st.mtimeMs + ':' + st.size);
        count++;
      }
    }
  }
  return map;
}

// Pure: compare two snapshots.
function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [p, v] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== v) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}

// Create the folder + initial report and snapshot the "before" state.
function start(task, model, prompt) {
  const ctx = { ok: false };
  try {
    const cwd = task.cwd;
    if (!cwd || !fs.statSync(cwd).isDirectory()) return ctx;
    const promptText = prompt || task.prompt;
    const dir = path.join(cwd, REPORT_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const s = stamp(now);
    const file = path.join(dir, `Lea_Task_${s.date}_${s.time}.md`);
    fs.writeFileSync(
      file,
      [
        '# Lea Task Report',
        '',
        `- **Task:** ${task.title}`,
        `- **Started:** ${now.toLocaleString()}`,
        `- **Project:** \`${cwd}\``,
        `- **Model:** ${model || task.model || '(default)'}`,
        '- **Status:** ⏳ in progress…',
        '',
        '## Instructions',
        '',
        '```',
        promptText,
        '```',
        '',
        '## Changes',
        '',
        '_(filled in when the task finishes)_',
        '',
      ].join('\n')
    );
    ctx.file = file;
    ctx.prompt = promptText;
    ctx.before = snapshot(cwd);
    ctx.startedAt = now;
    ctx.ok = true;
  } catch {}
  return ctx;
}

function fileSection(title, arr, max = 300) {
  if (!arr.length) return [`**${title}:** none`, ''];
  const shown = arr.slice(0, max).map((p) => `- \`${p}\``);
  if (arr.length > max) shown.push(`- …and ${arr.length - max} more`);
  return [`**${title} (${arr.length}):**`, '', ...shown, ''];
}

// Fill in the report with the diff + result. Returns the report file path.
function finish(ctx, task, result, model) {
  if (!ctx || !ctx.ok || !ctx.file) return null;
  try {
    const { added, modified, deleted } = diffSnapshots(ctx.before, snapshot(task.cwd));
    const ended = new Date();
    const secs = Math.round((ended - ctx.startedAt) / 1000);
    const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
    const kind =
      result.kind === 'ok' ? '✅ success' : result.kind === 'limited' ? '⏸ hit usage limit' : '❌ ' + (result.error || 'error');
    const summary = String(result.result || result.message || '')
      .replace(/===LEA-FOLLOWUPS===[\s\S]*?===END-FOLLOWUPS===/i, '')
      .trim();

    const lines = [
      '# Lea Task Report',
      '',
      `- **Task:** ${task.title}`,
      `- **Started:** ${ctx.startedAt.toLocaleString()}`,
      `- **Finished:** ${ended.toLocaleString()}  (${dur})`,
      `- **Project:** \`${task.cwd}\``,
      `- **Model:** ${model || task.model || '(default)'}`,
      `- **Result:** ${kind}`,
    ];
    if (result.costUSD) lines.push(`- **Cost (API-equivalent):** $${Number(result.costUSD).toFixed(4)}`);
    lines.push('', '## Instructions', '', '```', ctx.prompt || task.prompt, '```', '', '## Changes', '');
    lines.push(...fileSection('➕ Added', added));
    lines.push(...fileSection('✏️ Modified', modified));
    lines.push(...fileSection('🗑️ Deleted', deleted));
    if (result.followups && result.followups.length) {
      lines.push('## Things for you to do', '');
      for (const f of result.followups) lines.push(`- ${f}`);
      lines.push('');
    }
    if (summary) lines.push("## Claude's summary", '', summary, '');

    fs.writeFileSync(ctx.file, lines.join('\n'));
    return ctx.file;
  } catch {
    return ctx.file || null;
  }
}

module.exports = { start, finish, snapshot, diffSnapshots, REPORT_DIRNAME };
