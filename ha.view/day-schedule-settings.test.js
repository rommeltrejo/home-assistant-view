'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const handlers = new Map(), views = [];
let currentMenu;
class Menu { constructor() { this.items = []; } append(item) { this.items.push(item); } static getApplicationMenu() { return currentMenu; } static setApplicationMenu(menu) { currentMenu = menu; } }
class MenuItem { constructor(options) { Object.assign(this, options); } }
let finishLoad, rejectLoad;
class WebContentsView {
  constructor(options) {
    this.options = options; views.push(this); this.webContents = new EventEmitter();
    Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => !!this.destroyed, close: () => { this.destroyed = true; }, focus: () => { this.focused = true; }, setWindowOpenHandler: handler => { this.windowOpen = handler; }, loadFile: file => { this.file = file; this.loads = (this.loads || 0) + 1; return new Promise((resolve, reject) => { finishLoad = resolve; rejectLoad = reject; }); } });
  }
  setVisible(value) { this.visible = value; } setBounds(bounds) { this.bounds = bounds; } setBackgroundColor(color) { this.background = color; }
}
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { WebContentsView, BrowserWindow: class { constructor() { throw Error('NO additional BrowserWindow'); } }, Menu, MenuItem, ipcMain: { handle: (key, handler) => handlers.set(key, handler), removeHandler: key => handlers.delete(key) } } };
const { install } = require('./day-schedule-settings');
test('in-app isolated editor: parent resize, sender/frame gates, Escape/back, OFF load race and cleanup', async () => {
  currentMenu = new Menu(); const original = new MenuItem({ label: 'Original' }); currentMenu.append(original);
  const parent = new EventEmitter(); let bounds = { width: 640, height: 560 }; const children = [];
  parent.isDestroyed = () => false;
  parent.getContentBounds = () => bounds;
  parent.contentView = { addChildView: view => children.push(view), removeChildView: view => children.splice(children.indexOf(view), 1) };
  const interactions = [], returns = []; let allowed = true;
  const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: { update() {} }, interaction: open => interactions.push(open), closed: (...args) => returns.push(args), allowed: () => allowed });
  dispose.open('chooser'); const editor = views.at(-1);
  assert.equal(editor.background, '#00000000', 'transparent view reveals dimmed underlying chooser');
  assert.deepEqual(editor.bounds, { x: 0, y: 0, ...bounds }, 'full-size input-intercepting backdrop');
  assert.deepEqual(editor.options.webPreferences.sandbox, true);
  assert.equal(editor.options.webPreferences.nodeIntegration, false);
  assert.equal(editor.options.webPreferences.contextIsolation, true);
  assert.deepEqual(editor.windowOpen(), { action: 'deny' });
  for (const event of ['will-navigate', 'will-frame-navigate']) { let prevented = false; editor.webContents.emit(event, { preventDefault() { prevented = true; } }); assert.ok(prevented); }
  dispose.open(); assert.equal(views.length, 1); assert.deepEqual(interactions, [true]);
  bounds = { width: 320, height: 600 }; parent.emit('resize'); assert.deepEqual(editor.bounds, { x: 0, y: 0, ...bounds });
  for (const name of ['get', 'save', 'close']) {
    const handler = handlers.get(`ha.view:day-schedule:${name}`);
    assert.throws(() => handler({ sender: {} }, {}), /Untrusted/);
    assert.throws(() => handler({ sender: editor.webContents, senderFrame: {} }, {}), /Untrusted/);
  }
  const response = handlers.get('ha.view:day-schedule:get')({ sender: editor.webContents, senderFrame: editor.webContents.mainFrame });
  const expectedFaces = require('./face-registry').presentationFaces(require('./face-modes').FACES).map(({ id, label }) => ({ id, label }));
  assert.deepEqual(response.faces, expectedFaces);
  response.faces[0].label = 'tampered'; response.faces.pop();
  assert.deepEqual(handlers.get('ha.view:day-schedule:get')({ sender: editor.webContents, senderFrame: editor.webContents.mainFrame }).faces, expectedFaces);
  assert.equal(response.config.idleMs, 120000); assert.equal(response.idleOverrideMs, null); assert.equal('file' in response, false);
  assert.ok(require('./menu').list(require('electron')).some(entry => entry.label === 'Automatic faces…'));
  assert.equal(currentMenu?.items.some(item => item.label === 'Original') || false, false);
  let prevented = false; editor.webContents.emit('before-input-event', { preventDefault() { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.ok(prevented); assert.equal(editor.visible, false); assert.deepEqual(returns.at(-1), ['chooser', 'back']);
  require('./menu').run(require('electron'), require('./menu').list(require('electron')).find(entry => entry.label === 'Automatic faces…').id, parent); assert.equal(views.length, 2); assert.equal(editor.destroyed, true, 'closed renderer destroyed');
  const reopened = views.at(-1); assert.equal(reopened.loads, 1, 'fresh renderer loads saved form');
  handlers.get('ha.view:day-schedule:close')({ sender: reopened.webContents, senderFrame: reopened.webContents.mainFrame }); assert.deepEqual(returns.at(-1), ['menu', 'back']);
  dispose.open('chooser'); allowed = false; dispose.close('off'); finishLoad(); await Promise.resolve();
  assert.equal(editor.visible, false, 'async load cannot reveal an OFF editor'); dispose.open(); assert.equal(editor.visible, false);
  assert.throws(() => handlers.get('ha.view:day-schedule:get')({ sender: editor.webContents }), /Untrusted/);
  dispose(); dispose(); assert.equal(children.length, 0); assert.equal(editor.destroyed, true); assert.equal(parent.listenerCount('resize'), 0); assert.equal(parent.listenerCount('closed'), 0); assert.equal(editor.webContents.eventNames().length, 0); assert.equal(handlers.size, 0); assert.deepEqual(currentMenu.items.map(item => item.role), [...(process.platform === 'darwin' ? ['appMenu'] : []), 'fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  const again = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {}, interaction() {} });
  again.open(); parent.isDestroyed = () => true; parent.contentView.removeChildView = () => { throw Error('destroyed parent'); };
  assert.doesNotThrow(() => parent.emit('closed')); assert.equal(views.at(-1).destroyed, true); again();
});

test('save persists atomically before apply; invalid input leaves runtime and file unchanged', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-settings-')), file = path.join(dir, 'settings.json');
  const parent = new EventEmitter(); parent.isDestroyed = () => false; parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  let updates = 0, changes = 0;
  const dispose = install({ parent, file, interaction() {}, idleOverride: () => 80, changed: () => changes++, schedule: { update(config) { updates++; assert.deepEqual(JSON.parse(fs.readFileSync(file)), config); } } });
  try {
    dispose.open(); const event = { sender: views.at(-1).webContents, senderFrame: views.at(-1).webContents.mainFrame };
    assert.equal(handlers.get('ha.view:day-schedule:get')(event).idleOverrideMs, 80);
    const save = handlers.get('ha.view:day-schedule:save');
    save(event, { enabled: false, rules: [], idleMs: 6000 });
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => save(event, { enabled: false, rules: [], idleMs: 0 }));
    assert.equal(fs.readFileSync(file, 'utf8'), before); assert.equal(updates, 1); assert.equal(changes, 1);
  } finally { dispose(); fs.rmSync(dir, { recursive: true }); }
});

test('Face Settings markup has ordered sections, concise copy and no config path or privacy paragraph', () => {
  const fs = require('node:fs'), path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, 'day-schedule.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, 'day-schedule-renderer.js'), 'utf8');
  assert.match(html, /<h1 id="title">Face Settings<\/h1>/);
  assert.match(html, /Inactivity timer[\s\S]*<hr>[\s\S]*Automatic faces/);
  assert.match(html, /Choose which faces appear after inactivity throughout the day\. Repeats daily\./);
  assert.match(html, /Save settings/);
  assert.doesNotMatch(html + renderer, /No personal or secret information is stored|Local config:|id="file"/);
  assert.match(renderer, /idleMs: Number\(input.value\) \* 60000/);
  assert.match(html, /id="idle-override" hidden/);
});

test('calendar discovery recovers once and rejects unauthorized work before backend', async () => {
  const parent = new EventEmitter(); parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  let calls = 0, responses = [];
  const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {}, interaction() {},
    calendars: () => { calls++; const response = responses.shift(); if (response instanceof Error) throw response; return response; } });
  try {
    dispose.open(); const event = { sender: views.at(-1).webContents, senderFrame: views.at(-1).webContents.mainFrame };
    const read = handlers.get('ha.view:day-schedule:calendars');
    const ok = { status: 'ok', calendars: [] };
    responses = [{ status: 'disconnected' }, ok];
    assert.deepEqual(await read(event), ok); assert.equal(calls, 2);
    responses = [{ status: 'disconnected' }, { status: 'disconnected' }, ok]; calls = 0;
    assert.equal((await read(event)).status, 'disconnected'); assert.equal(calls, 2, 'bounded once-only recovery');
    for (const status of ['ok', 'setup-needed', 'permission-error', 'timeout', 'error']) {
      responses = [{ status }]; calls = 0;
      assert.equal((await read(event)).status, status); assert.equal(calls, 1);
    }
    for (const first of [true, false]) {
      responses = first ? [new Error('active backend failure')] : [{ status: 'disconnected' }, Promise.reject(new Error('active backend failure'))];
      await assert.rejects(read(event), /active backend failure/);
    }
    calls = 0;
    await assert.rejects(read({ sender: {} }), /Untrusted/);
    await assert.rejects(read({ sender: event.sender, senderFrame: {} }), /Untrusted/);
    assert.equal(calls, 0);
  } finally { dispose(); }
});

