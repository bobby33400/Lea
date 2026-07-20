'use strict';
/* main.js — Electron entry: tray + window, IPC, keep-awake, live title. */
const { app, ipcMain, dialog, shell, nativeImage, powerSaveBlocker, powerMonitor, Notification } = require('electron');
const path = require('path');

app.setName('Lea'); // affects userData path + about panel; call before 'ready'

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const IS_MAC = process.platform === 'darwin';
let mb, store, usage, runner, titleTimer, psbId = null;

app.on('second-instance', () => {
  if (mb) mb.showWindow();
});

if (gotLock) app.whenReady().then(init);

function init() {
  if (app.dock) app.dock.hide(); // tray-only, no dock icon (macOS)

  const config = require('./config');
  config.loadSettings();
  const appshell = require('./appshell');
  const { ensureTrayIcon } = require('./icon');
  const { Store } = require('./store');
  const { UsageMonitor } = require('./usage');
  const { Runner } = require('./runner');

  const iconPath = ensureTrayIcon(config.ASSETS_DIR);

  store = new Store();
  usage = new UsageMonitor();
  runner = new Runner({
    store,
    usage,
    getIdleSeconds: () => {
      try {
        return powerMonitor.getSystemIdleTime();
      } catch {
        return 0;
      }
    },
  });

  // macOS → menu-bar popover; Windows/Linux → a real windowed app + tray.
  mb = appshell.create({
    index: 'file://' + path.join(__dirname, 'renderer', 'index.html'),
    icon: iconPath,
    tooltip: 'Lea',
    browserWindow: {
      width: 420,
      height: 680,
      resizable: !IS_MAC, // fixed popover on mac; a normal resizable window elsewhere
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', () => {
    // The menu-bar (mac) icon is a monochrome template; the Windows/Linux tray
    // icon is set in appshell and must stay colored, so only templatize on mac.
    if (IS_MAC) {
      try {
        const img = nativeImage.createFromPath(iconPath);
        img.setTemplateImage(true);
        mb.tray.setImage(img);
      } catch {}
    }
    mb.tray.setToolTip('Lea');

    wireIpc(config);
    forwardEvents(config);

    usage.start();
    runner.start();
    updatePower(config);
    startTitleTimer();
  });

  app.on('before-quit', () => {
    app.isQuitting = true; // let the windowed shell's close handler exit for real
    try {
      usage.stop();
    } catch {}
    try {
      runner.stop();
    } catch {}
    if (titleTimer) clearInterval(titleTimer);
    if (psbId !== null && powerSaveBlocker.isStarted(psbId)) powerSaveBlocker.stop(psbId);
  });
}

function send(type, payload) {
  if (mb && mb.window && !mb.window.isDestroyed()) {
    mb.window.webContents.send('update', { type, payload });
  }
}

// Keep the machine awake (allowing the display to sleep) while work is pending.
function updatePower(config) {
  const want = config.get('keepAwake') && store.hasPending();
  if (want && psbId === null) {
    psbId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!want && psbId !== null) {
    try {
      powerSaveBlocker.stop(psbId);
    } catch {}
    psbId = null;
  }
}

function forwardEvents(config) {
  store.on('change', (tasks) => {
    send('tasks', tasks);
    updatePower(config);
  });
  usage.on('update', (snap) => send('usage', snap));
  runner.on('state', (st) => {
    send('runner', st);
    updatePower(config);
  });
  runner.on('finished', (info) => notifyFinished(info));
  runner.on('activity', (a) => send('activity', a));
}

// Tell the user a task wrapped up — and whether it needs them.
function notifyFinished(info) {
  try {
    if (!Notification.isSupported()) return;
    let title;
    let body;
    if (info.status === 'auth') {
      const isCodex = info.provider === 'codex';
      title = isCodex ? '🔑 Sign in to Codex again' : '🔑 Sign in to Claude again';
      body = isCodex
        ? 'Lea paused — your Codex sign-in expired. Run `codex login` (or set an API key), then turn auto-run back on.'
        : 'Lea paused — your Claude login expired. Run `claude`, then /login, and turn auto-run back on.';
    } else if (info.status === 'done') {
      const n = (info.followups || []).length;
      title = '✅ ' + info.title;
      body = n ? `Done — ${n} thing${n > 1 ? 's' : ''} for you to do. Click to view.` : 'Done — nothing needed from you.';
    } else if (info.status === 'failed') {
      title = '⚠️ ' + info.title;
      body = 'Failed — click to see the log.';
    } else {
      return;
    }
    const notif = new Notification({ title, body });
    notif.on('click', () => {
      if (mb) mb.showWindow();
    });
    notif.show();
  } catch {}
}

function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function startTitleTimer() {
  const tick = () => {
    if (!mb || !mb.tray) return;
    const st = runner.state();
    const snap = usage.snapshot;
    const queued = store.list().filter((t) => t.status === 'queued').length;

    let shortTitle = '';
    let status = 'idle';
    if (st.busy) {
      shortTitle = `▶${queued ? ' ' + queued : ''}`;
      status = 'running a task';
    } else if (st.waitUntil && st.waitUntil > Date.now()) {
      shortTitle = `⏳ ${fmtDur(st.waitUntil - Date.now())}`;
      status = `${st.waitReason || 'waiting'} (${fmtDur(st.waitUntil - Date.now())})`;
    } else if (snap && snap.active && snap.resetAt) {
      shortTitle = `◷ ${fmtDur(snap.resetAt - Date.now())}${queued ? ' · ' + queued : ''}`;
      status = `${fmtDur(snap.resetAt - Date.now())} until reset · ${queued} queued`;
    } else {
      shortTitle = queued ? `• ${queued}` : '';
      status = queued ? `${queued} queued · full capacity` : 'idle · full capacity';
    }
    if (!st.autoRun) status = 'auto-run off · ' + status;

    try {
      mb.tray.setToolTip('Lea — ' + status);
      if (IS_MAC) mb.tray.setTitle(shortTitle ? ' ' + shortTitle : '');
    } catch {}
  };
  tick();
  titleTimer = setInterval(tick, 1000);
}

// Persist chat image attachments into the app data dir so they survive even if
// the user moves/deletes the original, and so the runner has a stable path to
// hand Claude. Accepts either picked file paths or pasted data: URLs; returns
// [{ path, name }] for the ones successfully saved.
function saveAttachments(config, taskId, attachments) {
  const fs = require('fs');
  const path = require('path');
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const dir = path.join(config.DATA_DIR, 'attachments', String(taskId));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const MAX_BYTES = 25 * 1024 * 1024;
  const stamp = Date.now().toString(36);
  const out = [];
  attachments.slice(0, 8).forEach((a, i) => {
    try {
      const base = String((a && a.name) || `image-${i}`).replace(/[^\w.\-]+/g, '_').slice(-64) || `image-${i}`;
      const dest = path.join(dir, `${stamp}-${i}-${base}`);
      if (a && a.dataUrl) {
        const m = /^data:[^;]+;base64,(.*)$/s.exec(a.dataUrl);
        if (!m) return;
        const buf = Buffer.from(m[1], 'base64');
        if (!buf.length || buf.length > MAX_BYTES) return;
        fs.writeFileSync(dest, buf);
      } else if (a && a.path) {
        const st = fs.statSync(a.path);
        if (!st.isFile() || st.size > MAX_BYTES) return;
        fs.copyFileSync(a.path, dest);
      } else {
        return;
      }
      out.push({ path: dest, name: (a && a.name) || path.basename(dest) });
    } catch {}
  });
  return out;
}

function readLatestLog(id) {
  const fs = require('fs');
  const t = store.get(id);
  if (!t) return '(no runs yet)';
  // While running, read the live log file; otherwise the latest finished run's.
  let file = null;
  if (t.status === 'running' && t.currentLogFile) file = t.currentLogFile;
  else if (t.runs && t.runs.length) file = t.runs[t.runs.length - 1].logFile;
  if (!file) return '(no runs yet)';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '(log unavailable)';
  }
}

