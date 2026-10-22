const test = require("node:test");
const { beforeEach, afterEach } = test;
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const touchIPC = new EventEmitter();
const createdViews = [];
class MockWebContents {
  constructor() { this.loaded = []; this.closed = false; }
  async loadFile(file) { this.loaded.push(file); }
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
  on(name, handler) { this[name] = handler; }
  focus() { this.focused = true; }
  setWindowOpenHandler(handler) { this.openHandler = handler; }
}
class MockWebContentsView {
  constructor(options) {
    this.options = options;
    this.webContents = new MockWebContents();
    this.visible = false;
    createdViews.push(this);
  }
  setBackgroundColor(color) { this.background = color; }
  setBounds(bounds) { this.bounds = bounds; }
  setVisible(visible) { this.visible = visible; }
  getVisible() { return this.visible; }
}
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { WebContentsView: MockWebContentsView, ipcMain: touchIPC, app: {} },
  children: [],
  paths: [],
};

let activeApp;
let activeArgs;
let activeWebview;
const hooks = require(path.join(__dirname, "hooks.js"));
console.verbose ||= () => {};

beforeEach(() => {
  activeApp = global.APP;
  activeArgs = global.ARGS;
  activeWebview = global.WEBVIEW;
  global.APP = { path: "/app" };
  global.ARGS = { ha_view_idle_ms: 25, app_disable: [] };
  global.WEBVIEW = makeWebview();
});

afterEach(() => {
  hooks.dispose();
  global.APP = activeApp;
  global.ARGS = activeArgs;
  global.WEBVIEW = activeWebview;
});

function makeWebview() {
  return {
    window: {
      contentView: { addChildView(view) { this.added = view; } },
      getBounds() { return { width: 1280, height: 720 }; },
    },
    header: { getBounds() { return { height: 36 }; } },
    navigation: { getBounds() { return { height: 40 }; } },
    views: [
      { setVisible(value) { this.visible = value; }, webContents: { focus() { this.focused = true; }, executeJavaScript: async script => script.includes('hass?.user') ? true : undefined } },
      { setVisible(value) { this.visible = value; }, webContents: { focus() { this.focused = true; }, executeJavaScript: async script => script.includes('hass?.user') ? true : undefined } },
    ],
    viewActive: 1,
    tracker: {
      display: { on: new Date(), off: new Date(0) },
      view: { idle: false },
      header: { enabled: true },
      navigation: { enabled: true },
    },
  };
}

