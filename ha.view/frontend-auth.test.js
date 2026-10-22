'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { FrontendAuth, PROBE } = require('./frontend-auth');
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const target = response => Object.assign(new EventEmitter(), { executeJavaScript: async () => response });
test('real home-assistant user and connected connection required; HTTP/login data is not authentication', () => {
  for (const hass of [undefined, {}, { user: { id: 'u' } }, { user: { id: 'u' }, connection: { connected: false } }, { user: {}, connection: { connected: true } }]) {
    assert.equal(vm.runInNewContext(PROBE, { document: { querySelector: () => ({ hass }) } }), false);
  }
  assert.equal(vm.runInNewContext(PROBE, { document: { querySelector: () => ({ hass: { user: { id: 'u' }, connection: { connected: true } } }) } }), true);
});
test('navigation, active-view replacement, logout and cleanup fail closed; stale positives rejected', async () => {
  let active = target(true); const changes = [];
  const gate = new FrontendAuth({ contents: () => active, changed: value => changes.push(value) });
  try {
    await flush(); assert.equal(gate.ready, true);
    let resolve; active.executeJavaScript = () => new Promise(r => { resolve = r; });
    const pending = gate.refresh(); active.emit('did-start-navigation');
    assert.equal(gate.ready, false); resolve(true); await pending; assert.equal(gate.ready, false);
    active = target(true); gate.bind(); await flush(); assert.equal(gate.ready, true);
    active.executeJavaScript = async () => false; await gate.refresh(); assert.equal(gate.ready, false);
    active.executeJavaScript = async () => { throw new Error('login'); }; await gate.refresh(); assert.equal(gate.ready, false);
    let late; active.executeJavaScript = () => new Promise(r => { late = r; });
    const abandoned = gate.refresh(); const old = active; active = target(false); gate.bind();
    late(true); await abandoned; await flush(); assert.equal(gate.ready, false);
    assert.equal(old.listenerCount('did-start-navigation'), 0);
    gate.stop(); assert.equal(active.listenerCount('dom-ready'), 0); assert.equal(gate.ready, false);
    assert.deepEqual(changes, [true, false, true, false]);
  } finally { gate.stop(); }
});

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('slow probes survive polling ticks; all callers share one Chromium read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const read = deferred(); let calls = 0;
  const active = target(false); active.executeJavaScript = () => { calls++; return read.promise; };
  const gate = new FrontendAuth({ contents: () => active, interval: 1000, timeout: 5000 });
  try {
    const pending = gate.refresh();
    t.mock.timers.tick(3000); await flush();
    assert.equal(calls, 1); assert.equal(gate.ready, false);
    assert.equal(gate.refresh(), pending);
    read.resolve(true); assert.equal(await pending, true); assert.equal(gate.ready, true);
  } finally { gate.stop(); }
});
test('hung read times out closed without queued Chromium retries; late positive cannot admit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const active = target(true); const gate = new FrontendAuth({ contents: () => active, timeout: 2500 });
  try {
    await flush(); assert.equal(gate.ready, true);
    const read = deferred(); let calls = 0;
    active.executeJavaScript = () => { calls++; return read.promise; };
    const pending = gate.refresh();
    t.mock.timers.tick(2500); await flush();
    assert.equal(await pending, false); assert.equal(gate.ready, false);
    for (let i = 0; i < 20; i++) { t.mock.timers.tick(1000); await flush(); await gate.refresh(); }
    assert.equal(calls, 1, 'timing out does not cancel the underlying read or free its slot');
    read.resolve(true); await flush(); assert.equal(gate.ready, false);
    active.executeJavaScript = async () => true;
    assert.equal(await gate.refresh(), true, 'recovery requires a fresh completed read');
  } finally { gate.stop(); }
});
test('subframes ignored; main SPA routes revoke readiness but need no main dom-ready', async () => {
  const active = target(true); const gate = new FrontendAuth({ contents: () => active });
  try {
    await flush(); assert.equal(gate.ready, true);
    active.emit('did-start-navigation', {}, 'https://ha/frame', false, false);
    active.emit('did-navigate-in-page', {}, 'https://ha/frame#x', false);
    active.emit('did-fail-load', {}, -3, 'aborted', 'https://ha/frame', false);
    assert.equal(gate.ready, true); assert.equal(gate.navigating, false);
    active.emit('did-start-navigation', {}, 'https://ha/dashboard/other', true, true);
    assert.equal(gate.ready, false); assert.equal(gate.navigating, false);
    await gate.refresh(); assert.equal(gate.ready, true, 'SPA can authenticate without dom-ready');
    active.executeJavaScript = async () => false;
    active.emit('did-navigate-in-page', {}, 'https://ha/auth/authorize', true);
    await flush(); assert.equal(gate.ready, false, 'in-place logout is freshly checked');
    active.emit('did-start-navigation', {}, 'https://ha/', false, true);
    assert.equal(gate.navigating, true); assert.equal(await gate.refresh(), false);
    active.executeJavaScript = async () => true;
    active.emit('dom-ready'); await flush(); assert.equal(gate.ready, true);
    active.emit('did-start-navigation', {}, 'https://ha/bad', false, true);
    active.emit('did-fail-load', {}, -3, 'aborted', 'https://ha/bad', true);
    assert.equal(gate.navigating, false); assert.equal(gate.ready, false);
    await gate.refresh(); assert.equal(gate.ready, true, 'failed/aborted navigation cannot strand polling');
  } finally { gate.stop(); }
});
test('outstanding slot survives target switch and disposal; stale responses never authenticate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const read = deferred(); let oldCalls = 0, newCalls = 0;
  const old = target(false); old.executeJavaScript = () => { oldCalls++; return read.promise; };
  let active = old;
  const gate = new FrontendAuth({ contents: () => active, timeout: 2000 });
  const pending = gate.refresh();
  active = target(true); active.executeJavaScript = async () => { newCalls++; return true; };
  gate.bind(); assert.equal(await pending, false);
  t.mock.timers.tick(10000); await flush();
  assert.equal(oldCalls, 1); assert.equal(newCalls, 0); assert.equal(gate.ready, false);
  assert.equal(old.listenerCount('did-start-navigation'), 0);
  read.resolve(true); await flush(); assert.equal(gate.ready, false);
  assert.equal(await gate.refresh(), true); assert.equal(newCalls, 1);
  const late = deferred(); active.executeJavaScript = () => late.promise;
  const abandoned = gate.refresh(); gate.stop(); assert.equal(await abandoned, false);
  late.resolve(true); await flush(); t.mock.timers.tick(10000);
  assert.equal(gate.ready, false); assert.equal(active.listenerCount('did-navigate-in-page'), 0);
});
