'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('startupRecovery', {
  state: () => ipcRenderer.invoke('ha.view:startup-recovery:state'),
  action: value => ipcRenderer.invoke('ha.view:startup-recovery:action', value),
  subscribe: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ha.view:startup-recovery:update', listener);
    return () => ipcRenderer.removeListener('ha.view:startup-recovery:update', listener);
  },
});
