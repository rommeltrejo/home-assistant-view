'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { dashboardReady, openInitialSettings } = require('./installer-startup');
test('native dashboard close marks teardown before quit and quits exactly once', () => {
  const root = new EventEmitter(); const state = { exiting: false }; let quits = 0;
  dashboardReady(root, { app: { quit() { assert.equal(state.exiting, true); quits++; } } }, state);
  root.emit('closed'); root.emit('closed'); assert.equal(quits, 1);
});
test('app quit already in progress does not recurse', () => {
  const root = new EventEmitter(); let quits = 0;
  dashboardReady(root, { app: { quit() { quits++; } } }, { exiting: true });
  root.emit('closed'); assert.equal(quits, 0);
});
test('settings handoff is explicit for BaseWindow, not browser-window-created', () => {
  const source = require('node:fs').readFileSync(require.resolve('./installer-startup'), 'utf8');
  assert.ok(!source.includes("app.once('browser-window-created'"));
  assert.ok(source.includes('pendingSettings = window;'));
  assert.ok(source.includes('settingsWindow.close()'));
  const webview = require('node:fs').readFileSync(require('node:path').join(__dirname, '../js/webview.js'), 'utf8');
  assert.ok(webview.includes('.dashboardReady(WEBVIEW.window)'));
});
test('saved first-run settings stays alive until BaseWindow handoff, then closes', async () => {
  let form, save, closed = 0;
  const wc = new EventEmitter(); wc.isDestroyed = () => false;
  wc.mainFrame = { url: require('node:url').pathToFileURL(require('node:path').join(__dirname, 'initial-settings.html')).href };
  wc.getURL = () => wc.mainFrame.url; wc.setWindowOpenHandler = () => {};
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = wc; form = this; }
    hide() {} show() {} loadFile() { return Promise.resolve(); }
    isDestroyed() { return closed !== 0; }
    close() { closed++; this.emit('closed'); }
  }
  const electron = { BrowserWindow: Window, ipcMain: { handle(name, fn) { save = fn; }, removeHandler() {} }, app: { quit() {} } };
  const fs = require('node:fs'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ha-close-test-'));
  try {
    const pending = openInitialSettings(path.join(dir, 'Arguments.json'), require('./initial-settings').inspect(path.join(dir, 'Arguments.json')), electron);
    await Promise.resolve();
    save({ sender: wc, senderFrame: wc.mainFrame }, 'http://ha.example.test:8123/');
    assert.ok(await pending); assert.equal(closed, 0);
    dashboardReady(new EventEmitter(), electron, { exiting: false });
    assert.equal(closed, 1);
    dashboardReady(new EventEmitter(), electron, { exiting: false });
    assert.equal(closed, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
