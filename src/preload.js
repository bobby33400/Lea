'use strict';
/* preload.js — safe bridge between the renderer UI and the main process. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  usageGet: () => ipcRenderer.invoke('usage:get'),
  runnerState: () => ipcRenderer.invoke('runner:state'),
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  tasksAdd: (t) => ipcRenderer.invoke('tasks:add', t),
  tasksUpdate: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  tasksRemove: (id) => ipcRenderer.invoke('tasks:remove', id),
  tasksReorder: (id, dir) => ipcRenderer.invoke('tasks:reorder', id, dir),
  tasksRequeue: (id) => ipcRenderer.invoke('tasks:requeue', id),
  tasksClearDone: () => ipcRenderer.invoke('tasks:clearDone'),
  tasksRunNow: (id) => ipcRenderer.invoke('tasks:runNow', id),
  logsGet: (id) => ipcRenderer.invoke('logs:get', id),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  quit: () => ipcRenderer.invoke('app:quit'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, msg) => cb(msg)),
});
