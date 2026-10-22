'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { ContextPolicy, FRESH_MS, MANUAL_MS, validate, read, write } = require('./context-policy');
const { ContextBridge, script } = require('./context-bridge');
const config = { enabled: true, rules: [{ entity_id: 'binary_sensor.a', state: 'on', mode: 'clock2' }, { entity_id: 'sensor.b', state: 'home', mode: 'dashboard' }] };
test('exact ordered matches; missing/auth/disconnected/unknown/unavailable and freshness fall back', () => {
  let now = 0; const p = new ContextPolicy({ config, now: () => now });
  assert.equal(p.mode('clock1'), 'clock1');
  p.accept({ connected: true, values: { 'binary_sensor.a': 'on', 'sensor.b': 'home' } }); assert.equal(p.mode('clock1'), 'clock2');
  now = FRESH_MS; assert.equal(p.mode('clock1'), 'clock1');
  p.accept({ connected: true, values: { 'binary_sensor.a': 'ON', 'sensor.b': 'home' } }); assert.equal(p.mode(), 'dashboard');
  for (const value of ['unknown', 'unavailable', undefined]) { p.accept({ connected: true, values: { 'binary_sensor.a': value } }); assert.equal(p.mode(), null); }
  p.accept({ connected: true, values: { 'binary_sensor.a': 'on' } }); p.accept({ connected: false }); assert.equal(p.mode('dashboard'), 'dashboard');
  p.accept(null); assert.equal(p.mode(), null);
});
test('manual wins then expires at exact deadline, disabled policy is inert; clock rollback invalidates sample', () => {
  let now = 100; const p = new ContextPolicy({ config, now: () => now });
  p.accept({ connected: true, values: { 'binary_sensor.a': 'on' } }); p.choose(1); assert.equal(p.mode(), 'clock1');
  now += MANUAL_MS; p.accept({ connected: true, values: { 'binary_sensor.a': 'on' } }); assert.equal(p.mode(), 'clock2');
  now--; assert.equal(p.mode('dashboard'), 'dashboard'); p.update({ enabled: false, rules: config.rules }); assert.deepEqual(p.ids(), []);
});
test('validation and normalized atomic persistence never store extra values', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-context-unit-')), file = path.join(dir, 'config.json');
  try {
    assert.equal(read(file).config.enabled, false);
    for (const invalid of [{ enabled: true, rules: [] }, { enabled: true, rules: [{ ...config.rules[0], state: 'unknown' }] }, { enabled: true, rules: [{ ...config.rules[0], entity_id: "x');evil()" }] }]) assert.throws(() => validate(invalid));
    write(file, { ...config, token: 'should not persist' }); assert.deepEqual(read(file).config, config); assert.equal(fs.readFileSync(file, 'utf8').includes('token'), false);
    fs.writeFileSync(file, 'bad'); assert.equal(read(file).config.enabled, false);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('frontend bridge reads only configured scalar states; no attributes/services/auth reads', () => {
  let reads = [];
  const states = new Proxy({ 'binary_sensor.a': { state: 'on', get attributes() { throw Error('attributes accessed'); } } }, { get: (obj, id) => { reads.push(id); return obj[id]; } });
  const hass = { connected: true, states, get auth() { throw Error('auth accessed'); }, callService() { throw Error('write'); } };
  const result = vm.runInNewContext(script(['binary_sensor.a']), { document: { querySelector: () => ({ hass }) } });
  assert.equal(result.values['binary_sensor.a'], 'on'); assert.deepEqual(reads, ['binary_sensor.a']);
  for (const root of [null, {}, { hass: { connected: false, states } }]) assert.equal(vm.runInNewContext(script([]), { document: { querySelector: () => root } }).connected, false);
});
test('disabled does not poll; hung read times out without concurrent reads; stop rejects late samples', async () => {
  let calls = 0, resolve, queue = [], now = 0;
  const p = new ContextPolicy({ now: () => now });
  const contents = { executeJavaScript: () => { calls++; return new Promise(r => { resolve = r; }); } };
  const b = new ContextBridge({ policy: p, contents: () => contents, needed: () => true, changed: () => {}, setTimer: (fn, ms) => { const t = { fn, ms }; queue.push(t); return t; }, clearTimer: t => { queue = queue.filter(x => x !== t); } });
  b.refresh(); assert.equal(queue.length, 0); assert.equal(calls, 0);
  p.update(config); b.refresh(); await Promise.resolve(); assert.equal(calls, 1);
  queue.find(t => t.ms === 2000).fn(); await new Promise(r => setImmediate(r));
  b.refresh(); await Promise.resolve(); assert.equal(calls, 1); assert.equal(p.mode(), null);
  b.stop(); resolve({ connected: true, values: { 'binary_sensor.a': 'on' } }); await new Promise(r => setImmediate(r)); assert.equal(p.mode(), null); assert.equal(queue.length, 0);
});

test('disabled context choose/update cannot override accepted day-boundary semantics', () => {
  const { DaySchedule } = require('./day-schedule');
  let now = new Date(2026, 9, 14, 17, 59, 0).getTime();
  const day = new DaySchedule({config:{enabled:true,rules:[{time:'00:00',mode:'clock1'},{time:'18:00',mode:'dashboard'}]},now:()=>new Date(now)});
  const p = new ContextPolicy({now:()=>now});
  p.choose(2); day.choose(2); assert.equal(p.manual,null); assert.equal(p.mode(day.mode()),'clock2');
  now = new Date(2026, 9, 14, 18, 0, 0).getTime(); assert.equal(p.mode(day.mode()),'dashboard');
  p.update(config); p.choose(1); now += 60000; assert.equal(p.mode(day.mode()),'clock1','enabled context manual wins across day boundary');
  now += MANUAL_MS; assert.equal(p.mode(day.mode()),'dashboard','fixed expiry falls back to current day period');
  p.choose(2); p.update({enabled:false,rules:[]}); assert.equal(p.mode(day.mode()),'dashboard','disabling clears override');
});
test('bridge invalidate/config and active view changes reject late pending results', async () => {
  let now = 0, resolve, active = {executeJavaScript:()=>new Promise(r=>{resolve=r;})}, timers = [];
  const p = new ContextPolicy({config,now:()=>now});
  const b = new ContextBridge({policy:p,contents:()=>active,needed:()=>true,changed:()=>{},setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimer:t=>{timers=timers.filter(x=>x!==t);}});
  b.refresh(); await Promise.resolve(); const late = resolve;
  active = {executeJavaScript:async()=>({connected:true,values:{'binary_sensor.a':'on'}})};
  b.invalidate(); assert.equal(p.mode(),null); assert.equal(b.pending,true);
  late({connected:true,values:{'binary_sensor.a':'on'}}); await new Promise(r=>setImmediate(r)); assert.equal(p.mode(),null,'old active view sample discarded');
  b.refresh(); await new Promise(r=>setImmediate(r)); assert.equal(p.mode(),'clock2','new active view read works');
  active = {executeJavaScript:()=>new Promise(r=>{resolve=r;})}; b.invalidate(); await Promise.resolve();
  p.update({enabled:false,rules:[]}); b.invalidate(); resolve({connected:true,values:{'binary_sensor.a':'on'}}); await new Promise(r=>setImmediate(r)); assert.equal(p.mode(),null);
  b.stop(); assert.equal(timers.length,0);
});