for (const boundary of [1, 2]) for (const outcome of ['ok', 'disconnected', 'reject'])
for (const lifecycle of ['close', 'dispose', 'destroy', 'reopen']) {
  test(`quiet calendar expiry: read ${boundary}, ${outcome}, ${lifecycle}`, async () => {
    const parent = new EventEmitter(); parent.isDestroyed = () => false;
    parent.getContentBounds = () => ({ width: 800, height: 600 });
    parent.contentView = { addChildView() {}, removeChildView() {} };
    let calls = 0, resolve, reject;
    const held = new Promise((r, j) => { resolve = r; reject = j; });
    const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {}, interaction() {},
      calendars: () => { calls++; return calls === boundary ? held : { status: 'disconnected' }; } });
    try {
      dispose.open(); const contents = views.at(-1).webContents;
      const event = { sender: contents, senderFrame: contents.mainFrame };
      const read = handlers.get('ha.view:day-schedule:calendars');
      const pending = read(event);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(calls, boundary);
      if (lifecycle === 'dispose') dispose();
      else if (lifecycle === 'destroy') contents.close();
      else { dispose.close(); if (lifecycle === 'reopen') dispose.open(); }
      if (outcome === 'reject') reject(new Error('late backend failure'));
      else resolve({ status: outcome, calendars: [{ entity_id: 'calendar.old' }] });
      assert.equal(await pending, undefined);
      assert.equal(calls, boundary, 'no retry after expiry');
      await assert.rejects(read(event), /Untrusted/);
      assert.equal(calls, boundary, 'old sender rejected before backend');
      if (lifecycle === 'reopen') assert.notEqual(views.at(-1).webContents, contents);
    } finally { dispose(); }
  });
}