function wireIpc(config) {
  const providers = require('./providers');
  // Metadata + live install/auth status for each agent, for onboarding + settings.
  ipcMain.handle('providers:info', () => ({
    active: config.get('provider') || providers.DEFAULT_ID,
    list: providers.list().map((p) => ({
      id: p.id,
      label: p.label,
      blurb: p.blurb,
      models: p.models,
      defaultModel: p.defaultModel,
      modelKey: p.modelKey,
      awayModelKey: p.awayModelKey,
      authModes: p.authModes,
      authModeKey: p.authModeKey,
      installed: config.agentBinInstalled(p.id),
      authMode: config.get(p.authModeKey) || (p.authModes[0] && p.authModes[0].value),
      authStatus: p.authStatus(config),
    })),
  }));

  ipcMain.handle('usage:get', () => usage.snapshot);
  ipcMain.handle('runner:state', () => runner.state());
  ipcMain.handle('tasks:list', () => store.list());
  ipcMain.handle('tasks:add', (_e, t) => {
    t = t || {};
    const id = require('./store').uid();
    const attachments = saveAttachments(config, id, t.attachments);
    return store.add({ ...t, id, attachments });
  });
  ipcMain.handle('tasks:update', (_e, id, patch) => store.update(id, patch || {}));
  ipcMain.handle('tasks:remove', (_e, id) => {
    store.remove(id);
    return true;
  });
  ipcMain.handle('tasks:reorder', (_e, id, dir) => {
    store.reorder(id, dir);
    return true;
  });
  ipcMain.handle('tasks:requeue', (_e, id) => store.update(id, { status: 'queued', attempts: 0, lastError: null }));
  ipcMain.handle('tasks:clearDone', () => {
    store.clearDone();
    return true;
  });
  ipcMain.handle('tasks:runNow', async (_e, id) => runner.runNow(id));
  ipcMain.handle('tasks:reply', (_e, id, text, attachments) => {
    const saved = saveAttachments(config, id, attachments);
    const r = store.reply(id, text, saved);
    if (r.ok) runner.tick(); // pick up the reply promptly
    return r;
  });
  ipcMain.handle('dialog:pickImages', async () => {
    const r = await dialog.showOpenDialog(mb.window, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'heic', 'heif', 'svg'] }],
    });
    if (r.canceled) return [];
    return r.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
  });
  ipcMain.handle('logs:get', (_e, id) => readLatestLog(id));
  ipcMain.handle('settings:get', () => config.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const s = config.setSettings(patch || {});
    updatePower(config);
    send('runner', runner.state());
    return s;
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mb.window, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('app:openDataDir', () => {
    shell.openPath(config.DATA_DIR);
    return true;
  });
  ipcMain.handle('app:openPath', (_e, p) => {
    if (p) shell.openPath(p);
    return true;
  });
  ipcMain.handle('app:quit', () => app.quit());
}
