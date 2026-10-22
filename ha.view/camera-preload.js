'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cameraDashboard', {
  close: () => ipcRenderer.invoke('ha.view:camera:close'),
  get: () => ipcRenderer.invoke('ha.view:camera:get'),
  save: path => ipcRenderer.invoke('ha.view:camera:save', path),
  open: () => ipcRenderer.invoke('ha.view:camera:open'),
  status: callback => ipcRenderer.on('ha.view:camera:status', (_event, data) => callback(data))
});
