'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browserUI', Object.freeze({
  command: (action, value) => ipcRenderer.invoke('ha.view:browser', action, value),
  onState: callback => { ipcRenderer.on('ha.view:browser-state', (_event, state) => callback(state)); },
}));
