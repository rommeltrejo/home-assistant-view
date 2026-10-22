const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('layoutEditor', {
  get: () => ipcRenderer.invoke('ha.view:layout:get'),
  save: config => ipcRenderer.invoke('ha.view:layout:save', config),
  cancel: () => ipcRenderer.invoke('ha.view:layout:cancel'),
});