const waitFor = async (predicate, timeoutMs = 1000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for clock transition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const waitForClock = () => waitFor(() => createdViews.at(-1)?.getVisible());
const start = async () => {
  assert.equal(hooks.init(require("./idle-lifecycle-fixture.cjs")(hooks)), true);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return createdViews.at(-1);
};

// Selected-face tests exercise the nonrotating fallback, not fresh-profile defaults.
function useSelectedFaceSchedule(t) {
  const day = require('./day-schedule');
  const arg = '--ha-view-day-schedule=/unused-selected-face-fixture';
  process.argv.push(arg);
  t.mock.method(day, 'read', () => ({ config: { ...day.DEFAULT, enabled: false, strategy: 'daily', rules: [] } }));
  t.after(() => process.argv.splice(process.argv.indexOf(arg), 1));
}

test("shows Clock 1 (internal clock2) after inactivity with scheduling disabled", async (t) => {
  useSelectedFaceSchedule(t);
  const clock = await start();
  await waitForClock();
  assert.equal(clock.webContents.loaded.at(-1), "/app/ha.view/faces/clock-2.html");
  assert.equal(clock.options.webPreferences.nodeIntegration, false);
  assert.equal(clock.options.webPreferences.contextIsolation, true);
  assert.equal(clock.options.webPreferences.sandbox, true);
  assert.equal(clock.background, "#000000");
  assert.deepEqual(clock.bounds, { x: 0, y: 36, width: 1280, height: 644 });
  assert.equal(global.WEBVIEW.views[0].visible, false);
  assert.equal(global.WEBVIEW.views[1].visible, false);
});

test("selects internal clock2 with --ha-view-clock-face=2 and defaults invalid values to clock2", async (t) => {
  useSelectedFaceSchedule(t);
  global.ARGS.ha_view_clock_face = "2";
  const clock2 = await start();
  await waitForClock();
  assert.equal(clock2.webContents.loaded.at(-1), "/app/ha.view/faces/clock-2.html");
  hooks.dispose();

  global.ARGS = { ha_view_idle_ms: 25, ha_view_clock_face: "7", app_disable: [] };
  const fallback = await start();
  await waitForClock();
  assert.equal(fallback.webContents.loaded.at(-1), "/app/ha.view/faces/clock-2.html");
});

test("cancels face dismissal input and returns to the active dashboard", async () => {
  const clock = await start();
  await waitForClock();
  let prevented = false;
  clock.webContents["before-mouse-event"](
    { preventDefault() { prevented = true; } },
    { type: "mouseDown", button: "left" },
  );
  assert.equal(prevented, true);
  assert.equal(clock.getVisible(), true, 'press alone must not dismiss');
  prevented = false;
  clock.webContents['before-mouse-event']({ preventDefault() { prevented = true; } }, { type: 'mouseUp', button: 'left' });
  assert.equal(prevented, true, 'release is consumed');
  assert.deepEqual(clock.bounds, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(clock.getVisible(), false);
  assert.equal(global.WEBVIEW.views[1].visible, true);
  assert.equal(global.WEBVIEW.views[1].webContents.focused, true);
  assert.equal(global.WEBVIEW.tracker.view.idle, false);
});

test("display power transitions hide the face and leave sleeping-screen wake handling upstream", async () => {
  const clock = await start();
  await waitForClock();
  global.WEBVIEW.tracker.display.off = new Date(Date.now() + 1000);
  hooks.displayChanged("OFF");
  assert.equal(clock.getVisible(), false);
  global.WEBVIEW.tracker.display.off = new Date(Date.now() + 1000);
  let prevented = false;
  hooks.pointerEvent({ preventDefault() { prevented = true; } }, { type: "mouseDown", button: "left" });
  assert.equal(prevented, false, "the clock hook does not consume the upstream wake touch");
  assert.equal(clock.getVisible(), false);

  global.WEBVIEW.tracker.display.on = new Date(Date.now() + 2000);
  hooks.displayChanged("ON");
  assert.equal(clock.getVisible(), false);
});

test("upstream idle cannot displace the clock; active-view changes dismiss and layout resizes it", async () => {
  const clock = await start();
  await waitForClock();
  global.WEBVIEW.window.getBounds = () => ({ width: 800, height: 480 });
  hooks.layoutChanged();
  assert.deepEqual(clock.bounds, { x: 0, y: 36, width: 800, height: 404 });

  hooks.upstreamIdleChanged(true);
  assert.equal(clock.getVisible(), true);
  hooks.upstreamIdleChanged(false);
  await waitForClock();
  hooks.activeViewChanged();
  assert.equal(clock.getVisible(), false);
  assert.equal(global.WEBVIEW.views[1].visible, true);
});

test("redundant upstream active notifications preserve the original idle deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  global.ARGS.ha_view_idle_ms = 100;
  const clock = await start();
  for (let elapsed = 20; elapsed <= 100; elapsed += 20) {
    t.mock.timers.tick(20);
    require("./idle-lifecycle-fixture.cjs")(hooks).applyView(false);
  }
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  assert.equal(clock.getVisible(), true);
});

test("redundant apply notifications keep the selected active clock above dashboards", async (t) => {
  useSelectedFaceSchedule(t);
  global.ARGS.ha_view_clock_face = "2";
  const clock = await start();
  await waitForClock();
  const loaded = clock.webContents.loaded.length;
  for (let i = 0; i < 3; i += 1) {
    // Match applyView(false): upstream resets its tracker and reveals a dashboard.
    global.WEBVIEW.tracker.view.idle = false;
    global.WEBVIEW.views.forEach((view, index) => view.setVisible(index === global.WEBVIEW.viewActive));
    hooks.upstreamIdleChanged(false);
    assert.equal(clock.getVisible(), true);
    assert.equal(global.WEBVIEW.tracker.view.idle, true);
    assert.equal(global.WEBVIEW.views[1].visible, false);
  }
  assert.equal(clock.webContents.loaded.at(-1), "/app/ha.view/faces/clock-2.html");
  assert.equal(clock.webContents.loaded.length, loaded);
});

test("redundant apply notification does not cancel an in-flight selected clock load", async (t) => {
  useSelectedFaceSchedule(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  global.ARGS.ha_view_clock_face = "2";
  const clock = await start();
  let finishLoad;
  clock.webContents.loadFile = (file) => {
    clock.webContents.loaded.push(file);
    return new Promise((resolve) => { finishLoad = resolve; });
  };
  t.mock.timers.tick(25);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(typeof finishLoad, "function");
  global.WEBVIEW.tracker.view.idle = false;
  hooks.upstreamIdleChanged(false);
  finishLoad();
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  assert.equal(clock.getVisible(), true);
  assert.equal(clock.webContents.loaded.at(-1), "/app/ha.view/faces/clock-2.html");
});

test("wake starts a fresh shared deadline and display-off blanks every presentation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  global.ARGS.ha_view_idle_ms = 100;
  const clock = await start();
  t.mock.timers.tick(100);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  global.WEBVIEW.tracker.display.on = 0;
  global.WEBVIEW.tracker.display.off = Date.now() + 1;
  hooks.displayChanged('OFF');
  require('./idle-lifecycle-fixture.cjs')(hooks).applyView(true);
  assert.equal(clock.getVisible(), false);
  assert.ok(global.WEBVIEW.views.every(v => !v.visible));
  global.WEBVIEW.tracker.display.on = Date.now() + 2;
  hooks.displayChanged('ON', true);
  let suppressed = false;
  hooks.pointerEvent({ preventDefault() { suppressed = true; } }, { type: 'mouseUp', button: 'left' });
  assert.equal(suppressed, true, 'wake release cannot click through');
  assert.equal(global.WEBVIEW.views[1].visible, true);
  t.mock.timers.tick(99);
  assert.equal(clock.getVisible(), false);
  t.mock.timers.tick(1);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(clock.getVisible(), true);
});

test('default two-minute deadline uses the upstream tracker timer and entrypoints', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  delete global.ARGS.ha_view_idle_ms;
  assert.equal(hooks.idleDelay(), 120000);
  const clock = await start();
  assert.ok(global.WEBVIEW.tracker.view.timer);
  t.mock.timers.tick(119999);
  assert.equal(clock.getVisible(), false);
  t.mock.timers.tick(1);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(clock.getVisible(), true);
  const lifecycle = require('./idle-lifecycle-fixture.cjs')(hooks);
  lifecycle.applyView(true); lifecycle.applyView(false);
  assert.equal(clock.getVisible(), true);
  assert.equal(global.WEBVIEW.views[0].visible, false);
  assert.equal(global.WEBVIEW.tracker.view.idle, true);
});

test("loads only the selected clock face and disposes its single local view", async (t) => {
  useSelectedFaceSchedule(t);
  const createdBefore = createdViews.length;
  const clock = await start();
  await waitForClock();
  assert.equal(createdViews.length - createdBefore, 1);
  assert.equal(clock.webContents.loaded.length, 1);
  assert.deepEqual(clock.webContents.openHandler(), { action: "deny" });
  let navigationPrevented = false;
  clock.webContents["will-navigate"]({ preventDefault() { navigationPrevented = true; } });
  assert.equal(navigationPrevented, true);
  hooks.dispose();
  assert.equal(clock.webContents.closed, true);
});

test('display off cancels a pending hold before it can navigate to picker', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const clock = await start(); t.mock.timers.tick(25);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  clock.webContents['before-mouse-event']({ preventDefault() {} }, { type: 'mouseDown', button: 'left', x: 100, y: 100 });
  hooks.displayChanged('OFF'); t.mock.timers.tick(1000);
  assert.equal(clock.getVisible(), false);
  assert.ok(clock.webContents.loaded.every(file => !file.endsWith('face-changer.html')));
});

