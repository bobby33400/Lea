'use strict';
/* main.js — Electron entry: tray + window, IPC, keep-awake, live title. */
const { app, ipcMain, dialog, shell, nativeImage, powerSaveBlocker } = require('electron');
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
  const { ensureTrayIcon } = require('./icon');
  const { Store } = require('./store');
  const { UsageMonitor } = require('./usage');
  const { Runner } = require('./runner');
  const { menubar } = require('menubar');

  const iconPath = ensureTrayIcon(config.ASSETS_DIR);

  store = new Store();
  usage = new UsageMonitor();
  runner = new Runner({ store, usage });

  mb = menubar({
    index: 'file://' + path.join(__dirname, 'renderer', 'index.html'),
    icon: iconPath,
    tooltip: 'Lea',
    showDockIcon: false,
    browserWindow: {
      width: 404,
      height: 648,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
  });

  mb.on('ready', () => {
    try {
      const img = nativeImage.createFromPath(iconPath);
      img.setTemplateImage(true);
      mb.tray.setImage(img);
    } catch {}
    mb.tray.setToolTip('Lea');

    wireIpc(config);
    forwardEvents(config);

    usage.start();
    runner.start();
    updatePower(config);
    startTitleTimer();
  });

  app.on('before-quit', () => {
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
}

function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
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

function readLatestLog(id) {
  const fs = require('fs');
  const t = store.get(id);
  if (!t || !t.runs || t.runs.length === 0) return '(no runs yet)';
  const last = t.runs[t.runs.length - 1];
  try {
    return fs.readFileSync(last.logFile, 'utf8');
  } catch {
    return '(log unavailable)';
  }
}

function wireIpc(config) {
  ipcMain.handle('usage:get', () => usage.snapshot);
  ipcMain.handle('runner:state', () => runner.state());
  ipcMain.handle('tasks:list', () => store.list());
  ipcMain.handle('tasks:add', (_e, t) => store.add(t || {}));
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
  ipcMain.handle('app:quit', () => app.quit());
}
