'use strict';
/* config.js — paths, persisted settings, and cross-platform binary/PATH
 * resolution. (Requires electron; main-process only.) */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const DATA_DIR = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const SB_DIR = path.join(DATA_DIR, 'sandbox');
const ASSETS_DIR = path.join(DATA_DIR, 'assets');

const DEFAULT_SETTINGS = {
  autoRun: true,
  pollIntervalSec: 30,
  model: 'opus', // model used when you're at the keyboard
  fallbackModel: 'sonnet', // auto-fallback when the chosen model is unavailable
  efficientWhenAway: true, // use a cheaper model for runs while you're idle/asleep
  awayModel: 'sonnet', // the "away" model (sonnet = efficient; haiku = cheapest)
  awayIdleMinutes: 10, // consider you "away" after this many minutes with no input
  permissionMode: 'bypassPermissions',
  sandboxBackend: 'auto', // 'auto' | 'seatbelt' | 'docker' | 'none'
  dockerImage: 'lea-claude:latest',
  claudeOAuthToken: '', // only used by the docker backend (subscription auth)
  keepAwake: true,
  resetBufferSec: 90,
  maxRetries: 2,
  taskTimeoutMin: 30,
  quietHoursEnabled: false,
  quietStart: '00:00',
  quietEnd: '08:00',
  tokenBudgetPerBlock: null,
  extraWriteDirs: [],
  claudeBin: '',
};

function ensureDirs() {
  for (const d of [DATA_DIR, LOGS_DIR, SB_DIR, ASSETS_DIR]) {
    try {
      fs.mkdirSync(d, { recursive: true });
    } catch {}
  }
}

let settings = null;
function loadSettings() {
  ensureDirs();
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  // Migrate the old boolean `sandbox` setting to the new backend selector.
  if (raw.sandboxBackend == null && typeof raw.sandbox === 'boolean') {
    raw.sandboxBackend = raw.sandbox ? 'auto' : 'none';
  }
  delete raw.sandbox;
  settings = { ...DEFAULT_SETTINGS, ...raw };
  return settings;
}
function getSettings() {
  return settings || loadSettings();
}
function get(key) {
  return getSettings()[key];
}
function setSettings(patch) {
  settings = { ...getSettings(), ...(patch || {}) };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {}
  return settings;
}

// Resolve the chosen sandbox setting to a concrete, OS-valid backend.
function effectiveBackend() {
  const b = get('sandboxBackend') || 'auto';
  if (b === 'auto') return IS_MAC ? 'seatbelt' : 'none';
  if (b === 'seatbelt' && !IS_MAC) return 'none'; // seatbelt is macOS-only
  return b; // 'docker' | 'none' | 'seatbelt'
}

// GUI apps don't always inherit the shell PATH; rebuild a sane one (cached).
let cachedPath = null;
function resolvePath() {
  if (cachedPath) return cachedPath;
  const home = os.homedir();
  let extra;
  if (IS_WIN) {
    extra = [
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null,
      path.join(home, '.claude', 'local'),
    ].filter(Boolean);
  } else {
    extra = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      path.join(home, '.claude', 'local'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
    ];
  }
  let shellPath = '';
  if (!IS_WIN) {
    try {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = cp.execFileSync(shell, ['-lic', 'echo __P__:$PATH'], { timeout: 4000, encoding: 'utf8' });
      const m = out.match(/__P__:(.*)/);
      if (m) shellPath = m[1].trim();
    } catch {}
  }
  const merged = [
    ...(process.env.PATH || '').split(path.delimiter),
    ...shellPath.split(':'),
    ...extra,
  ].filter(Boolean);
  cachedPath = [...new Set(merged)].join(path.delimiter);
  return cachedPath;
}

function childEnv(extra) {
  return { ...process.env, PATH: resolvePath(), ...(extra || {}) };
}

let cachedClaude = null;
function resolveClaudeBin() {
  if (cachedClaude) return cachedClaude;
  const home = os.homedir();
  let candidates;
  if (IS_WIN) {
    const appdata = process.env.APPDATA || '';
    const local = process.env.LOCALAPPDATA || '';
    candidates = [
      get('claudeBin'),
      process.env.CLAUDE_BIN,
      appdata && path.join(appdata, 'npm', 'claude.cmd'),
      appdata && path.join(appdata, 'npm', 'claude.exe'),
      local && path.join(local, 'Programs', 'claude', 'claude.exe'),
      path.join(home, '.claude', 'local', 'claude.exe'),
    ].filter(Boolean);
  } else {
    candidates = [
      get('claudeBin'),
      process.env.CLAUDE_BIN,
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(home, '.claude', 'local', 'claude'),
    ].filter(Boolean);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        cachedClaude = c;
        return c;
      }
    } catch {}
  }
  // Last resort: ask the OS where claude lives.
  try {
    if (IS_WIN) {
      const out = cp.execFileSync('where', ['claude'], { timeout: 4000, encoding: 'utf8' }).trim();
      const line = out.split(/\r?\n/).filter(Boolean)[0];
      if (line && fs.existsSync(line)) {
        cachedClaude = line;
        return line;
      }
    } else {
      const shell = process.env.SHELL || '/bin/zsh';
      const out = cp.execFileSync(shell, ['-lic', 'command -v claude'], { timeout: 4000, encoding: 'utf8' }).trim();
      const line = out.split('\n').filter(Boolean).pop();
      if (line && fs.existsSync(line)) {
        cachedClaude = line;
        return line;
      }
    }
  } catch {}
  cachedClaude = IS_WIN ? 'claude.cmd' : 'claude';
  return cachedClaude;
}

function resolveCcusageBin() {
  const name = IS_WIN ? 'ccusage.cmd' : 'ccusage';
  const local = path.join(__dirname, '..', 'node_modules', '.bin', name);
  try {
    if (fs.existsSync(local)) return { bin: local, args: [] };
  } catch {}
  // cross-spawn resolves a bare `npx` correctly on every OS.
  return { bin: 'npx', args: ['-y', 'ccusage@latest'] };
}

module.exports = {
  IS_WIN,
  IS_MAC,
  DATA_DIR,
  SETTINGS_FILE,
  TASKS_FILE,
  LOGS_DIR,
  SB_DIR,
  ASSETS_DIR,
  DEFAULT_SETTINGS,
  ensureDirs,
  loadSettings,
  getSettings,
  get,
  setSettings,
  effectiveBackend,
  resolvePath,
  childEnv,
  resolveClaudeBin,
  resolveCcusageBin,
};