test('day schedule idle dashboard switches to clock at boundary but pauses dashboard press', async (t) => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-hooks-day-'));
  const file = path.join(dir, 'schedule.json');
  require('./day-schedule').write(file, { enabled: true, strategy: 'daily', rules: [{ time: '00:00', mode: 'dashboard' }, { time: '18:00', mode: 'clock2' }] });
  process.argv.push(`--ha-view-day-schedule=${file}`);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 14, 17, 59, 59).getTime() });
  try {
    const dashboardContents = new EventEmitter(); dashboardContents.focus = () => {}; dashboardContents.executeJavaScript = async source => source.includes('hass?.user') ? true : undefined;
    global.WEBVIEW.views[1].webContents = dashboardContents;
    // Actual upstream forwarding shape: only down/move reaches pointerEvent.
    dashboardContents.on('before-mouse-event', (event, mouse) => {
      if (mouse.type === 'mouseDown' || mouse.type === 'mouseMove') hooks.pointerEvent(event, mouse);
    });
    const clock = await start(); t.mock.timers.tick(25);
    assert.equal(clock.getVisible(), false);
    dashboardContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' });
    t.mock.timers.tick(1000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(clock.getVisible(), false, 'held dashboard press blocks boundary');
    dashboardContents.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
    t.mock.timers.tick(25);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(clock.getVisible(), true);
    assert.ok(clock.webContents.loaded.at(-1).endsWith('clock-2.html'));
    hooks.dispose();
    assert.equal(dashboardContents.listenerCount('before-mouse-event'), 1, 'dispose removes only own observer, preserves upstream listener');
  } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true }); }
});

test('day schedule boundary never interrupts face picker or held face press', async (t) => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-hooks-picker-')), file = path.join(dir, 'config.json');
  require('./day-schedule').write(file, { enabled: true, strategy: 'daily', rules: [{ time: '00:00', mode: 'clock1' }, { time: '18:00', mode: 'dashboard' }] });
  process.argv.push(`--ha-view-day-schedule=${file}`);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 9, 14, 17, 59, 59).getTime() });
  try {
    const clock = await start(); clock.webContents.executeJavaScript = async () => ({ x: 0, y: 0, width: 40, height: 40 });
    t.mock.timers.tick(25); for (let i = 0; i < 30; i++) await Promise.resolve();
    clock.webContents['before-mouse-event']({ preventDefault() {} }, { type: 'mouseDown', button: 'left', x: 100, y: 100 });
    t.mock.timers.tick(1000); for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(clock.getVisible(), true);
    assert.ok(clock.webContents.loaded.at(-1).endsWith('face-changer.html'), 'picker remains loaded across boundary');
  } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true }); }
});

test('context idle precedence defers settings-independent active input, picker and press; expires to fallback', async (t) => {
  const { ContextBridge } = require('./context-bridge');
  let bridge;
  const original = ContextBridge.prototype.refresh;
  ContextBridge.prototype.refresh = function () { bridge = this; };
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    const clock = await start(); clock.webContents.executeJavaScript = async () => ({ x: 0, y: 0, width: 40, height: 40 });
    bridge.policy.update({enabled:true,rules:[{entity_id:'binary_sensor.a',state:'on',mode:'clock2'}]});
    bridge.policy.accept({connected:true,values:{'binary_sensor.a':'on'}});
    bridge.changed(); await flush(); assert.equal(clock.getVisible(),false,'active use is never interrupted');
    t.mock.timers.tick(25); await flush(); assert.ok(clock.webContents.loaded.at(-1).endsWith('clock-2.html'));
    clock.webContents['before-mouse-event']({preventDefault(){}},{type:'mouseDown',button:'left',x:100,y:100});
    bridge.policy.update({enabled:true,rules:[{entity_id:'binary_sensor.a',state:'on',mode:'dashboard'}]});
    bridge.policy.accept({connected:true,values:{'binary_sensor.a':'on'}}); bridge.changed(); await flush();
    assert.equal(clock.getVisible(),true,'held face press is protected');
    t.mock.timers.tick(1000); await flush(); bridge.changed(); await flush();
    assert.ok(clock.webContents.loaded.at(-1).endsWith('face-changer.html'),'picker is protected');
    hooks.activeViewChanged(); bridge.policy.accept({connected:true,values:{'binary_sensor.a':'on'}}); t.mock.timers.tick(25); await flush(); assert.equal(clock.getVisible(),false,'idle dashboard context wins');
    t.mock.timers.tick(15000); bridge.changed(); await flush(); assert.equal(clock.getVisible(),true,'stale context returns to selected clock');
  } finally { hooks.dispose(); ContextBridge.prototype.refresh = original; }
});

test('navigation resets idle-dashboard policy and preserves a fresh full deadline on reapply', async (t) => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-navigation-'));
  const file = path.join(dir, 'schedule.json');
  require('./day-schedule').write(file, { enabled: true, strategy: 'daily', rules: [{ time: '00:00', mode: 'dashboard' }] });
  process.argv.push(`--ha-view-day-schedule=${file}`);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  try {
    delete global.ARGS.ha_view_idle_ms;
    const clock = await start();
    const lifecycle = require('./idle-lifecycle-fixture.cjs')(hooks);
    t.mock.timers.tick(120000);
    assert.equal(clock.getVisible(), false);
    assert.equal(global.WEBVIEW.tracker.view.idle, true);
    hooks.activeViewChanged();
    assert.equal(global.WEBVIEW.tracker.view.idle, false);
    assert.equal(global.WEBVIEW.views[1].visible, true);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const timer = global.WEBVIEW.tracker.view.timer;
    lifecycle.applyView(false);
    assert.equal(global.WEBVIEW.tracker.view.idle, false);
    assert.equal(global.WEBVIEW.tracker.view.timer, timer);
    t.mock.timers.tick(119999);
    lifecycle.applyView(false);
    assert.equal(global.WEBVIEW.tracker.view.idle, false);
    t.mock.timers.tick(1);
    assert.equal(global.WEBVIEW.tracker.view.idle, true);
    assert.equal(global.WEBVIEW.views[0].visible, false);
  } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true }); }
});

