'use strict';
/* usage.js — polls ccusage for the active 5-hour block and emits 'update'. */
const { EventEmitter } = require('events');
const config = require('./config');
const { run } = require('./spawnutil');
const { parseCcusageBlocks } = require('./classify');
const { preciseWindow, modelUsageInRange } = require('./window');

class UsageMonitor extends EventEmitter {
  constructor() {
    super();
    this.snapshot = {
      active: false,
      startAt: null,
      resetAt: null,
      totalTokens: 0,
      costUSD: 0,
      burnRate: null,
      projection: null,
      models: [],
      updatedAt: 0,
      error: null,
    };
    this.timer = null;
  }

  start() {
    this.poll();
    const ms = Math.max(10, config.get('pollIntervalSec') || 30) * 1000;
    this.timer = setInterval(() => this.poll(), ms);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    const { bin, args } = config.resolveCcusageBin();
    const { code, stdout, stderr } = await run(bin, [...args, 'blocks', '--active', '--json'], {
      env: config.childEnv(),
      timeout: 60000,
    });
    if (code !== 0 && !stdout) {
      this.snapshot = {
        ...this.snapshot,
        updatedAt: Date.now(),
        error: String(stderr || 'ccusage failed').slice(0, 200),
      };
      this.emit('update', this.snapshot);
      return;
    }
    try {
      const snap = parseCcusageBlocks(stdout);
      this._refineReset(snap); // correct ccusage's hour-floored reset
      this._addModelBreakdown(snap); // per-model usage for this session
      snap.updatedAt = Date.now();
      snap.error = null;
      this.snapshot = snap;
    } catch {
      this.snapshot = { ...this.snapshot, updatedAt: Date.now(), error: 'parse error' };
    }
    this.emit('update', this.snapshot);
  }

  // Replace ccusage's floored block bounds with the precise window derived from
  // the real first-message timestamp. Cached per block so we scan transcripts
  // at most once per 5-hour window — but ONLY when the scan succeeds (precise).
  // If the scan fails we leave the cache unset so the next poll retries.
  _refineReset(snap) {
    if (!snap.active || !snap.startAt || !snap.resetAt) return;
    const key = snap.startAt; // floored block start is a stable id
    if (this._wKey === key && this._wPrecise) {
      snap.startAt = this._wStart;
      snap.resetAt = this._wReset;
      snap.preciseReset = true;
      return;
    }
    try {
      const w = preciseWindow(snap.startAt, snap.resetAt);
      snap.startAt = w.startAt;
      snap.resetAt = w.resetAt;
      snap.preciseReset = w.precise;
      if (w.precise) {
        this._wKey = key;
        this._wStart = w.startAt;
        this._wReset = w.resetAt;
        this._wPrecise = true;
      }
    } catch {
      /* keep ccusage's values on any error */
    }
  }

  // Attach a per-model token breakdown for the current session window.
  _addModelBreakdown(snap) {
    if (!snap.active || !snap.startAt) {
      snap.modelBreakdown = [];
      return;
    }
    try {
      const usage = modelUsageInRange(snap.startAt, snap.resetAt || Date.now());
      snap.modelBreakdown = Object.entries(usage)
        .map(([model, u]) => ({ model, ...u }))
        .sort((a, b) => b.total - a.total);
    } catch {
      snap.modelBreakdown = [];
    }
  }

  msUntilReset() {
    if (!this.snapshot.resetAt) return null;
    return Math.max(0, this.snapshot.resetAt - Date.now());
  }
}

module.exports = { UsageMonitor };
