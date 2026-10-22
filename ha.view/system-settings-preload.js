'use strict';
const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('systemSettings',Object.freeze({get:()=>ipcRenderer.invoke('ha.view:system:get'),setBrowserIcon:value=>ipcRenderer.invoke('ha.view:system:browser-icon',value),run:id=>ipcRenderer.invoke('ha.view:system:run',id),close:()=>ipcRenderer.invoke('ha.view:system:close')}));