for (const routing of ['native', 'touch']) {
  test(`chooser ${routing}: deliberate Settings/Cancel, opening release, drag, resize and sender gate`, async t => {
    const fs = require('node:fs'), os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-picker-buttons-'));
    require('./day-schedule').write(path.join(dir, 'schedule.json'), { enabled: false, strategy: 'daily', rules: [] });
    global.ARGS.ha_view_clock_face = '2';
    process.argv.push(`--ha-view-day-schedule=${path.join(dir, 'schedule.json')}`);
    const settings = require('./system-settings');
    require.cache[electronPath].exports.app.getPath = () => dir;
    t.after(() => { delete require.cache[electronPath].exports.app.getPath; });
    t.mock.method(require('./context-settings'), 'install', () => () => {});
    t.mock.method(require('./layout-editor'), 'install', () => () => {});
    let opened = 0, interaction, closeEditor, closeReason;
    t.mock.method(settings, 'install', options => {
      interaction = options.interaction;
      closeEditor = (reason = 'back') => { interaction(false); options.closed('chooser'); closeReason = reason; };
      return Object.assign(() => interaction(false), { open: source => { assert.equal(source, 'chooser'); opened++; interaction(true); }, close: closeEditor });
    });
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
    try {
      const clock = await start();
      let rects = { cancel: { x: 900, y: 20, width: 80, height: 44 }, system: { x: 20, y: 20, width: 100, height: 44 } };
      clock.webContents.executeJavaScript = async script => {
        if (script.includes('getBoundingClientRect')) {
          assert.ok(script.includes("['cancel','system','hide']"));
          assert.ok(script.includes('getElementById'));
          return rects;
        }
      };
      const send = (type, x, y, sender = clock.webContents) => {
        if (routing === 'touch') touchIPC.emit('ha.view:face-touch', { sender }, { type, x, y });
        else clock.webContents['before-mouse-event']({ preventDefault() {} }, { type: { down: 'mouseDown', up: 'mouseUp', move: 'mouseMove', cancel: 'mouseLeave' }[type], button: 'left', x, y });
      };
      const openPicker = async (x = 400, y = 300) => {
        t.mock.timers.tick(25); await flush();
        send('down', x, y); t.mock.timers.tick(600); await flush();
        assert.ok(clock.webContents.loaded.at(-1).endsWith('face-changer.html'));
        send('up', x, y); await flush();
      };
      await openPicker(50, 30);
      assert.equal(opened, 0, 'chooser-opening release over Settings does nothing');
      if (routing === 'touch') {
        send('down', 50, 30, {}); send('up', 50, 30, {});
        assert.equal(opened, 0, 'foreign sender cannot press Settings');
      }
      send('down', 50, 30); send('up', 80, 30); await flush();
      assert.equal(opened, 0, 'movement on release alone cannot activate');
      send('down', 50, 30); send('move', 80, 30); send('up', 50, 30);
      assert.equal(opened, 0, 'moved press returning to button cannot activate');
      send('down', 930, 30); send('up', 930, 30); await flush();
      assert.ok(clock.webContents.loaded.at(-1).endsWith('clock-2.html'), 'Cancel restores clock without opening settings');
      await openPicker();
      rects = { cancel: { x: 700, y: 70, width: 80, height: 44 }, system: { x: 200, y: 70, width: 100, height: 44 } };
      hooks.layoutChanged(); await flush();
      send('down', 730, 80); send('up', 730, 80); await flush();
      assert.ok(clock.webContents.loaded.at(-1).endsWith('clock-2.html'), 'resized Cancel hit area works');
      await openPicker();
      send('down', 230, 80); send('up', 230, 80); await flush();
      assert.equal(opened, 1, 'resized Settings opens existing editor once');
      assert.equal(clock.getVisible(), true, 'chooser stays visible beneath input-blocking modal');
      assert.equal(hooks.idleDeadline(), false, 'settings inhibits idle');
      t.mock.timers.tick(1000); await flush(); assert.equal(clock.getVisible(), true);
      hooks.upstreamIdleChanged(false); hooks.activeViewChanged();
      assert.equal(global.WEBVIEW.views[1].visible, true, 'navigation revokes auth and restores accessible dashboard even beneath settings');
      await flush(); // New active frontend must authenticate before chooser restoration.
      closeEditor(); await flush();
      assert.equal(clock.getVisible(), true, 'Close returns chooser');
      assert.ok(clock.webContents.loaded.at(-1).endsWith('face-changer.html'));
      send('down', 230, 80); send('up', 230, 80); await flush();
      hooks.displayChanged('OFF'); await flush();
      assert.equal(closeReason, 'off'); assert.equal(clock.getVisible(), false);
      hooks.displayChanged('ON', true); await flush();
      assert.equal(clock.getVisible(), false, 'wake returns dashboard, never chooser/editor');
    } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true }); }
  });
}

test('saved inactivity duration drives shared idle timer after restart without CLI override', async (t) => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-idle-hooks-'));
  const file = path.join(dir, 'settings.json'), arg = `--ha-view-day-schedule=${file}`;
  process.argv.push(arg);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  try {
    require('./day-schedule').write(file, { enabled: false, rules: [], idleMs: 6000 });
    delete global.ARGS.ha_view_idle_ms;
    for (let restart = 0; restart < 2; restart++) {
      const clock = await start();
      assert.equal(hooks.idleDelay(), 6000);
      t.mock.timers.tick(5999); assert.equal(clock.getVisible(), false);
      t.mock.timers.tick(1);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      assert.equal(clock.getVisible(), true);
      hooks.dispose();
    }
    global.ARGS.ha_view_idle_ms = 25;
    await start(); assert.equal(hooks.idleDelay(), 25, 'explicit override wins over saved setting');
  } finally { hooks.dispose(); process.argv.splice(process.argv.indexOf(arg), 1); fs.rmSync(dir, { recursive: true }); }
});

