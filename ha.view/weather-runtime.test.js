'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { WeatherRuntime, readPage, subscribePage, stopPage, KEY } = require('./weather-runtime');
const entity = { entity_id: 'weather.home', state: 'sunny', attributes: { temperature: 21, supported_features: 3 } };
function harness(subscribeMessage) {
  const window = { addEventListener() {}, removeEventListener() {} };
  const hass = { connected: true, states: { 'weather.home': entity }, config: { time_zone: 'UTC' }, connection: { subscribeMessage } };
  const context = vm.createContext({ window, document: { querySelector: () => ({ hass }) }, setTimeout, clearTimeout, Promise, Date });
  const contents = { getURL: () => 'https://ha.local/', isDestroyed: () => false, executeJavaScript: async code => vm.runInContext(code, context) };
  return { window, hass, context, contents };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('check reads only, retains entity and requires true connection', async () => {
  let calls = 0; const h = harness(() => { calls++; }); const runtime = new WeatherRuntime();
  assert.equal((await runtime.check(h.contents)).status, 'ok'); assert.equal(runtime.entityId, entity.entity_id); assert.equal(calls, 0);
  h.hass.connected = undefined; assert.equal((await runtime.check(h.contents)).status, 'unavailable');
});
test('subscription serializes probability, stop cleans, late callbacks ignored', async () => {
  let callback, cleaned = 0;
  const h = harness(async cb => { callback = cb; return () => { cleaned++; }; });
  const invoke = (fn, ...args) => vm.runInContext(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`, h.context);
  invoke(subscribePage, KEY, 'one', entity.entity_id, 'hourly'); await tick();
  callback({ type: 'hourly', forecast: [{ datetime: new Date().toISOString(), temperature: 22, precipitation_probability: 45 }] });
  assert.equal(invoke(readPage, KEY).forecast[0].precipitation_probability, 45);
  invoke(stopPage, KEY, 'one'); assert.equal(cleaned, 1); callback({ type: 'hourly', forecast: [] }); assert.equal(h.window[KEY], undefined);
});
test('pending subscription unsubscribes on late resolution after stop', async () => {
  let resolve, cleaned = 0;
  const h = harness(() => new Promise(r => { resolve = r; }));
  const runtime = new WeatherRuntime(); const face = { isDestroyed: () => false, executeJavaScript: async () => {} };
  await runtime.start(h.contents, face); await tick(); runtime.stop(); resolve(() => { cleaned++; }); await tick(); assert.equal(cleaned, 1);
});
test('hourly rejection falls back daily and current stays valid', async () => {
  const calls = []; const h = harness(async (cb, message) => { calls.push(message); throw Error('unsupported'); });
  const runtime = new WeatherRuntime(); const face = { isDestroyed: () => false, executeJavaScript: async () => {} };
  assert.equal((await runtime.start(h.contents, face)).status, 'ok'); await tick();
  await new Promise(resolve => setTimeout(resolve, 1100)); await tick(); runtime.stop();
  assert.ok(calls.some(message => message.forecast_type === 'daily'));
});
test('stopped stale native read never renders', async () => {
  let resolve, renders = 0;
  const contents = { getURL: () => 'ha', isDestroyed: () => false, executeJavaScript: code => code.includes('function readPage') ? new Promise(r => { resolve = r; }) : Promise.resolve() };
  const runtime = new WeatherRuntime(); const started = runtime.start(contents, { isDestroyed: () => false, executeJavaScript: async () => { renders++; } });
  runtime.stop(); resolve({ status: 'ok', states: { weather: entity } }); assert.equal((await started).status, 'stale'); assert.equal(renders, 0);
});
const invokePage = (h, fn, ...args) => vm.runInContext(`(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`, h.context);
test('simultaneous hourly and daily official subscriptions remain separate and clean once', async () => {
  const callbacks = {}, calls = [], cleaned = [];
  const h = harness(async (cb, msg) => { calls.push(msg); callbacks[msg.forecast_type] = cb; return () => { cleaned.push(msg.forecast_type); }; });
  invokePage(h, subscribePage, KEY, 'dual', entity.entity_id, 'hourly', true); await tick();
  assert.deepEqual(calls.map(m => m.type), ['weather/subscribe_forecast', 'weather/subscribe_forecast']);
  callbacks.hourly({ type: 'hourly', forecast: [{ datetime: new Date().toISOString(), temperature: 21 }] });
  callbacks.daily({ type: 'daily', forecast: [{ datetime: new Date().toISOString(), temperature: 26, templow: 12 }] });
  const snapshot = invokePage(h, readPage, KEY);
  assert.equal(snapshot.forecast[0].temperature, 21); assert.equal(snapshot.dailyForecast[0].templow, 12);
  const bridge = h.window[KEY]; bridge.dispose(); invokePage(h, stopPage, KEY, 'dual');
  assert.deepEqual(cleaned.sort(), ['daily', 'hourly']);
});
test('daily permission rejection does not fail hourly or retry another endpoint', async () => {
  let hourly; const calls = [];
  const h = harness(async (cb, msg) => { calls.push(msg); if (msg.forecast_type === 'daily') throw Error('unauthorized'); hourly = cb; return () => {}; });
  invokePage(h, subscribePage, KEY, 'permissions', entity.entity_id, 'hourly', true); await tick();
  hourly({ type: 'hourly', forecast: [{ datetime: new Date().toISOString(), temperature: 21 }] });
  assert.equal(invokePage(h, readPage, KEY).forecastFailed, false);
  assert.equal(h.window[KEY].daily.closed, true); assert.equal(calls.length, 2);
  invokePage(h, subscribePage, KEY, 'permissions', entity.entity_id, 'hourly', true); await tick(); assert.equal(calls.length, 2);
  invokePage(h, stopPage, KEY);
});
test('both pending handles clean on late resolution after replacement despite throwing cleanup', async () => {
  const pending = [], cleaned = [];
  const h = harness((cb, msg) => new Promise(resolve => pending.push({ cb, msg, resolve })));
  invokePage(h, subscribePage, KEY, 'old', entity.entity_id, 'hourly', true); await tick();
  invokePage(h, subscribePage, KEY, 'new', entity.entity_id, null); await tick();
  for (const p of pending) { p.cb({ type: p.msg.forecast_type, forecast: [{ datetime: new Date().toISOString(), temperature: 99 }] }); p.resolve(() => { cleaned.push(p.msg.forecast_type); throw Error('cleanup'); }); }
  await tick(); assert.deepEqual(cleaned.sort(), ['daily', 'hourly']); assert.equal(h.window[KEY].forecast, null);
  invokePage(h, stopPage, KEY);
});
test('daily initial-data timeout is independent and cleans a late handle', async () => {
  const timers = [], callbacks = {}; let dailyResolve, cleaned = 0;
  const h = harness((cb, msg) => { callbacks[msg.forecast_type] = cb; return msg.forecast_type === 'daily' ? new Promise(resolve => { dailyResolve = resolve; }) : Promise.resolve(() => {}); });
  h.context.setTimeout = (cb, ms) => { assert.equal(ms, 7000); timers.push(cb); return timers.length; };
  h.context.clearTimeout = () => {};
  invokePage(h, subscribePage, KEY, 'timeout', entity.entity_id, 'hourly', true); await tick();
  callbacks.hourly({ type: 'hourly', forecast: [{ datetime: new Date().toISOString(), temperature: 21 }] });
  timers[1](); dailyResolve(() => { cleaned++; }); await tick();
  assert.equal(cleaned, 1); assert.equal(invokePage(h, readPage, KEY).forecastFailed, false);
  callbacks.daily({ type: 'daily', forecast: [{ datetime: new Date().toISOString(), temperature: 99 }] });
  assert.equal(invokePage(h, readPage, KEY).dailyForecast, null); invokePage(h, stopPage, KEY);
});
test('stop and overlapping checks prevent stale retained-entity mutation', async () => {
  const reads = []; const contents = { getURL: () => 'ha', isDestroyed: () => false, executeJavaScript: () => new Promise(resolve => reads.push(resolve)) };
  const runtime = new WeatherRuntime(); runtime.entityId = 'weather.retained';
  const stopped = runtime.check(contents); runtime.stop(); reads.shift()({ status: 'ok', states: { home: entity } });
  assert.equal((await stopped).status, 'stale'); assert.equal(runtime.entityId, 'weather.retained');
  const first = runtime.check(contents), second = runtime.check(contents);
  reads[1]({ status: 'ok', states: { newer: { ...entity, entity_id: 'weather.newer' } } }); await second;
  reads[0]({ status: 'ok', states: { home: entity } }); assert.equal((await first).status, 'stale'); assert.equal(runtime.entityId, 'weather.newer');
});
test('runtime renders hourly cards with secondary daily today high and low', async () => {
  const now = new Date().toISOString(); let rendered;
  const h = harness(async (cb, msg) => {
    cb({ type: msg.forecast_type, forecast: [{ datetime: now, temperature: msg.forecast_type === 'daily' ? 26 : 21, templow: msg.forecast_type === 'daily' ? 12 : -99 }] });
    return () => {};
  });
  const faceContext = vm.createContext({ window: { weatherFace: { update: data => { rendered = data; } } } });
  const runtime = new WeatherRuntime();
  try {
    await runtime.start(h.contents, { isDestroyed: () => false, executeJavaScript: async code => vm.runInContext(code, faceContext) });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(rendered.forecastType, 'hourly'); assert.equal(rendered.forecast[0].temperature, 21);
    assert.equal(rendered.high, 26); assert.equal(rendered.low, 12);
  } finally { runtime.stop(); }
});
test('disconnection ends active runtime once, cleans both subscriptions, and reconnect reads recover', async () => {
 let cleaned=0,lost=0;
 const h=harness(async(cb,msg)=>{cb({type:msg.forecast_type,forecast:[{datetime:new Date().toISOString(),temperature:21}]});return()=>{cleaned++;};});
 const runtime=new WeatherRuntime({onUnavailable:()=>lost++});
 try {
  await runtime.start(h.contents,{isDestroyed:()=>false,executeJavaScript:async()=>{}});await tick();
  h.hass.connected=false;await new Promise(r=>setTimeout(r,1100));await tick();
  assert.equal(lost,1);assert.equal(cleaned,2);assert.equal(runtime.timer,null);
  assert.equal((await runtime.check(h.contents)).status,'unavailable');assert.equal(lost,1);
  h.hass.connected=true;assert.equal((await runtime.check(h.contents)).status,'ok');
 } finally {runtime.stop();}
});
