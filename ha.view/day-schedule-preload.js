const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('daySchedule', {
  calendars: () => ipcRenderer.invoke('ha.view:day-schedule:calendars'),
  close: () => ipcRenderer.invoke('ha.view:day-schedule:close'),
  get: () => ipcRenderer.invoke('ha.view:day-schedule:get'),
  save: config => ipcRenderer.invoke('ha.view:day-schedule:save', config),
});
