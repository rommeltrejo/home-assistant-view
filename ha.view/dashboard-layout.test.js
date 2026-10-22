'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { HELP, install } = require('./dashboard-layout');
test('help is guidance only, with permission, managed-dashboard and save warnings', () => {
  assert.match(HELP.detail, /Take control/);
  assert.match(HELP.detail, /permissions/);
  assert.match(HELP.detail, /YAML/);
  assert.match(HELP.detail, /without saving/);
  assert.match(HELP.detail, /does not check your login/);
  assert.deepEqual(HELP.buttons, ['Close']);
});
test('only trusted navigation opens help; repeated clicks coalesce; dispose removes listener', async () => {
  const ipcMain = new EventEmitter();
  const sender = {};
  const w = { navigation: { webContents: sender }, window: { isDestroyed: () => false } };
  let calls = 0, close;
  const dispose = install({ ipcMain, getWebview: () => w, dialog: {
    showMessageBox: (parent, help) => { assert.equal(parent, w.window); assert.equal(help, HELP);
      calls++; return new Promise(resolve => { close = resolve; }); }
  }});
  ipcMain.emit('button-click', { sender: {} }, { id: 'dashboard-layout-help' });
  ipcMain.emit('button-click', { sender }, { id: 'home' });
  assert.equal(calls, 0);
  ipcMain.emit('button-click', { sender }, { id: 'dashboard-layout-help' });
  ipcMain.emit('button-click', { sender }, { id: 'dashboard-layout-help' });
  assert.equal(calls, 1);
  close(); await new Promise(resolve => setImmediate(resolve));
  ipcMain.emit('button-click', { sender }, { id: 'dashboard-layout-help' });
  assert.equal(calls, 2); close(); dispose();
  assert.equal(ipcMain.listenerCount('button-click'), 0);
});
test('missing or destroyed app window fails closed', () => {
  const ipcMain = new EventEmitter(); let w;
  const dispose = install({ ipcMain, getWebview: () => w, dialog: { showMessageBox: () => assert.fail() } });
  ipcMain.emit('button-click', { sender: {} }, { id: 'dashboard-layout-help' });
  w = { navigation: { webContents: {} }, window: { isDestroyed: () => true } };
  ipcMain.emit('button-click', { sender: w.navigation.webContents }, { id: 'dashboard-layout-help' });
  dispose();
});
test('production chrome exposes an accessible control and narrow init call', () => {
  const root = path.resolve(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'html/navigation.html'), 'utf8'),
    /id="dashboard-layout-help"[^>]*aria-label="Dashboard layout help"/);
  assert.match(fs.readFileSync(path.join(root, 'js/webview.js'), 'utf8'), /require\("\.\.\/ha.view\/dashboard-layout"\)\.init\(\)/);
});
