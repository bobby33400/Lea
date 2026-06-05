'use strict';
/* usage.js — polls ccusage for the active 5-hour block and emits 'update'. */
const { EventEmitter } = require('events');
const config = require('./config');
const { run } = require('./spawnutil');
const { parseCcusageBlocks } = require('./classify');

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
      snap.updatedAt = Date.now();
      snap.error = null;
      this.snapshot = snap;
    } catch {
      this.snapshot = { ...this.snapshot, updatedAt: Date.now(), error: 'parse error' };
    }
    this.emit('update', this.snapshot);
  }

  msUntilReset() {
    if (!this.snapshot.resetAt) return null;
    return Math.max(0, this.snapshot.resetAt - Date.now());
  }
}

module.exports = { UsageMonitor };
