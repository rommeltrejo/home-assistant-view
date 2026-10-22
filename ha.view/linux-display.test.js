'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('./linux-display');
function fixture(output = 'DPMS is Enabled\nMonitor is On', env = {}, command = 'xset') {
  const state = { support: {}, display: { status: { command, path: '/sys/class/drm/console', value: {} } } };
  const calls = [], observed = [];
  // Lexical functions model upstream: support assignment precedes log, wake and timer.
  const get = () => state.support.displayStatus ? 'UPSTREAM' : null;
  const set = (status, callback) => {
    if (!state.support.displayStatus) { callback?.(null, 'Not supported'); return; }
    calls.push(status); callback?.('reply', null);
  };
  const hardware = { getDisplayStatus: get, setDisplayStatus: set,
    async init() {
      state.support = { displayStatus: true, batteryLevel: true };
      observed.push(get());
      set('ON', () => observed.push({ timer: true, support: state.support.displayStatus, path: state.display.status.path }));
      return true;
    } };
  const original = { ...hardware };
  let queries = 0;
  const dispose = install(hardware, { platform: 'linux', env, state: () => state,
    execFileSync(file, args, options) {
      queries++; assert.equal(file, 'xset'); assert.deepEqual(args, ['-q']); assert.equal(options.env, env);
      if (output instanceof Error) throw output; return output;
    } });
  return { hardware, state, calls, observed, original, dispose, queries: () => queries, output: value => { output = value; } };
}
for (const [monitor, expected] of [['On', 'ON'], ['Off', 'OFF'], ['Standby', 'OFF'], ['Suspend', 'OFF']]) {
  test(`supported physical ${monitor}: explicit status, startup and controls preserved`, async () => {
    const f = fixture(`DPMS is Enabled\nMonitor is ${monitor}`);
    await f.hardware.init(); assert.equal(f.hardware.getDisplayStatus(), expected);
    assert.equal(f.state.support.displayStatus, true); assert.equal(f.state.display.status.path, '/sys/class/drm/console');
    assert.equal(f.observed[0], 'UPSTREAM'); assert.equal(f.observed[1].timer, true);
    const callbacks = [];
    f.hardware.setDisplayStatus('OFF', (...args) => callbacks.push(args));
    f.hardware.setDisplayStatus('ON', (...args) => callbacks.push(args));
    assert.deepEqual(f.calls, ['ON', 'OFF', 'ON']); assert.deepEqual(callbacks, [['reply', null], ['reply', null]]);
    f.dispose();
  });
}
test('confirmed absent DPMS disabled before lexical log/wake/timer, no console state or synthetic ON', async () => {
  const f = fixture('Server does not have the DPMS Extension');
  await f.hardware.init(); assert.deepEqual(f.observed, [null, { timer: true, support: false, path: null }]);
  assert.equal(f.state.support.batteryLevel, true); assert.equal(f.hardware.getDisplayStatus(), null);
  let callbacks = 0; f.hardware.setDisplayStatus('ON', (reply, error) => { callbacks++; assert.equal(reply, null); assert.match(error, /Not supported/); });
  assert.equal(callbacks, 1); assert.deepEqual(f.calls, []); assert.doesNotThrow(() => f.hardware.setDisplayStatus('OFF')); f.dispose();
});
for (const output of [new Error('query failed'), 'unrelated output']) test(`ambiguous query ${String(output)} is unknown without disabling supported controls`, async () => {
  const f = fixture(output); await f.hardware.init(); assert.equal(f.hardware.getDisplayStatus(), null);
  assert.equal(f.state.support.displayStatus, true); assert.ok(f.state.display.status.path);
  f.hardware.setDisplayStatus('OFF'); assert.deepEqual(f.calls, ['ON', 'OFF']); f.dispose();
});
for (const env of [{ XRDP_SESSION: '1' }, { XRDP_SOCKET_PATH: '/run/xrdp/sock' }, { XDG_SESSION_REMOTE: 'true' }, { DESKTOP_SESSION: 'xrdp' }]) {
  test(`remote session ${JSON.stringify(env)} never controls unrelated console backend`, async () => {
    const f = fixture('Monitor is On', env, 'ddcutil'); await f.hardware.init();
    assert.equal(f.hardware.getDisplayStatus(), null); assert.equal(f.state.display.status.path, null);
    f.hardware.setDisplayStatus('ON'); assert.deepEqual(f.calls, []); assert.equal(f.queries(), 0); f.dispose();
  });
}
test('SSH transport into supported local display preserves physical ON/OFF', async () => {
  const f = fixture('Monitor is On', { SSH_CONNECTION: 'client server', SSH_TTY: '/dev/pts/2', DISPLAY: ':0' });
  await f.hardware.init(); assert.equal(f.hardware.getDisplayStatus(), 'ON'); f.output('Monitor is Off');
  assert.equal(f.hardware.getDisplayStatus(), 'OFF'); f.hardware.setDisplayStatus('ON');
  assert.deepEqual(f.calls, ['ON', 'ON']); f.dispose();
});
test('cleanup restores exports and descriptor, is idempotent and preserves later wrappers', async () => {
  const f = fixture(); const descriptor = Object.getOwnPropertyDescriptor(f.state, 'support');
  await f.hardware.init(); assert.equal(Object.getOwnPropertyDescriptor(f.state, 'support').get, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(f.state, 'support').writable, descriptor.writable);
  assert.equal(install(f.hardware, { platform: 'linux' }), f.dispose);
  const later = () => 'later'; f.hardware.getDisplayStatus = later; f.dispose(); f.dispose();
  assert.equal(f.hardware.init, f.original.init); assert.equal(f.hardware.setDisplayStatus, f.original.setDisplayStatus);
  assert.equal(f.hardware.getDisplayStatus, later);
});
test('other platforms untouched', () => {
  const hardware = { init() {}, getDisplayStatus() {}, setDisplayStatus() {} }, original = { ...hardware };
  install(hardware, { platform: 'darwin' })(); assert.deepEqual(hardware, original);
});
test('capability loss after init returns unknown and prevents subsequent console polling', async () => {
  const f = fixture(); await f.hardware.init(); f.output('Server does not have the DPMS Extension');
  assert.equal(f.hardware.getDisplayStatus(), null); assert.equal(f.state.support.displayStatus, false);
  assert.equal(f.state.display.status.path, null); f.dispose();
});
test('upstream initialization failure restores support property and propagates error', async () => {
  const state = { support: {}, display: { status: { command: 'xset', path: '/console' } } };
  const hardware = { async init() { state.support = { displayStatus: true }; throw Error('init failure'); }, getDisplayStatus() {}, setDisplayStatus() {} };
  const dispose = install(hardware, { platform: 'linux', state: () => state, env: {}, execFileSync: () => 'Monitor is On' });
  await assert.rejects(hardware.init(), /init failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(state, 'support'), { configurable: true, enumerable: true, writable: true, value: { displayStatus: true } }); dispose();
});