test('fresh profile rotates eligible faces every five minutes with Layout hidden', async t => {
  for (const module of ['./system-settings', './context-settings', './layout-editor']) {
    t.mock.method(require(module), 'install', () => () => {});
  }
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-hooks-fresh-'));
  require.cache[electronPath].exports.app.getPath = () => dir;
  t.after(() => { delete require.cache[electronPath].exports.app.getPath; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let rotationTick = null, duration;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  try {
    const day = require('./day-schedule');
    const config = day.read(path.join(dir, 'ha.view-day-schedule.json')).config;
    assert.equal(config.enabled, true);
    assert.equal(config.strategy, 'rotation');
    assert.equal(config.rotationMs, 300000);
    assert.deepEqual(require('./face-changer-store').readHidden(path.join(dir, 'ha.view-face.json')), ['layout']);
    hooks.init(require('./idle-lifecycle-fixture.cjs')(hooks), {
      setTimer: (fn, ms) => { rotationTick = fn; duration = ms; return 1; },
      clearTimer: () => { rotationTick = null; },
    });
    await flush();
    const clock = createdViews.at(-1);
    assert.equal(rotationTick, null, 'rotation waits for idle entry');
    t.mock.timers.tick(25); await flush();
    assert.equal(clock.getVisible(), true);
    assert.ok(clock.webContents.loaded.at(-1).endsWith('/clock.html'));
    assert.equal(duration, 300000);
    rotationTick(); await flush();
    assert.ok(clock.webContents.loaded.at(-1).endsWith('/clock-2.html'));
    assert.equal(duration, 300000);
    rotationTick(); await flush();
    assert.ok(clock.webContents.loaded.at(-1).endsWith('/clock.html'), 'unavailable calendars and hidden Layout are skipped');
  } finally { hooks.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rotation counts full visible intervals, suspends on dashboard/OFF/settings/press and resumes after renderer load', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-hooks-rotation-'));
  const arg = `--ha-view-day-schedule=${path.join(dir, 'schedule.json')}`;
  require('./day-schedule').write(path.join(dir, 'schedule.json'), { enabled: true, strategy: 'rotation', rules: [] });
  process.argv.push(arg);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let rotationTick = null, duration;
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    hooks.init(require('./idle-lifecycle-fixture.cjs')(hooks), { setTimer: (fn, ms) => { rotationTick = fn; duration = ms; return 1; }, clearTimer: () => { rotationTick = null; } });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const clock = global.WEBVIEW.window.contentView.added;
    assert.equal(rotationTick, null);
    t.mock.timers.tick(25); await flush(); assert.equal(duration, 300000); assert.equal(clock.getVisible(), true);
    const loads = clock.webContents.loaded.length;
    const tick = rotationTick; tick(); assert.equal(rotationTick, null, 'no next countdown while renderer loads');
    await flush(); assert.equal(duration, 300000); assert.equal(clock.webContents.loaded.length, loads + 1);
    assert.ok(clock.webContents.loaded.at(-1).endsWith('clock-2.html'));
    hooks.activeViewChanged(); assert.equal(rotationTick, null); assert.equal(clock.getVisible(), false);
    await flush(); t.mock.timers.tick(25); await flush(); assert.ok(rotationTick);
    const interaction = hooks.settingsInteraction('rotation-test'); interaction(true); assert.equal(rotationTick, null);
    interaction(false); t.mock.timers.tick(25); await flush(); assert.ok(rotationTick);
    clock.webContents['before-mouse-event']({ preventDefault() {} }, { type: 'mouseDown', button: 'left', x: 10, y: 10 });
    assert.equal(rotationTick, null);
    clock.webContents['before-mouse-event']({ preventDefault() {} }, { type: 'mouseUp', button: 'left', x: 10, y: 10 });
    await flush(); assert.equal(clock.getVisible(), false, 'touch returns dashboard'); assert.equal(rotationTick, null);
    t.mock.timers.tick(25); await flush(); hooks.displayChanged('OFF'); assert.equal(rotationTick, null);
  } finally { hooks.dispose(); process.argv.splice(process.argv.indexOf(arg), 1); fs.rmSync(dir, { recursive: true }); }
});

