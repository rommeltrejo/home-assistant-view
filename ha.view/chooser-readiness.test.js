'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
// Optional isolated HEAD checkout: the same barriers and input assertions run on base.
const root = process.env.HA_VIEW_READINESS_ROOT || path.resolve(__dirname, '..');
const ipc = new EventEmitter();
let view;
class Contents {
  constructor() { this.scripts = []; this.url = ''; }
  async loadFile(file) { this.url = file; }
  getURL() { return this.url; }
  on(name, fn) { this[name] = fn; }
  focus() {}
  close() { this.closed = true; }
  isDestroyed() { return !!this.closed; }
  setWindowOpenHandler() {}
}
class View {
  constructor() { view = this; this.webContents = new Contents(); }
  setVisible(v) { this.visible = v; }
  setBounds(v) { this.bounds = v; }
  setBackgroundColor() {}
}
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true,
  exports: { WebContentsView: View, ipcMain: ipc }, children: [], paths: [] };
const hooks = require(path.join(root, 'ha.view/hooks.js'));
console.verbose ||= () => {};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const rects = { cancel: { x: 900, y: 20, width: 80, height: 44 }, schedule: { x: 20, y: 20, width: 100, height: 44 }, hide: { x: 1100, y: 20, width: 80, height: 44 } };
for (const routing of ['native', 'touch']) {
  test(`production chooser ${routing}: catalog barrier, input readiness and stale geometry`, async t => {
    const old = { APP: global.APP, ARGS: global.ARGS, WEBVIEW: global.WEBVIEW };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-readiness-'));
    const arg = `--ha-view-day-schedule=${path.join(dir, 'schedule.json')}`;
    process.argv.push(arg);
    const day = require('./day-schedule');
    day.write(path.join(dir, 'schedule.json'), { ...day.DEFAULT, enabled: false, strategy: 'daily', rules: [] });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const catalog = deferred(); let probes = 0, initialized = false, queries = 0;
    const geometry = [];
    const dashboard = { focus() {}, getURL: () => 'https://ha.test/map/0', isDestroyed: () => false,
      executeJavaScript: script => { if (script.includes('hass?.user')) return Promise.resolve(true); probes++; return catalog.promise; } };
    global.APP = { path: root }; global.ARGS = { ha_view_idle_ms: 25, app_disable: [] };
    global.WEBVIEW = {
      window: { contentView: { addChildView() {} }, getBounds: () => ({ width: 1280, height: 720 }) },
      header: { getBounds: () => ({ height: 36 }) }, navigation: { getBounds: () => ({ height: 40 }) },
      views: [{ setVisible() {}, webContents: { focus() {} } }, { setVisible() {}, webContents: dashboard }],
      viewActive: 1, tracker: { display: { on: 100000, off: 0 }, view: { idle: false }, header: { enabled: true }, navigation: { enabled: true } },
    };
    const ready = expected => {
      if (!process.env.HA_VIEW_READINESS_ROOT) assert.equal(hooks.pickerReady(), expected);
    };
    try {
      hooks.init(require('./idle-lifecycle-fixture.cjs')(hooks));
      view.webContents.executeJavaScript = script => {
        view.webContents.scripts.push(script);
        if (script.includes('getBoundingClientRect')) {
          queries++;
          return geometry.length ? geometry.shift().promise : Promise.resolve(rects);
        }
        if (script.includes('window.setHiddenFaces') && script.includes('window.previewFace')) initialized = true;
        return Promise.resolve();
      };
      const send = (type, x = 600, y = 350) => {
        if (routing === 'touch') ipc.emit('ha.view:face-touch', { sender: view.webContents }, { type, x, y });
        else view.webContents['before-mouse-event']({ preventDefault() {} }, {
          type: { down: 'mouseDown', move: 'mouseMove', up: 'mouseUp', cancel: 'mouseLeave' }[type], button: 'left', x, y });
      };
      const swipe = () => { send('down'); send('move', 200); send('up', 200); };
      const previews = () => view.webContents.scripts.filter(s => s.includes('window.previewFace?.('));
      ready(false);
      await flush(); t.mock.timers.tick(25); await flush();
      send('down'); t.mock.timers.tick(600); await flush(); send('up');
      assert.ok(initialized, 'production initial chooser DOM script ran before catalog settles');
      assert.ok(view.webContents.getURL().endsWith('/face-changer.html'));
      assert.ok(probes > 0, 'actual calendar-data reader is awaiting dashboard reply');
      assert.equal(queries, 0, 'catalog barrier prevents normal geometry installation');
      ready(false);
      swipe(); send('down', 930, 30); send('up', 930, 30);
      assert.equal(previews().length, 0, 'before-ready swipe ignored; Cancel also ignored');
      assert.ok(view.webContents.getURL().endsWith('/face-changer.html'));
      // A press begun before readiness must not survive the transition.
      send('down');
      catalog.resolve({ status: 'ok', calendars: [{ entity_id: 'calendar.test', name: 'Test' }] });
      await flush(); assert.equal(queries, 1); ready(true);
      send('up', 200); assert.equal(previews().length, 0, 'no partial gesture crosses readiness');
      swipe(); await flush();
      assert.deepEqual(previews(), ['window.previewFace?.(2)'], 'after-ready identical swipe progresses default Clock 1 to Weather');
      // Two outstanding resize queries: stale revision cannot reopen input.
      const older = deferred(), newer = deferred(); geometry.push(older, newer);
      hooks.layoutChanged(); hooks.layoutChanged(); ready(false);
      older.resolve(rects); await flush(); ready(false);
      swipe(); assert.equal(previews().length, 1, 'stale resize result cannot install geometry');
      newer.resolve(rects); await flush(); ready(true);
      swipe(); await flush(); assert.equal(previews().at(-1), 'window.previewFace?.(3)');
      const abandoned = deferred(); geometry.push(abandoned);
      hooks.layoutChanged(); ready(false);
      hooks.activeViewChanged(); abandoned.resolve(rects); await flush(); ready(false);
      assert.equal(view.visible, false, 'navigation invalidates outstanding geometry generation');
      hooks.dispose(); ready(false);
    } finally {
      catalog.resolve({ status: 'ok', calendars: [] });
      hooks.dispose(); await flush(); process.argv.splice(process.argv.indexOf(arg), 1);
      Object.assign(global, old); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
