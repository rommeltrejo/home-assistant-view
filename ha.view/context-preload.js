const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('contextDisplay', {
  close: () => ipcRenderer.invoke('ha.view:context:close'),
  get: () => ipcRenderer.invoke('ha.view:context:get'),
  save: config => ipcRenderer.invoke('ha.view:context:save', config),
});