test('production Management launcher wiring allows only its own overlay, while idle and trust remain guarded', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const handlers = new Map(), app = new EventEmitter();
  let launcher, loads = 0, reads = 0;
  class Contents extends EventEmitter {
    constructor() { super(); this.url = 'https://ha.test/lovelace'; this.mainFrame = {}; }
    getURL() { return this.url; }
    isDestroyed() { return false; }
    send() {}
    setWindowOpenHandler() {}
    async loadURL(url) { loads++; this.url = url; this.emit('did-navigate', {}, url, 200); }
    async executeJavaScript(source) {
      if (source.includes('hass?.user')) return true;
      if (source.includes('logbook/get_events')) { reads++; return { state: 'ready', events: [], received: 0 }; }
      return source.startsWith('Boolean(') ? true : 'route-loaded';
    }
  }
  class Window extends EventEmitter {
    constructor() { super(); launcher = this; this.webContents = new Contents(); this.closed = false; }
    isDestroyed() { return this.closed; }
    focus() {}
    async loadFile() {}
    close() { this.closed = true; this.emit('closed'); }
  }
  class Menu {
    constructor() { this.items = []; }
    append(item) { this.items.push(item); }
    static getApplicationMenu() { return this.menu; }
    static setApplicationMenu(menu) { this.menu = menu; }
  }
  const electron = require('electron'), previous = { ...electron };
  Object.assign(electron, { app, BrowserWindow: Window, Menu, MenuItem: class { constructor(v) { Object.assign(this, v); } } });
  touchIPC.handle = (name, fn) => handlers.set(name, fn);
  touchIPC.removeHandler = name => handlers.delete(name);
  global.WEBVIEW.viewUrls = [null, 'https://ha.test/lovelace'];
  global.WEBVIEW.views[1].webContents = new Contents();
  const management = require('./management');
  try {
    const clock = await start();
    management.init(); // Exercise the production hooks predicate, not install() with a substituted callback.
    touchIPC.emit('button-click', { sender: global.WEBVIEW.navigation.webContents }, { id: 'native-management' });
    assert.ok(launcher);
    const event = { sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame };
    const open = id => handlers.get('ha.view:management:open')(event, id);
    const activity = () => handlers.get('ha.view:management:activity')(event, 24);
    assert.equal(hooks.dashboardVisible(), false, 'general dashboard visibility remains inhibited');
    assert.equal(hooks.managementDashboardVisible(), true);
    t.mock.timers.tick(1000);
    assert.equal(hooks.idleDeadline(), false);
    assert.equal(clock.getVisible(), false, 'Management must not idle into a face');
    assert.equal((await open('devices')).state, 'route-loaded');
    assert.equal((await activity()).state, 'empty');
    assert.equal(loads, 1); assert.equal(reads, 1);
    for (const bad of [{ sender: new Contents(), senderFrame: event.senderFrame }, { sender: event.sender, senderFrame: {} }]) {
      assert.throws(() => handlers.get('ha.view:management:open')(bad, 'devices'), /Untrusted/);
      assert.throws(() => handlers.get('ha.view:management:activity')(bad, 24), /Untrusted/);
    }
    const blocked = async label => {
      const before = [loads, reads];
      assert.equal(hooks.managementDashboardVisible(), false, label);
      assert.equal((await open('entities')).state, 'hidden', label);
      assert.equal((await activity()).state, 'hidden', label);
      assert.deepEqual([loads, reads], before, 'blocked requests perform no navigation or HA read');
    };
    const other = hooks.settingsInteraction('day-schedule');
    other(true); await blocked('other settings alongside Management'); other(false);
    assert.equal(hooks.managementDashboardVisible(), true);
    global.WEBVIEW.tracker.display.on = new Date(100000);
    global.WEBVIEW.tracker.display.off = new Date(102000);
    hooks.displayChanged('OFF');
    assert.equal(launcher.isDestroyed(), true, 'OFF closes settings launcher');
    assert.throws(() => open('entities'), /Untrusted/);
    global.WEBVIEW.tracker.display.on = new Date(103000);
    hooks.displayChanged('ON', true);
    touchIPC.emit('button-click', { sender: global.WEBVIEW.navigation.webContents }, { id: 'native-management' });
    event.sender = launcher.webContents; event.senderFrame = launcher.webContents.mainFrame;
    global.WEBVIEW.tracker.display.on = new Date(103000);
    hooks.displayChanged('ON', true);
    global.WEBVIEW.viewActive = 0; await blocked('inactive native view');
    global.WEBVIEW.viewActive = 9; await blocked('missing/foreign inactive view');
    global.WEBVIEW.viewActive = 1;
    launcher.close();
    assert.equal(hooks.dashboardVisible(), true, 'closing launcher restores normal visibility');
    t.mock.timers.tick(25);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(clock.getVisible(), true);
    assert.equal(hooks.managementDashboardVisible(), false, 'face remains inhibited');
    hooks.settingsInteraction('management')(true);
    assert.equal(hooks.managementDashboardVisible(), false, 'own overlay cannot bypass a face');
  } finally {
    app.emit('will-quit');
    Object.keys(electron).forEach(key => { if (!(key in previous)) delete electron[key]; });
    Object.assign(electron, previous);
    delete touchIPC.handle; delete touchIPC.removeHandler;
  }
});

