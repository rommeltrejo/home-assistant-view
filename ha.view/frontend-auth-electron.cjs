/** HA.View real Electron login admission validation, isolated from real profiles. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-auth-electron-'));
  try {
    const env = { ...process.env, HA_VIEW_AUTH_PROFILE: dir }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', timeout: 30000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.HA_VIEW_AUTH_PROFILE);
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
    const { FrontendAuth } = require('./frontend-auth');
    let gate;
    const settle = async expected => {
      for (let i = 0; i < 60; i++) {
        await gate.refresh();
        if (gate.ready === expected) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(gate.ready, expected);
    };
    try {
      await window.loadURL('data:text/html,<h1>Home Assistant login</h1>');
      gate = new FrontendAuth({ contents: () => window.webContents, interval: 100 });
      await settle(false);
      await window.webContents.executeJavaScript(`document.body.append(document.createElement('home-assistant'));document.querySelector('home-assistant').hass={user:{id:'fixture-user'},connection:{connected:true}}`);
      await settle(true);
      await window.webContents.executeJavaScript(`document.querySelector('home-assistant').hass.user=null`);
      await settle(false);
      await window.webContents.executeJavaScript(`document.querySelector('home-assistant').hass.user={id:'fixture-user'}`);
      await settle(true);
      await window.loadURL('data:text/html,<h1>Login again</h1>');
      assert.equal(gate.ready, false);
      await settle(false);
      gate.stop(); assert.equal(gate.ready, false);
      console.log('PASS actual Electron login denial, authenticated admission, logout, re-login, navigation and cleanup');
      app.exit(0);
    } finally { gate?.stop(); window.destroy(); }
  }).catch(error => { console.error(error); app.exit(1); });
}
