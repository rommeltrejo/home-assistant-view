/** HA.View lightweight first-launch native settings, isolated from dashboard sessions. */
'use strict';
const path = require('node:path');
const settings = require('./initial-settings');
let pendingSettings;
function dashboardReady(window, electron = require('electron'), state = global.APP) {
  window.once('closed', () => {
    if (state.exiting) return;
    state.exiting = true;
    electron.app.quit();
  });
  const settingsWindow = pendingSettings;
  pendingSettings = undefined;
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
}
async function openInitialSettings(file, prior, electron = require('electron')) {
  const { BrowserWindow, ipcMain } = electron;
  const channel = 'ha.view:initial-settings:save';
  let window;
  let completed = false;
  return new Promise(resolve => {
    window = new BrowserWindow({ width: 490, height: 325, minWidth: 410, minHeight: 285,
      title: 'HA View settings', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'initial-settings-preload.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false } });
    const wc = window.webContents;
    const expected = require('node:url').pathToFileURL(path.join(__dirname, 'initial-settings.html')).href;
    const trusted = event => !wc.isDestroyed() && event.sender === wc && event.senderFrame === wc.mainFrame &&
      event.senderFrame.url === expected && wc.getURL() === expected && !wc.isDestroyed();
    const guard = event => event.preventDefault();
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const save = (event, url) => {
      if (!trusted(event)) throw new Error('Untrusted settings sender');
      if (completed) throw new Error('Settings already saved');
      const args = settings.saveURL(file, url, prior);
      completed = true;
      // Resolve only after persisting and closing; the caller starts normal initialization.
      window.hide();
      finish(args);
      // Retain the hidden settings window until the dashboard exists, avoiding Electron's last-window quit.
      pendingSettings = window;
      return args;
    };
    ipcMain.handle(channel, save);
    const finish = result => {
      ipcMain.removeHandler(channel);
      wc.removeListener('will-navigate', guard);
      wc.removeListener('will-redirect', guard);
      resolve(result);
    };
    window.once('closed', () => finish(completed ? settings.inspect(file).value : null));
    window.loadFile(path.join(__dirname, 'initial-settings.html')).then(() => window.show(), error => {
      electron.dialog.showErrorBox('HA View settings', `Unable to open settings: ${error.message}`);
      window.close();
    });
  });
}
module.exports = { openInitialSettings, dashboardReady };
