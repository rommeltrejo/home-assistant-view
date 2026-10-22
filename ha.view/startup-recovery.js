/** HA.View local startup recovery window; no dashboard sessions or credentials are touched. */
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createController } = require('./startup-recovery-controller');
let retainedWindow;
function dashboardReady() {
  const window = retainedWindow;
  retainedWindow = undefined;
  if (window && !window.isDestroyed()) window.close();
}
function ensureReachable(args, file, electron = require('electron'), options = {}) {
  const { BrowserWindow, ipcMain, app } = electron;
  return new Promise(resolve => {
    let settled = false, editing = false, state;
    const window = new BrowserWindow({ width: 570, height: 420, minWidth: 360, minHeight: 360,
      title: 'HA View startup', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'startup-recovery-preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
    const wc = window.webContents;
    const expected = pathToFileURL(path.join(__dirname, 'startup-recovery.html')).href;
    const trusted = event => !wc.isDestroyed() && event.sender === wc && event.senderFrame === wc.mainFrame &&
      event.senderFrame.url === expected && wc.getURL() === expected;
    const channels = ['ha.view:startup-recovery:state', 'ha.view:startup-recovery:action'];
    const guard = event => event.preventDefault();
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const controller = createController({ ...options, publish(value) {
      state = value;
      if (!wc.isDestroyed() && wc.getURL() === expected) wc.send('ha.view:startup-recovery:update', state);
    }, ready(value) {
      if (settled) return;
      settled = true;
      cleanup();
      window.hide();
      retainedWindow = window; // Avoid last-window quit before the dashboard is constructed.
      resolve(value);
    } });
    const cleanup = () => {
      controller.dispose();
      channels.forEach(channel => ipcMain.removeHandler(channel));
      app.removeListener('before-quit', onQuit);
    };
    const close = () => {
      if (settled) return;
      settled = true;
      cleanup();
      process.exitCode = 42;
      resolve(null);
      app.quit();
    };
    const onQuit = () => { if (!settled) { settled = true; cleanup(); resolve(null); } };
    app.on('before-quit', onQuit);
    window.once('closed', close);
    ipcMain.handle(channels[0], event => {
      if (!trusted(event)) throw new Error('Untrusted recovery sender');
      return state;
    });
    ipcMain.handle(channels[1], async (event, action) => {
      if (!trusted(event)) throw new Error('Untrusted recovery sender');
      if (!['wait', 'cancel', 'login', 'close'].includes(action)) throw new Error('Invalid recovery action');
      if (settled) return;
      if (action === 'close') return close();
      if (editing) return;
      if (action === 'cancel') return controller.cancelWait();
      if (action === 'wait') { void controller.run(args, true); return; }
      controller.cancel();
      editing = true;
      try {
        const settings = require('./initial-settings');
        const saved = await require('./installer-startup').openInitialSettings(file, settings.inspect(file), electron);
        if (settled) return;
        if (saved) args = { ...args, web_url: saved.web_url };
        editing = false;
        await controller.run(args);
      } catch {
        editing = false;
        controller.cancelWait();
      }
    });
    window.loadFile(path.join(__dirname, 'startup-recovery.html')).then(() => {
      if (settled) return;
      window.show();
      void controller.run(args);
    }, () => {
      electron.dialog.showErrorBox('HA View startup', 'Unable to open the local startup recovery screen.');
      close();
    });
  });
}
module.exports = { ensureReachable, dashboardReady };
