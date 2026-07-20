'use strict';
/*
 * appshell.js — the window + tray surface, per platform.
 *
 * macOS  → a menu-bar app (the `menubar` package): a frameless popover anchored
 *          to the tray, no Dock icon. This is the native idiom on the Mac.
 * Windows / Linux → a REAL application window: a normal, resizable BrowserWindow
 *          with a taskbar entry, plus a tray icon for quick access and the live
 *          countdown. Closing the window hides it to the tray (the queue keeps
 *          running); Quit (tray menu or in-app) actually exits.
 *
 * Both variants expose the same small surface the rest of the app relies on:
 *   .window        the BrowserWindow (available after 'ready')
 *   .tray          the Tray
 *   .showWindow()  bring the UI to the front
 *   .on('ready')   fired once the window + tray exist
 */
const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const { EventEmitter } = require('events');

const IS_MAC = process.platform === 'darwin';

// macOS: hand back the menubar instance directly — it already matches our surface.
function createMac(opts) {
  const { menubar } = require('menubar');
  const mb = menubar({
    index: opts.index,
    icon: opts.icon,
    tooltip: opts.tooltip || 'Lea',
    showDockIcon: false,
    browserWindow: opts.browserWindow,
  });
  return mb;
}

// Windows/Linux: a first-class window + a tray icon.
class WindowedShell extends EventEmitter {
  constructor(opts) {
    super();
    this.window = null;
    this.tray = null;
    this._opts = opts;
    // Defer a tick so callers can attach their 'ready' listener first.
    setImmediate(() => this._build());
  }

  _build() {
    const o = this._opts;
    const bw = o.browserWindow || {};
    this.window = new BrowserWindow({
      width: bw.width || 440,
      height: bw.height || 700,
      minWidth: 380,
      minHeight: 560,
      show: false,
      title: 'Lea',
      autoHideMenuBar: true, // no clunky File/Edit menu bar on Windows/Linux
      icon: o.windowIcon || o.icon,
      backgroundColor: '#0e1116',
      webPreferences: bw.webPreferences || {},
    });
    this.window.removeMenu(); // real app, not a browser — drop the default menu
    this.window.loadURL(o.index);
    this.window.once('ready-to-show', () => {
      this.window.show();
      this.window.focus();
    });

    // Close = hide to tray (keep the queue running); Quit really exits.
    this.window.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        this.window.hide();
        return false;
      }
    });

    this._buildTray();
    this.emit('ready');
  }

  _buildTray() {
    let img;
    try {
      img = nativeImage.createFromPath(this._opts.icon);
    } catch {
      img = nativeImage.createEmpty();
    }
    this.tray = new Tray(img);
    this.tray.setToolTip(this._opts.tooltip || 'Lea');
    const menu = Menu.buildFromTemplate([
      { label: 'Open Lea', click: () => this.showWindow() },
      { type: 'separator' },
      {
        label: 'Quit Lea',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
    // Left-click / double-click the tray icon → focus the app.
    this.tray.on('click', () => this.showWindow());
    this.tray.on('double-click', () => this.showWindow());
  }

  showWindow() {
    if (!this.window) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }
}

function create(opts) {
  return IS_MAC ? createMac(opts) : new WindowedShell(opts);
}

module.exports = { create, IS_MAC };