test('old load rejection cannot log or close a reopened entry; OFF stays closed', async () => {
  const parent = new EventEmitter(); parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  const transitions = [], errors = [], originalError = console.error;
  const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {}, interaction: value => transitions.push(value) });
  console.error = (...args) => errors.push(args);
  try {
    dispose.open(); const oldReject = rejectLoad;
    dispose.close(); dispose.open(); const fresh = views.at(-1);
    oldReject(new Error('old cancelled load')); await Promise.resolve();
    assert.equal(fresh.visible, true); assert.deepEqual(transitions, [true, false, true]);
    const offReject = rejectLoad; dispose.close('off'); offReject(new Error('OFF cancelled load')); await Promise.resolve();
    assert.equal(fresh.destroyed, true); assert.deepEqual(errors, []);
  } finally { console.error = originalError; dispose(); }
});

test('actual Calendar renderer callback accepts undefined without throwing or touching DOM/status', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'day-schedule-renderer.js'), 'utf8');
  const start = source.indexOf('window.daySchedule.calendars().then');
  const end = source.indexOf('  strategy.value', start);
  let touched = 0;
  await vm.runInNewContext(source.slice(start, end), {
    window: { daySchedule: { calendars: () => Promise.resolve(undefined) } },
    document: { querySelector() { touched++; throw new Error('late DOM mutation'); } }
  });
  assert.equal(touched, 0);
});

