'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeManagement', {
  close: () => ipcRenderer.invoke('ha.view:management:close'),
  get: () => ipcRenderer.invoke('ha.view:management:get'),
  open: id => ipcRenderer.invoke('ha.view:management:open', id),
  activity: hours => ipcRenderer.invoke('ha.view:management:activity', hours),
  activityStatus: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('ha.view:management:activity-status', listener); return () => ipcRenderer.removeListener('ha.view:management:activity-status', listener); },
  status: callback => { const listener = (_event, data) => callback(data); ipcRenderer.on('ha.view:management:status', listener); return () => ipcRenderer.removeListener('ha.view:management:status', listener); }
});
