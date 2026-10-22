'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pages, target } = require('./management-policy');
const { install } = require('./management');
test('fixed native routes, notifications guidance only, no foreign or credential origin', () => {
  for (const page of pages.filter(page => page.path)) assert.equal(new URL(target(page.id, 'https://ha.test/home', 'https://ha.test/lovelace').url).origin, 'https://ha.test');
  assert.equal(target('notifications').url, null);
  for (const args of [['bogus'], ['devices', 'file:///x', 'file:///x'], ['devices', 'https://user:secret@ha.test', 'https://ha.test'], ['devices', 'https://ha.test', 'https://foreign.test']]) assert.throws(() => target(...args));
});
function fixture() {
  const handlers = new Map(), ipcMain = new EventEmitter(); ipcMain.handle = (name, fn) => handlers.set(name, fn); ipcMain.removeHandler = name => handlers.delete(name);
  let menu = null; class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); } static getApplicationMenu() { return menu; } static setApplicationMenu(value) { menu = value; } }
  const wc = new EventEmitter(); let url = 'https://ha.test/home', calls = 0;
  Object.assign(wc, { isDestroyed: () => false, getURL: () => url, loadURL: async value => { calls++; url = value; wc.emit('did-navigate', {}, value, 200); }, executeJavaScript: async () => 'route-loaded' });
  const w = { viewActive: 1, views: [null, { webContents: wc }], viewUrls: [null, 'https://ha.test/home'] };
  let visible = true;
  const controller = install({ electron: { ipcMain, Menu, MenuItem: class { constructor(value) { Object.assign(this, value); } } }, getWebview: () => w, dashboardVisible: () => visible });
  return { controller, handlers, wc, w, calls: () => calls, hide: () => { visible = false; } };
}
test('visible active session only; honest per-page state; clean listeners and unknown IPC rejection', async () => {
  const f = fixture();
  try {
    await f.controller.open('devices'); assert.equal(f.controller.snapshot().state, 'route-loaded');
    assert.throws(() => f.handlers.get('ha.view:management:get')({ sender: f.wc }), /Untrusted/);
    await f.controller.open('notifications'); assert.equal(f.controller.snapshot().state, 'guidance'); assert.equal(f.calls(), 1); assert.equal(f.wc.listenerCount('did-navigate'), 0);
    await f.controller.open('scenes'); f.wc.emit('did-navigate', {}, 'https://ha.test/config/scene/dashboard', 403); assert.equal(f.controller.snapshot().state, 'denied');
    await f.controller.open('entities'); f.wc.emit('did-navigate', {}, 'https://ha.test/auth/authorize', 200); assert.equal(f.controller.snapshot().state, 'login');
    f.hide(); const before = f.calls(); await f.controller.open('automations'); assert.equal(f.controller.snapshot().state, 'hidden'); assert.equal(f.calls(), before);
  } finally { f.controller.dispose(); }
  for (const name of ['did-navigate','will-redirect','did-finish-load','destroyed']) assert.equal(f.wc.listenerCount(name), 0);
  assert.equal(f.handlers.size, 0);
});
test('completed navigation releases initial guards; away route removes remaining listeners', async () => {
  const f = fixture();
  try {
    await f.controller.open('devices');
    assert.equal(f.wc.listenerCount('will-navigate'), 0); assert.equal(f.wc.listenerCount('will-redirect'), 0);
    f.wc.emit('did-navigate', {}, 'https://foreign.test/user-selected', 200);
    assert.equal(f.controller.snapshot().state, 'away'); assert.equal(f.wc.listenerCount('did-navigate'), 0);
  } finally { f.controller.dispose(); }
});
test('hung observation is bounded; late result discarded and reads do not accumulate', async () => {
  const f = fixture(); let resolve, reads = 0;
  f.wc.executeJavaScript = () => { reads++; return new Promise(done => { resolve = done; }); };
  try {
    await f.controller.open('devices');
    assert.equal(f.controller.snapshot().state, 'unavailable'); assert.equal(reads, 1);
    await f.controller.open('entities'); assert.equal(reads, 1);
    resolve('page-present'); await new Promise(done => setImmediate(done));
    assert.notEqual(f.controller.snapshot().state, 'page-present');
    assert.equal(f.wc.listenerCount('will-redirect'), 0);
  } finally { f.controller.dispose(); }
});
test('activity/history native foundations stay partial, session-bound and lifecycle-safe', async () => {
  const f = fixture();
  try {
    for (const [id, route, tag] of [['activity', '/logbook', 'ha-panel-logbook'], ['history', '/history', 'ha-panel-history']]) {
      const page = pages.find(p => p.id === id);
      assert.equal(page.path, route); assert.equal(page.tag, tag);
      if (id === 'history') assert.match(page.guidance, /Partial/);
      if (id === 'activity') assert.match(page.guidance, /bounded summary of actual HA logbook records/);
      assert.match(page.guidance, /recorder/); assert.match(page.guidance, /permissions/);
      await f.controller.open(id); assert.equal(f.wc.getURL(), `https://ha.test${route}`);
      assert.equal(f.controller.snapshot().state, 'route-loaded'); // absent/unsupported element is not success
      f.wc.emit('did-navigate', {}, `https://ha.test${route}`, 403); assert.equal(f.controller.snapshot().state, 'denied');
    }
    const before = f.calls(); f.hide(); await f.controller.open('activity');
    assert.equal(f.calls(), before); assert.equal(f.controller.snapshot().state, 'hidden');
  } finally { f.controller.dispose(); }
  assert.equal(f.wc.listenerCount('did-navigate'), 0);
});
test('generic guidance label and document scrolling do not assume Notifications', () => {
  const fs = require('node:fs'), path = require('node:path');
  const renderer = fs.readFileSync(path.join(__dirname, 'management-renderer.js'), 'utf8');
  assert.ok(renderer.includes('`${page.label} guidance`')); assert.ok(!renderer.includes("'Notifications guidance'"));
  const html = fs.readFileSync(path.join(__dirname, 'management.html'), 'utf8');
  assert.doesNotMatch(html, /overflow\s*:\s*hidden|position\s*:\s*fixed/);
});

test('native alert review guidance distinguishes notifications from entity states without invented routes', () => {
  const notification = pages.find(page => page.id === 'notifications');
  assert.equal(notification.path, null);
  for (const phrase of ['Close this launcher', 'Persistent notifications', 'not a complete security/sensor/alarm feed', 'may notify elsewhere', 'Entities', 'binary_sensor', 'alarm_control_panel', 'History', 'Activity', 'empty results do not prove', 'do not dismiss', 'acknowledge alerts', 'arm/disarm', 'does not detect unsupported alarms']) assert.ok(notification.guidance.includes(phrase), phrase);
});
