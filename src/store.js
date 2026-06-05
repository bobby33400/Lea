'use strict';
/* store.js — the to-do queue, persisted to tasks.json. Emits 'change'. */
const fs = require('fs');
const { EventEmitter } = require('events');
const { TASKS_FILE } = require('./config');
const { extractFollowups } = require('./classify');

function uid() {
  return 't_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
}

class Store extends EventEmitter {
  constructor() {
    super();
    this.tasks = this._load();
    this._backfillFollowups();
  }

  // Derive follow-ups for done tasks created before this feature existed.
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
    }
    if (changed) this._save();
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

  add({ title, prompt, cwd, model } = {}) {
    const now = Date.now();
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
