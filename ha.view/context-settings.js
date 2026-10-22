/** HA.View local, read-only state rule settings. */
'use strict';
const path = require('node:path');
const electron = require('electron');
const { BrowserWindow, Menu, ipcMain } = electron;
const store = require('./context-policy');
function install({ file, policy, parent, allowed = () => true, interaction, changed }) {
  if (!BrowserWindow || !Menu || !ipcMain) return () => {};
  let window, disposed = false, generation = 0;
  const trusted = event => {
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted settings sender');
  };
  const close = () => window?.close();
  ipcMain.handle('ha.view:context:get', event => { trusted(event); return { ...store.read(file), file }; });
  ipcMain.handle('ha.view:context:save', (event, config) => {
    trusted(event);
    const result = store.write(file, config); policy.update(result); changed(); return result;
  });
  ipcMain.handle('ha.view:context:close', event => { trusted(event); close(); });
  const open = () => {
    if (disposed || !allowed()) return;
    if (window && !window.isDestroyed()) { window.focus(); return; }
    interaction(true);
    const entry = ++generation;
    const created = new BrowserWindow({ title: 'HA View — State-based face rules', width: 680, height: 640, parent, modal: true, fullscreenable: false, minimizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'context-preload.js') } });
    window = created;
    created.setMenuBarVisibility?.(false);
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-frame-navigate']) created.webContents.on(name, e => e.preventDefault());
    created.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); close(); } });
    created.on('closed', () => { if (window === created) { window = null; generation++; interaction(false); } });
    created.loadFile(path.join(__dirname, 'context.html')).catch(error => {
      if (!disposed && entry === generation && window === created) { console.error('HA.View state rules load failed:', error.message); close(); }
    });
  };
  parent?.on('closed', close);
  const removeMenu = require('./menu').register(electron, 'context', [{ advanced: true, order: 10,
    label: 'State-based face rules…', accelerator: 'CmdOrCtrl+Shift+C', click: open }]);
  const dispose = () => {
    if (disposed) return; disposed = true; close(); parent?.removeListener('closed', close);
    for (const name of ['get', 'save', 'close']) ipcMain.removeHandler(`ha.view:context:${name}`);
    removeMenu();
  };
  return Object.assign(dispose, { open, close });
}
module.exports = { install };