test('all Settings IPC rejects missing/null/foreign frames before reads, writes or close', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-settings-trust-')), file = path.join(dir, 'settings.json');
  const store = require('./day-schedule'), originalRead = store.read, originalWrite = store.write;
  const effects = { read: 0, write: 0, calendars: 0, update: 0, changed: 0, closed: 0 };
  store.read = (...args) => { effects.read++; return originalRead(...args); };
  store.write = (...args) => { effects.write++; return originalWrite(...args); };
  const parent = new EventEmitter(); parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  const dispose = install({ parent, file, schedule: { update() { effects.update++; } }, interaction() {},
    changed() { effects.changed++; }, closed() { effects.closed++; },
    calendars() { effects.calendars++; return { status: 'ok', calendars: [] }; } });
  try {
    dispose.open(); const contents = views.at(-1).webContents;
    for (const name of ['get', 'save', 'close', 'calendars']) {
      for (const frame of [undefined, null, {}, views[0].webContents.mainFrame]) {
        const event = { sender: contents }; if (frame !== undefined) event.senderFrame = frame;
        const handler = handlers.get(`ha.view:day-schedule:${name}`);
        if (name === 'calendars') await assert.rejects(handler(event), /Untrusted/);
        else assert.throws(() => handler(event, { enabled: false, rules: [], idleMs: 6000 }), /Untrusted/);
        assert.deepEqual(effects, { read: 0, write: 0, calendars: 0, update: 0, changed: 0, closed: 0 });
        assert.equal(contents.isDestroyed(), false); assert.equal(fs.existsSync(file), false);
      }
    }
    const event = { sender: contents, senderFrame: contents.mainFrame };
    handlers.get('ha.view:day-schedule:get')(event);
    await handlers.get('ha.view:day-schedule:calendars')(event);
    handlers.get('ha.view:day-schedule:save')(event, { enabled: false, rules: [], idleMs: 6000 });
    assert.equal(effects.read, 1); assert.equal(effects.write, 1); assert.equal(effects.calendars, 1);
    assert.equal(effects.update, 1); assert.equal(effects.changed, 1);
    handlers.get('ha.view:day-schedule:close')(event); assert.equal(effects.closed, 1);
  } finally { dispose(); store.read = originalRead; store.write = originalWrite; fs.rmSync(dir, { recursive: true }); }
});

test('active Settings load failure is logged and closes only its current entry', async () => {
  const parent = new EventEmitter(); parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  const errors = [], closures = [], originalError = console.error;
  const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {}, interaction() {}, closed: (...args) => closures.push(args) });
  console.error = (...args) => errors.push(args);
  try {
    dispose.open('menu'); const current = views.at(-1);
    rejectLoad(new Error('active load failure')); await Promise.resolve();
    assert.deepEqual(errors, [['HA.View schedule load failed:', 'active load failure']]);
    assert.deepEqual(closures, [['menu', 'error']]); assert.equal(current.destroyed, true);
  } finally { console.error = originalError; dispose(); }
});

test('Show a face now native menu leaves its own Settings overlay before showing a face', () => {
  currentMenu = new Menu();
  const parent = new EventEmitter(); parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ width: 800, height: 600 });
  parent.contentView = { addChildView() {}, removeChildView() {} };
  let inhibited = false, chosen = 0, allowed = true;
  const dispose = install({ parent, file: '/nonexistent-ha-view-test.json', schedule: {},
    interaction: value => inhibited = value, allowed: () => allowed,
    showFaceNow: () => { assert.equal(inhibited, false); chosen++; } });
  try {
    const action = currentMenu.items.find(item => item.label === 'HA View').submenu.items.find(item => item.label === 'Show a face now…');
    dispose.open(); action.click();
    assert.equal(chosen, 1, 'own overlay must not swallow Show a face now');
    assert.equal(action.label, 'Show a face now…');
    action.click(); assert.equal(chosen, 2, 'repeat action invokes face display');
    allowed = false; action.click(); assert.equal(chosen, 2, 'power/other Settings safety guard');
    dispose(); action.click(); assert.equal(chosen, 2, 'disposed menu cannot act');
  } finally { dispose(); }
});
