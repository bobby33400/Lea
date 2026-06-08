'use strict';
/* runner.js — the autonomous orchestrator.
 *
 * Loop: if auto-run is on, not in quiet hours, and not waiting on a reset, take
 * the next queued task and run it headlessly via `claude -p`, isolated by the
 * configured backend (Seatbelt on macOS, Docker elsewhere, or none). Classify:
 *   ok      -> mark done
 *   limited -> requeue + sleep until the usage window resets, then retry
 *   error   -> retry up to maxRetries, else mark failed
 *
 * Keep-awake (so the machine doesn't sleep overnight) is handled in main.js via
 * Electron's cross-platform powerSaveBlocker.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const { EventEmitter } = require('events');
const config = require('./config');
const { LOGS_DIR, SB_DIR, DATA_DIR, IS_WIN } = config;
const { buildSeatbeltProfile, buildCommand } = require('./sandbox');
const { classifyClaudeResult, summarizeStreamEvent } = require('./classify');
const report = require('./report');

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Appended to every run's system prompt so Claude reports what the human still
// has to do (and we can parse + surface it).
const FOLLOWUP_INSTRUCTION = [
  'When you have completely finished the task, append a final section in EXACTLY this format, with nothing after it:',
  '===LEA-FOLLOWUPS===',
  '- <one action the human must do themselves, with any exact command in backticks>',
  '- <another action>',
  '===END-FOLLOWUPS===',
  'List ONLY actions you could not complete yourself that require the human — e.g. pushing to a remote, applying a database migration, deploying, rotating or adding a secret/API key, approving risky changes, or manual testing. Keep each item short and actionable. If there are none, write NONE on a single line between the markers.',
].join('\n');

// Reference attached images by their (project-relative) path so headless Claude
// reads them with its Read tool — the supported way to pass images to `claude -p`.
function promptWithImages(prompt, rels) {
  const list = (rels || []).filter(Boolean);
  if (!list.length) return prompt;
  const bullets = list.map((r) => `- ${r}`).join('\n');
  const noun = list.length > 1 ? 'images' : 'image';
  return (
    `${prompt}\n\n` +
    `The user attached ${list.length} ${noun} to this message (paths are relative to the project folder). ` +
    `Use your Read tool to view ${list.length > 1 ? 'each of them' : 'it'} before responding:\n${bullets}`
  );
}

class Runner extends EventEmitter {
  constructor({ store, usage, getIdleSeconds }) {
    super();
    this.store = store;
    this.usage = usage;
    this.getIdleSeconds = getIdleSeconds || (() => 0); // seconds since last user input
    this.busy = false;
    this.currentTaskId = null;
    this.currentChild = null;
    this.currentKill = null;
    this.waitUntil = null;
    this.waitReason = null;
    this.phase = 'idle';
    this.loop = null;
    this.waitTimer = null;
  }

  start() {
    this.store.recover();
    this.loop = setInterval(() => this.tick(), 5000);
    this.tick();
  }
  stop() {
    if (this.loop) clearInterval(this.loop);
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.currentKill) this.currentKill();
  }

  state() {
    return {
      busy: this.busy,
      currentTaskId: this.currentTaskId,
      waitUntil: this.waitUntil,
      waitReason: this.waitReason,
      autoRun: config.get('autoRun'),
      phase: this.phase,
      away: this._isAway(),
    };
  }

  // "Away" = efficient mode on AND you haven't touched the machine for a while.
  _isAway() {
    if (!config.get('efficientWhenAway')) return false;
    const mins = config.get('awayIdleMinutes');
    if (mins == null || mins <= 0) return false;
    try {
      return this.getIdleSeconds() >= mins * 60;
    } catch {
      return false;
    }
  }

  // Explicit per-task model wins; otherwise cheap "away" model if idle, else default.
  _modelFor(task) {
    if (task.model) return task.model;
    if (this._isAway()) return config.get('awayModel') || 'sonnet';
    return config.get('model');
  }

  _emitState() {
    this.emit('state', this.state());
  }

  inQuietHours(d = new Date()) {
    if (!config.get('quietHoursEnabled')) return false;
    const toMin = (s) => {
      const [h, m] = String(s).split(':').map(Number);
      return (h || 0) * 60 + (m || 0);
    };
    const now = d.getHours() * 60 + d.getMinutes();
    const a = toMin(config.get('quietStart'));
    const b = toMin(config.get('quietEnd'));
    if (a === b) return false;
    return a < b ? now >= a && now < b : now >= a || now < b;
  }

  _setWait(until, reason) {
    this.waitUntil = until;
    this.waitReason = reason;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    const buffer = (config.get('resetBufferSec') || 90) * 1000;
    const delay = Math.max(1000, until - Date.now() + buffer);
    this.waitTimer = setTimeout(() => {
      this.waitUntil = null;
      this.waitReason = null;
      this.tick();
    }, delay);
    this._emitState();
  }

  async tick() {
    if (this.busy) return;
    if (!config.get('autoRun')) {
      this.phase = 'paused';
      this._emitState();
      return;
    }
    if (this.waitUntil && Date.now() < this.waitUntil) {
      this.phase = 'waiting';
      return;
    }
    if (this.inQuietHours()) {
      this.phase = 'quiet';
      this._emitState();
      return;
    }

    const task = this.store.getNext();
    if (!task) {
      this.phase = 'idle';
      this._emitState();
      return;
    }

    const budget = config.get('tokenBudgetPerBlock');
    const snap = this.usage.snapshot;
    if (budget && snap && snap.active && snap.totalTokens >= budget && snap.resetAt) {
      this._setWait(snap.resetAt, 'token budget reached — waiting for reset');
      this.phase = 'waiting';
      return;
    }

    await this.run(task);
  }

  async runNow(id) {
    if (this.busy) return { ok: false, error: 'A task is already running.' };
    const t = this.store.get(id);
    if (!t) return { ok: false, error: 'Task not found.' };
    await this.run(t);
    return { ok: true };
  }

  _validateCwd(task) {
    if (!task.cwd) return 'No project folder set for this task.';
    try {
      if (!fs.statSync(task.cwd).isDirectory()) return 'Project folder is not a directory.';
    } catch {
      return 'Project folder does not exist: ' + task.cwd;
    }
    return null;
  }

  async run(task) {
    const cwdErr = this._validateCwd(task);
    if (cwdErr) {
      this.store.update(task.id, { status: 'failed', lastError: cwdErr });
      return;
    }

    this.busy = true;
    this.currentTaskId = task.id;
    this.phase = 'running';

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(LOGS_DIR, `${task.id}-${ts}.log`);
    const startedAt = Date.now();

    // Record the live log path so it can be viewed WHILE the task runs.
    this.store.update(task.id, { status: 'running', currentLogFile: logFile });
    this._emitState();

    const model = this._modelFor(task); // cheap "away" model if idle, else your default
    // A queued chat reply continues the existing claude session via --resume.
    const isReply = !!(task.queuedReply && task.sessionId);
    const basePrompt = isReply ? task.queuedReply : task.prompt;
    const runImages = isReply ? task.queuedReplyImages || [] : task.images || [];
    const prompt = promptWithImages(basePrompt, runImages.map((i) => i.rel));
    const resumeId = isReply ? task.sessionId : null;
    const reportCtx = report.start(task, model, prompt); // create Lea_Reports/<file>.md + snapshot

    let result;
    try {
      result = await this._exec(task, logFile, model, { prompt, resumeId });
    } catch (e) {
      result = { kind: 'error', error: 'spawn', message: String((e && e.message) || e) };
    }

    const reportFile = report.finish(reportCtx, task, result, model); // write the changelog

    this.store.addRun(task.id, {
      startedAt,
      endedAt: Date.now(),
      logFile,
      reportFile,
      kind: result.kind,
      costUSD: result.costUSD || null,
      sessionId: result.sessionId || null,
      message: result.message || result.result || null,
      error: result.kind === 'error' ? result.message || result.error : null,
    });

    const strip = (s) => String(s || '').replace(/===LEA-FOLLOWUPS===[\s\S]*?===END-FOLLOWUPS===/i, '').trim();
    let finished = null;
    if (result.kind === 'ok') {
      const patch = { status: 'done', lastError: null, followups: result.followups || [], reportFile, queuedReply: null, queuedReplyImages: null };
      if (result.sessionId) patch.sessionId = result.sessionId; // for future --resume replies
      this.store.update(task.id, patch);
      this.store.addThreadMessage(task.id, {
        role: 'assistant',
        text: strip(result.result) || '(done)',
        at: Date.now(),
        cost: result.costUSD,
        model,
      });
      finished = { id: task.id, title: task.title, status: 'done', followups: result.followups || [] };
    } else if (result.kind === 'limited') {
      this.store.update(task.id, { status: 'queued' }); // keep queuedReply so the reply retries after reset
      const resetAt = (this.usage.snapshot && this.usage.snapshot.resetAt) || Date.now() + 30 * 60 * 1000;
      this._setWait(resetAt, 'usage limit — waiting for reset');
    } else {
      const attempts = (task.attempts || 0) + 1;
      const max = config.get('maxRetries') || 0;
      if (attempts <= max) {
        this.store.update(task.id, { status: 'queued', attempts, lastError: result.message });
        this._setWait(Date.now() + 60 * 1000, 'retrying after error');
      } else {
        this.store.update(task.id, { status: 'failed', attempts, lastError: result.message, reportFile, queuedReply: null, queuedReplyImages: null });
        this.store.addThreadMessage(task.id, {
          role: 'assistant',
          text: '⚠️ Failed: ' + (result.message || result.error || 'error'),
          at: Date.now(),
          error: true,
        });
        finished = { id: task.id, title: task.title, status: 'failed', followups: [] };
      }
    }

    this.busy = false;
    this.currentTaskId = null;
    this.currentChild = null;
    this.currentKill = null;
    this.phase = 'idle';
    this._emitState();
    if (finished) this.emit('finished', finished);
    setImmediate(() => this.tick());
  }

  _killTree(child, backend, containerName, env) {
    try {
      if (backend === 'docker' && containerName) {
        try {
          spawn('docker', ['kill', containerName], { env, stdio: 'ignore' });
        } catch {}
      }
      if (IS_WIN) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } catch {}
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 5000);
      }
    } catch {}
  }

  _exec(task, logFile, model, runOpts) {
    return new Promise((resolve) => {
      const backend = config.effectiveBackend();
      const sbFile = path.join(SB_DIR, `${task.id}.sb`);
      if (backend === 'seatbelt') {
        const prof = buildSeatbeltProfile({
          home: os.homedir(),
          cwd: realpath(task.cwd),
          dataDir: DATA_DIR,
          extraDirs: (config.get('extraWriteDirs') || []).map(realpath),
        });
        try {
          fs.writeFileSync(sbFile, prof);
        } catch {}
      }

      const containerName = backend === 'docker' ? `lea-${task.id}` : null;
      const token = backend === 'docker' ? config.get('claudeOAuthToken') || '' : '';

      const { bin, args } = buildCommand({
        backend,
        claudeBin: config.resolveClaudeBin(),
        prompt: (runOpts && runOpts.prompt) || task.prompt,
        cwd: realpath(task.cwd),
        model: model || task.model || config.get('model'),
        fallbackModel: config.get('fallbackModel'),
        permissionMode: config.get('permissionMode') || 'bypassPermissions',
        appendSystemPrompt: FOLLOWUP_INSTRUCTION,
        addDirs: [task.cwd],
        sbFile,
        dockerImage: config.get('dockerImage'),
        containerName,
        dockerToken: !!(backend === 'docker' && token),
        resumeSessionId: runOpts && runOpts.resumeId,
      });

      const env = config.childEnv(backend === 'docker' && token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : null);

      const log = fs.createWriteStream(logFile, { flags: 'a' });
      log.write(
        [
          '# Lea run',
          `# task:    ${task.title}`,
          `# cwd:     ${task.cwd}`,
          `# when:    ${new Date().toISOString()}`,
          `# backend: ${backend}`,
          `# cmd:     ${bin} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
          '',
          '',
        ].join('\n')
      );

      let stdout = '';
      let stderr = '';
      let lineBuf = '';
      let child;
      try {
        // stdin = ignore so claude doesn't wait ~3s for input it'll never get.
        child = spawn(bin, args, { cwd: task.cwd, env, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        log.write(`\n[spawn error] ${e.message}\n`);
        log.end();
        return resolve({ kind: 'error', error: 'spawn', message: e.message });
      }
      this.currentChild = child;
      this.currentKill = () => this._killTree(child, backend, containerName, env);

      const timeoutMs = Math.max(1, config.get('taskTimeoutMin') || 30) * 60 * 1000;
      let timedOut = false;
      const killTimer = setTimeout(() => {
        timedOut = true;
        if (this.currentKill) this.currentKill();
      }, timeoutMs);

      // One stream-json line → readable play-by-play in the log + live activity event.
      const handleLine = (line) => {
        const s = line.trim();
        if (!s || s[0] !== '{') return;
        let o;
        try {
          o = JSON.parse(s);
        } catch {
          return;
        }
        if (o.type === 'result') return; // final result handled on close
        const parts = summarizeStreamEvent(o);
        for (const p of parts) log.write(p + '\n');
        if (parts.length) this.emit('activity', { id: task.id, text: parts[parts.length - 1] });
      };

      if (child.stdout)
        child.stdout.on('data', (d) => {
          const s = d.toString();
          stdout += s;
          if (stdout.length > 1000000) stdout = stdout.slice(-1000000); // keep a tail (result is last)
          lineBuf += s;
          let idx;
          while ((idx = lineBuf.indexOf('\n')) >= 0) {
            handleLine(lineBuf.slice(0, idx));
            lineBuf = lineBuf.slice(idx + 1);
          }
        });
      if (child.stderr)
        child.stderr.on('data', (d) => {
          const s = d.toString();
          stderr += s;
          log.write(s);
        });
      child.on('error', (e) => {
        stderr += '\n' + e.message;
      });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        if (lineBuf.trim()) handleLine(lineBuf);
        const res = classifyClaudeResult({ code, stdout, stderr, timedOut });
        log.write(`\n# result: ${res.kind}${res.message ? ' — ' + res.message : ''}\n`);
        log.end();
        resolve(res);
      });
    });
  }
}

module.exports = { Runner };
