/** HA.View isolated real Electron DOM/IPC test; no hardware, integration or real profile. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const profile = process.env.HA_VIEW_RECOVERY_PROFILE;
  assert.ok(profile && path.dirname(profile) === fs.realpathSync(os.tmpdir()) && path.basename(profile).startsWith('ha-view-recovery-'));
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  if (process.env.HA_VIEW_RECOVERY_PRODUCTION === '1') {
    fs.writeFileSync(path.join(profile, 'Arguments.json'), JSON.stringify({ web_url: 'invalid' }));
    app.getAppPath = () => path.resolve(__dirname, '..');
    const forbidden = () => { throw new Error('Forbidden production initialization'); };
    for (const name of ['../js/hardware', '../js/integration', '../js/webview']) {
      const id = require.resolve(name);
      require.cache[id] = { id, filename: id, loaded: true, exports: { init: forbidden } };
    }
    require('../index');
    app.whenReady().then(async () => {
      for (let i = 0; i < 200; i++) {
        const window = BrowserWindow.getAllWindows().find(w => w.isVisible() && w.webContents.getURL().endsWith('startup-recovery.html'));
        if (window && await window.webContents.executeJavaScript('document.querySelector("#status").textContent.includes("valid HTTP")')) {
          console.log('PASS production index invalid saved URL routed to recovery; requesting actual Close42');
          void window.webContents.executeJavaScript('window.startupRecovery.action("close")');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      app.exit(3);
    }).catch(error => { console.error(error); app.exit(1); });
  } else {
  app.whenReady().then(async () => {
    const recovery = require('./startup-recovery');
    const file = path.join(profile, 'Arguments.json');
    fs.writeFileSync(file, JSON.stringify({ web_url: 'invalid', mqtt_password: 'ciphertext-sentinel', future: true }));
    const sentinel = fs.readFileSync(file, 'utf8');
    let online = false;
    const pending = recovery.ensureReachable({ web_url: 'invalid' }, file, require('electron'), {
      check: async () => ({ ok: online, message: 'Fixture offline' }), intervalMs: 60,
    });
    let window;
    for (let i = 0; i < 100; i++) {
      window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('startup-recovery.html'));
      if (window && await window.webContents.executeJavaScript('document.querySelector("#status").textContent === "Fixture offline"')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(window);
    const js = code => window.webContents.executeJavaScript(code);
    window.setSize(360, 360);
    assert.equal(await js('Array.from(document.querySelectorAll("button")).filter(b=>!b.hidden).every(b=>{const r=b.getBoundingClientRect();return r.right<=innerWidth && r.bottom<=innerHeight})'), true);
    assert.equal(await js('typeof require'), 'undefined');
    assert.equal(await js('document.querySelector("#status").textContent'), 'Fixture offline');
    await js('window.startupRecovery.action("wait")');
    assert.equal(await js('document.querySelector("#cancel").hidden'), false);
    await js('window.startupRecovery.action("cancel")');
    assert.equal(await js('document.querySelector("#cancel").hidden'), true);
    assert.match(await js('document.querySelector("#status").textContent'), /cancelled/);
    assert.equal(await js('window.startupRecovery.action("unknown").then(()=>false,()=>true)'), true);
    const login = js('window.startupRecovery.action("login")');
    let settingsWindow;
    for (let i = 0; i < 100; i++) {
      settingsWindow = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('initial-settings.html'));
      if (settingsWindow && settingsWindow.isVisible()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(settingsWindow);
    settingsWindow.close();
    await login;
    assert.equal(window.isDestroyed(), false);
    assert.equal(await js('document.querySelector("#status").textContent'), 'Fixture offline');
    assert.equal(fs.readFileSync(file, 'utf8'), sentinel);
    console.log('PASS settings cancel retains recovery and profile');
    const foreign = new BrowserWindow({ show: false });
    await foreign.loadURL('data:text/html,untrusted');
    // Exercise the actual registered handler with a foreign main frame; no IPC bypass is exposed to UI.
    const handler = ipcMain._invokeHandlers.get('ha.view:startup-recovery:action');
    await assert.rejects(handler({ sender: foreign.webContents, senderFrame: foreign.webContents.mainFrame }, 'close'), /Untrusted/);
    foreign.close();
    console.log('checkpoint foreign rejection');
    online = true;
    await js('window.startupRecovery.action("wait")');
    assert.deepEqual(await pending, { web_url: 'invalid' });
    assert.equal(fs.readFileSync(file, 'utf8'), sentinel);
    assert.equal(ipcMain._invokeHandlers.has('ha.view:startup-recovery:action'), false);
    console.log('checkpoint recovered');
    recovery.dashboardReady();
    const closePending = recovery.ensureReachable({ web_url: 'invalid' }, file, require('electron'), { check: async () => ({ ok: false, message: 'offline' }) });
    app.on('will-quit', event => {
      event.preventDefault();
      assert.equal(process.exitCode, 42);
      console.log('PASS actual Electron intentional exit42');
      app.exit(require('./quit-status').quitStatus(process.exitCode));
    });
    let closeWindow;
    for (let i = 0; i < 100; i++) {
      closeWindow = BrowserWindow.getAllWindows().find(w => w.id !== window.id && w.webContents.getURL().endsWith('startup-recovery.html'));
      if (closeWindow && await closeWindow.webContents.executeJavaScript('typeof window.startupRecovery !== "undefined"')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    console.log('checkpoint close window');
    console.log('PASS real Electron recovery DOM, isolated preload, wait/cancel/recovery, sender rejection and cleanup');
    void closeWindow.webContents.executeJavaScript('window.startupRecovery.action("close")');
    assert.equal(await closePending, null);
    assert.equal(process.exitCode, 42);
    assert.equal(ipcMain._invokeHandlers.has('ha.view:startup-recovery:action'), false);
    console.log('PASS real Electron recovery DOM, isolated preload, wait/cancel/recovery, sender rejection, cleanup and Close42');
    // Actual process exit is asserted by the parent; production will-quit normalization is used above.
  }).catch(error => { console.error(error); app.exit(1); });
  }
  setTimeout(() => app.exit(3), 20000).unref();
} else {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ha-view-recovery-'));
  try {
    const env = { ...process.env, HA_VIEW_RECOVERY_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    assert.equal(result.status, 42);
    const production = require('node:child_process').spawnSync(require('electron'), [__filename], {
      env: { ...env, HA_VIEW_RECOVERY_PRODUCTION: '1' }, encoding: 'utf8', timeout: 30000,
    });
    process.stdout.write(production.stdout || ''); process.stderr.write(production.stderr || '');
    assert.equal(production.status, 42, 'production index.js must actually exit42');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
