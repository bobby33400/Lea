'use strict';
/* store.js — the to-do queue, persisted to tasks.json. Emits 'change'. */
const fs = require('fs');
const { EventEmitter } = require('events');
const { TASKS_FILE } = require('./config');
const { extractFollowups } = require('./classify');

function uid() {
  return 't_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

const stripFollowups = (s) => String(s || '').replace(/===LEA-FOLLOWUPS===[\s\S]*?===END-FOLLOWUPS===/i, '').trim();

class Store extends EventEmitter {
  constructor() {
    super();
    this.tasks = this._load();
    this._backfillFollowups();
  }

  // Derive follow-ups / chat thread / sessionId for tasks created before those
  // features existed.
  _backfillFollowups() {
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === 'done' && !t.followups && t.runs && t.runs.length) {
        const msg = t.runs[t.runs.length - 1].message;
        if (msg) {
          t.followups = extractFollowups(msg);
          changed = true;
        }
      }
      if (!t.thread) {
        t.thread = [{ role: 'user', text: t.prompt || '', at: t.createdAt || Date.now() }];
        for (const r of t.runs || []) {
          if (r.message) t.thread.push({ role: 'assistant', text: stripFollowups(r.message), at: r.endedAt, cost: r.costUSD });
        }
        changed = true;
      }
      if (t.sessionId == null && t.runs && t.runs.length) {
        const r = [...t.runs].reverse().find((x) => x.sessionId);
        if (r) {
          t.sessionId = r.sessionId;
          changed = true;
        }
      }
    }
    if (changed) this._save();
  }

  addThreadMessage(id, msg) {
    const t = this.get(id);
    if (!t) return;
    t.thread = t.thread || [];
    t.thread.push(msg);
    if (t.thread.length > 100) t.thread = t.thread.slice(-100);
    this._save();
  }

  // Queue a chat reply that continues the task's claude session on its next run.
  // `images` is an optional [{ name, rel, abs }] of attachments to show Claude.
  reply(id, text, images) {
    const t = this.get(id);
    if (!t) return { ok: false, error: 'Task not found.' };
    if (t.status === 'running') return { ok: false, error: 'Task is still running — wait for it to finish.' };
    const imgs = Array.isArray(images) ? images : [];
    let clean = String(text || '').trim();
    // Allow an image-only reply by giving Claude a sensible default instruction.
    if (!clean && imgs.length) clean = imgs.length > 1 ? 'Please look at the attached images.' : 'Please look at the attached image.';
    if (!clean) return { ok: false, error: 'Empty message.' };
    t.thread = t.thread || [];
    t.thread.push({ role: 'user', text: clean, at: Date.now(), images: imgs });
    t.queuedReply = clean;
    t.queuedReplyImages = imgs;
    t.status = 'queued';
    t.lastError = null;
    t.updatedAt = Date.now();
    this._save();
    return { ok: true, task: { ...t } };
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      return Array.isArray(data.tasks) ? data.tasks : [];
    } catch {
      return [];
    }
  }

  _save() {
    const tmp = TASKS_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ tasks: this.tasks }, null, 2));
      fs.renameSync(tmp, TASKS_FILE);
    } catch {}
    this.emit('change', this.list());
  }

  list() {
    return this.tasks.map((t) => ({ ...t }));
  }
  get(id) {
    return this.tasks.find((t) => t.id === id);
  }

  add({ title, prompt, cwd, model, images } = {}) {
    const now = Date.now();
    const imgs = Array.isArray(images) ? images : [];
    const task = {
      id: uid(),
      title: (title || '').trim() || (prompt || '').trim().slice(0, 48) || 'Untitled task',
      prompt: (prompt || '').trim(),
      cwd: cwd || '',
      model: model || '',
      status: 'queued', // queued | running | done | failed
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      runs: [],
      lastError: null,
      sessionId: null, // latest claude session, for --resume continuations
      queuedReply: null, // a chat reply waiting to be sent on the next run
      queuedReplyImages: null, // images attached to that pending reply
      images: imgs, // images attached to the initial prompt (shown on first run)
      thread: [{ role: 'user', text: (prompt || '').trim(), at: now, images: imgs }], // chat history
    };
    this.tasks.push(task);
    this._save();
    return task;
  }

  update(id, patch) {
    const t = this.get(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: Date.now() });
    this._save();
    return { ...t };
  }

  remove(id) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i >= 0) {
      this.tasks.splice(i, 1);
      this._save();
    }
  }

  clearDone() {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.status !== 'done');
    if (this.tasks.length !== before) this._save();
  }

  reorder(id, dir) {
    const i = this.tasks.findIndex((t) => t.id === id);
    if (i < 0) return;
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= this.tasks.length) return;
    const [t] = this.tasks.splice(i, 1);
    this.tasks.splice(j, 0, t);
    this._save();
  }

  // The next task to run = first 'queued' task in list order.
  getNext() {
    return this.tasks.find((t) => t.status === 'queued') || null;
  }
  hasPending() {
    return this.tasks.some((t) => t.status === 'queued' || t.status === 'running');
  }

  // If the app died mid-run, a task can be stuck 'running'. Requeue on startup.
  recover() {
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === 'running') {
        t.status = 'queued';
        changed = true;
      }
    }
    if (changed) this._save();
  }

  addRun(id, run) {
    const t = this.get(id);
    if (!t) return;
    t.runs = t.runs || [];
    t.runs.push(run);
    if (t.runs.length > 20) t.runs = t.runs.slice(-20);
    this._save();
  }
}

module.exports = { Store, uid };
