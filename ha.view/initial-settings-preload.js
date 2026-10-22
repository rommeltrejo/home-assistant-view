'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('initialSettings', {
  save: url => ipcRenderer.invoke('ha.view:initial-settings:save', url)
});