test('context priority reorder after settings close reconciles a loaded fallback clock to dashboard', async (t) => {
  useSelectedFaceSchedule(t);
  const { ContextBridge } = require('./context-bridge');
  let bridge;
  t.mock.method(ContextBridge.prototype, 'refresh', function () { bridge = this; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const sample = { connected: true, values: { 'sensor.backup_backup_manager_state': 'idle' } };
  const rules = ['clock2', 'dashboard'].map(mode => ({ entity_id: 'sensor.backup_backup_manager_state', state: 'idle', mode }));
  const clock = await start();
  clock.webContents.getURL = () => require('node:url').pathToFileURL(clock.webContents.loaded.at(-1) || '/blank').href;
  bridge.policy.update({ enabled: true, rules });
  bridge.policy.accept(sample);
  t.mock.timers.tick(25); await flush();
  assert.ok(clock.webContents.getURL().endsWith('/clock-2.html'));
  const settings = hooks.settingsInteraction('context');
  settings(true);
  bridge.policy.update({ enabled: true, rules: [...rules].reverse() });
  bridge.invalidate(); await flush();
  assert.equal(clock.getVisible(), true, 'save must not alter presentation under settings');
  settings(false);
  t.mock.timers.tick(25); await flush();
  assert.ok(clock.webContents.getURL().endsWith('/clock-2.html'), 'invalidated sample falls back before read');
  bridge.policy.accept(sample); bridge.changed(); await flush();
  assert.equal(clock.getVisible(), false, 'fresh dashboard match must hide fallback clock');
  assert.equal(global.WEBVIEW.views[1].visible, true);
  assert.equal(global.WEBVIEW.tracker.view.idle, true);
  for (const fallback of [{ connected: false }, { connected: true, values: { 'sensor.backup_backup_manager_state': 'running' } }]) {
    bridge.policy.accept(fallback); bridge.changed(); await flush();
    assert.equal(clock.getVisible(), true, 'disconnected and exact-state mismatch retain fallback');
    bridge.policy.accept(sample); bridge.changed(); await flush();
    assert.equal(clock.getVisible(), false);
  }
  bridge.policy.choose('clock2'); bridge.changed(); await flush();
  assert.ok(clock.webContents.getURL().endsWith('/clock-2.html'), 'manual choice outranks dashboard match');
});

test('production Camera launcher wiring allows only its own overlay, while idle and trust remain guarded', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const handlers = new Map(), app = new EventEmitter();
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-camera-hooks-'));
  app.getPath = () => dir;
  let launcher, loads = 0;
  class Contents extends EventEmitter {
    constructor() { super(); this.url = 'https://ha.test/lovelace'; this.mainFrame = {}; }
    getURL() { return this.url; }
    isDestroyed() { return false; }
    send() {}
    setWindowOpenHandler() {}
    async loadURL(url) { loads++; this.url = url; this.emit('did-navigate', {}, url, 200); }
    async executeJavaScript(source) { return source.includes('hass?.user') ? true : ''; }
  }
  class Window extends EventEmitter {
    constructor() { super(); launcher = this; this.webContents = new Contents(); this.closed = false; }
    isDestroyed() { return this.closed; }
    focus() {}
    async loadFile() {}
    close() { this.closed = true; this.emit('closed'); }
  }
  class Menu {
    constructor() { this.items = []; }
    append(item) { this.items.push(item); }
    static getApplicationMenu() { return this.menu; }
    static setApplicationMenu(menu) { this.menu = menu; }
  }
  const electron = require('electron'), previous = { ...electron };
  Object.assign(electron, { app, BrowserWindow: Window, Menu, MenuItem: class { constructor(v) { Object.assign(this, v); } } });
  touchIPC.handle = (name, fn) => handlers.set(name, fn);
  touchIPC.removeHandler = name => handlers.delete(name);
  global.WEBVIEW.viewUrls = [null, 'https://ha.test/lovelace'];
  global.WEBVIEW.views[1].webContents = new Contents();
  const camera = require('./camera-dashboard');
  try {
    const clock = await start();
    camera.init(); // Exercise the production hooks predicate, not install() with a substituted callback.
    touchIPC.emit('button-click', { sender: global.WEBVIEW.navigation.webContents }, { id: 'camera-dashboard' });
    assert.ok(launcher);
    const event = { sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame };
    const open = () => handlers.get('ha.view:camera:open')(event);
    handlers.get('ha.view:camera:save')(event, '/map');
    assert.equal(loads, 0, 'Save does not navigate');
    assert.equal(hooks.dashboardVisible(), false, 'general dashboard visibility remains inhibited');
    assert.equal((await open()).state, 'opened', 'explicit Open through production init must not self-inhibit');
    assert.equal(hooks.cameraDashboardVisible(), true);
    t.mock.timers.tick(1000);
    assert.equal(hooks.idleDeadline(), false);
    assert.equal(clock.getVisible(), false, 'Camera must not idle into a face');
    assert.equal((await open()).state, 'opened');
    assert.equal(loads, 2);
    for (const bad of [{ sender: new Contents(), senderFrame: event.senderFrame }, { sender: event.sender, senderFrame: {} }, { sender: event.sender }]) {
      for (const action of ['get', 'save', 'open']) assert.throws(() => handlers.get('ha.view:camera:' + action)(bad, '/map'), /Untrusted/);
    }
    const blocked = async label => {
      const before = loads;
      assert.equal(hooks.cameraDashboardVisible(), false, label);
      assert.equal((await open()).state, 'hidden', label);
      assert.equal(loads, before, 'blocked requests perform no navigation');
    };
    const other = hooks.settingsInteraction('day-schedule');
    other(true); await blocked('other settings alongside Camera'); other(false);
    assert.equal(hooks.cameraDashboardVisible(), true);
    global.WEBVIEW.tracker.display.on = new Date(100000);
    global.WEBVIEW.tracker.display.off = new Date(102000);
    hooks.displayChanged('OFF');
    assert.equal(launcher.isDestroyed(), true, 'OFF closes camera settings');
    assert.throws(() => open(), /Untrusted/);
    global.WEBVIEW.tracker.display.on = new Date(103000);
    hooks.displayChanged('ON', true);
    touchIPC.emit('button-click', { sender: global.WEBVIEW.navigation.webContents }, { id: 'camera-dashboard' });
    event.sender = launcher.webContents; event.senderFrame = launcher.webContents.mainFrame;
    global.WEBVIEW.tracker.display.on = new Date(103000);
    hooks.displayChanged('ON', true);
    global.WEBVIEW.tracker.view.idle = true; await blocked('upstream idle');
    global.WEBVIEW.tracker.view.idle = false;
    global.WEBVIEW.viewActive = 0; await blocked('inactive native view');
    global.WEBVIEW.viewUrls[9] = global.WEBVIEW.viewUrls[1]; global.WEBVIEW.viewActive = 9; await blocked('missing/foreign inactive view');
    global.WEBVIEW.viewActive = 1;
    launcher.close();
    assert.equal(hooks.dashboardVisible(), true, 'closing launcher restores normal visibility');
    t.mock.timers.tick(25);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(clock.getVisible(), true);
    assert.equal(hooks.cameraDashboardVisible(), false, 'face remains inhibited');
    hooks.settingsInteraction('camera')(true);
    assert.equal(hooks.cameraDashboardVisible(), false, 'own overlay cannot bypass a face');
  } finally {
    app.emit('will-quit');
    Object.keys(electron).forEach(key => { if (!(key in previous)) delete electron[key]; });
    Object.assign(electron, previous);
    delete touchIPC.handle; delete touchIPC.removeHandler;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unavailable Calendar daily choice keeps the native Dashboard visible across repeated idle updates', async () => {
  const day = require('./day-schedule');
  const original = day.read;
  day.read = () => ({ config: { ...day.DEFAULT, enabled: true, strategy: 'daily', rules: [{ time: '00:00', mode: 'calendar' }], calendarEntities: ['calendar.missing'] } });
  const arg = '--ha-view-day-schedule=/unused-calendar-fixture';
  process.argv.push(arg);
  // No app userData path in this fixture, so no Settings installation or file writes.
  try {
    await start();
    await new Promise(resolve => setTimeout(resolve, 35));
    hooks.upstreamIdleChanged(true);
    hooks.upstreamIdleChanged(true);
    assert.equal(hooks.dashboardVisible(), true);
    assert.equal(global.WEBVIEW.views[1].visible, true);
    assert.equal(createdViews.at(-1).getVisible(), false);
  } finally { day.read = original; process.argv.splice(process.argv.indexOf(arg), 1); }
});

test('Show a face now renders saved face directly, without chooser or idle wait', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-show-direct-'));
  const choice = path.join(dir, 'choice.json'), schedule = path.join(dir, 'schedule.json');
  const store = require('./face-changer-store');
  store.writeMode(choice, 'clock1');
  global.ARGS.ha_view_clock_face = require('./face-modes').indexOf(store.readMode(choice));
  process.argv.push(`--ha-view-day-schedule=${schedule}`);
  let showFaceNow, browserAllowed;
  const visibility = [];
  t.mock.method(require('./browser'), 'install', options => {
    browserAllowed = options.allowed;
    return Object.assign(() => {}, { sync: () => visibility.push(options.allowed()) });
  });
  t.mock.method(require('./day-schedule-settings'), 'install', options => { showFaceNow = options.showFaceNow; return () => {}; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  try {
    const clock = await start();
    assert.equal(browserAllowed(), true, 'dashboard admits launcher');
    showFaceNow();
    assert.equal(visibility.at(-1), false, 'launcher hides synchronously before face load settles');
    assert.equal(browserAllowed(), false);
    await flush();
    assert.equal(clock.webContents.loaded.at(-1), '/app/ha.view/faces/clock.html');
    assert.equal(clock.getVisible(), true);
    assert.equal(hooks.pickerReady(), false);
    assert.ok(!clock.webContents.loaded.some(file => file.endsWith('face-changer.html')));
    assert.equal(Date.now(), 100000);
    assert.equal(store.readMode(choice), 'clock1', 'manual presentation does not overwrite preference');
    hooks.settingsInteraction('day')(true);
    assert.equal(browserAllowed(), false, 'settings never admit launcher');
    hooks.settingsInteraction('day')(false);
    assert.equal(browserAllowed(), true, 'settings close returns dashboard launcher');
    showFaceNow(); await flush();
    hooks.upstreamIdleChanged(true); await flush();
    assert.equal(clock.webContents.loaded.at(-1), '/app/ha.view/faces/clock.html', 'idle does not open chooser');
  } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('show-face-now uses a real face immediately even when rotation has no eligible faces', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-show-now-'));
  const file = path.join(dir, 'schedule.json');
  require('./day-schedule').write(file, { enabled: true, strategy: 'rotation', rotationFaces: ['clock1'], rules: [] });
  process.argv.push(`--ha-view-day-schedule=${file}`);
  let showFaceNow;
  t.mock.method(require('./calendar-availability').CalendarAvailability.prototype, 'hidden', () => ['clock1']);
  t.mock.method(require('./day-schedule-settings'), 'install', options => { showFaceNow = options.showFaceNow; return () => {}; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  try {
    const clock = await start();
    clock.webContents.getURL = () => require('node:url').pathToFileURL(clock.webContents.loaded.at(-1) || '/app/dashboard').href;
    clock.webContents.executeJavaScript = async script => script.includes('getBoundingClientRect') ? {} : undefined;
    const other = hooks.settingsInteraction('context'); other(true);
    showFaceNow(); await flush(); assert.equal(clock.getVisible(), false, 'other Settings block face action');
    other(false);
    global.WEBVIEW.tracker.display.off = new Date(Number(global.WEBVIEW.tracker.display.on) + 1);
    showFaceNow(); await flush(); assert.equal(clock.getVisible(), false, 'OFF blocks face action');
    global.WEBVIEW.tracker.display.off = new Date(0);
    showFaceNow(); await flush();
    assert.equal(hooks.pickerReady(), false);
    assert.equal(clock.webContents.loaded.at(-1), '/app/ha.view/faces/clock-2.html');
    assert.equal(clock.getVisible(), true);
    assert.equal(Date.now(), 100000, 'no idle wait');
  } finally { hooks.dispose(); process.argv.pop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unauthenticated login stays accessible: idle, manual presentation and wake cannot show faces', async t => {
  const fs = require('node:fs'), os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-auth-admission-'));
  const arg = `--ha-view-day-schedule=${path.join(dir, 'schedule.json')}`;
  process.argv.push(arg);
  let manual;
  t.mock.method(require('./day-schedule-settings'), 'install', options => { manual = options.showFaceNow; return () => {}; });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const contents = new EventEmitter(); contents.focus = () => {};
  let confirmed = false;
  contents.executeJavaScript = async script => script.includes('hass?.user') ? confirmed : undefined;
  global.WEBVIEW.views[1].webContents = contents;
  const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
  try {
    const clock = await start();
    t.mock.timers.tick(300000); await flush();
    assert.equal(hooks.idleDeadline(), false);
    hooks.upstreamIdleChanged(true); manual(); await flush();
    assert.equal(clock.getVisible(), false); assert.equal(hooks.pickerReady(), false);
    assert.equal(clock.webContents.loaded.length, 0);
    assert.equal(global.WEBVIEW.views[1].visible, true, 'login remains reachable');
    confirmed = true; contents.emit('dom-ready'); await flush();
    t.mock.timers.tick(25); await flush(); assert.equal(clock.getVisible(), true);
    confirmed = false; contents.emit('did-start-navigation');
    assert.equal(clock.getVisible(), false); assert.equal(global.WEBVIEW.views[1].visible, true);
    manual(); await flush(); assert.equal(clock.getVisible(), false);
    hooks.displayChanged('ON', true);
    let consumed = false;
    hooks.pointerEvent({ preventDefault() { consumed = true; } }, { type: 'mouseUp', button: 'left' });
    assert.equal(consumed, true, 'wake release remains consumed without click-through');
    assert.equal(clock.getVisible(), false);
    hooks.dispose(); assert.equal(contents.listenerCount('dom-ready'), 0);
  } finally { hooks.dispose(); process.argv.splice(process.argv.indexOf(arg), 1); fs.rmSync(dir, { recursive: true, force: true }); }
});
