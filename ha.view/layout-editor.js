/** Native isolated overlay. Draft exists only in its renderer until authenticated Save. */
'use strict';
const path = require('node:path');
const { WebContentsView, Menu, MenuItem, ipcMain } = require('electron');
const store = require('./layout-store');
function install({ file, parent, interaction, allowed = () => true, changed = () => {} }) {
  let view, shown = false, disposed = false;
  const trusted = event => {
    if (!shown || disposed || !view || view.webContents.isDestroyed() || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame) throw Error('Untrusted layout editor sender');
  };
  const resize = () => { if (view && !disposed) { const { width, height } = parent.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }); } };
  const close = () => { if (!shown) return; shown = false; const old = view; view = null; if (!parent.isDestroyed()) parent.contentView.removeChildView(old); old.webContents.removeAllListeners(); if (!old.webContents.isDestroyed()) old.webContents.close(); interaction(false); };
  ipcMain.handle('ha.view:layout:get', event => { trusted(event); return store.read(file); });
  ipcMain.handle('ha.view:layout:save', (event, config) => { trusted(event); const saved = store.write(file, config); changed(saved); close(); return saved; });
  ipcMain.handle('ha.view:layout:cancel', event => { trusted(event); close(); });
  const open = () => {
    if (disposed || !allowed()) return;
    if (shown) { view.webContents.focus(); return; }
    if (!view) {
      view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'layout-editor-preload.js') } });
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', e => e.preventDefault()); view.webContents.on('will-frame-navigate', e => e.preventDefault());
      view.webContents.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); close(); } });
      view.setBackgroundColor('#00000000');
      parent.contentView.addChildView(view);
    }
    shown = true; interaction(true); resize(); view.setVisible(true); view.webContents.focus();
    const created = view;
    created.webContents.loadFile(path.join(__dirname, 'layout-editor.html')).catch(error => { if (view === created) { console.error('HA.View layout editor:', error.message); close(); } });
  };
  const removeMenu = require('./menu').register(require('electron'), 'layout', [{ order: 30, label: 'Edit split layout…', accelerator: 'CmdOrCtrl+Shift+L', click: open }]);
  parent.on('resize', resize);
  const dispose = () => {
    if (disposed) return; close(); disposed = true; parent.removeListener('resize', resize); parent.removeListener('closed', dispose);
    if (view) { if (!parent.isDestroyed()) parent.contentView.removeChildView(view); if (!view.webContents.isDestroyed()) view.webContents.close(); }
    for (const name of ['get', 'save', 'cancel']) ipcMain.removeHandler(`ha.view:layout:${name}`);
    removeMenu();
  };
  parent.on('closed', dispose);
  return Object.assign(dispose, { open, close });
}
module.exports = { install };
