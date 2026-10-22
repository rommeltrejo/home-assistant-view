/** HA.View Weather: bounded read-only HA bridge; subscription lives in native HA. */
'use strict';
const { selectWeather, normalizeWeather } = require('./weather-data');
const KEY = '__haViewWeatherRuntime';
function readPage(key) {
  const root = document.querySelector('home-assistant'), hass = root?.hass;
  if (!hass || hass.connected !== true) return { status: 'unavailable' };
  const states = {};
  for (const id of Object.keys(hass.states || {}).filter(id => id.startsWith('weather.')).sort().slice(0, 256)) {
    const entity = hass.states[id];
    const attributes = {};
    for (const field of ['friendly_name', 'temperature', 'supported_features', 'temperature_unit', 'wind_speed_unit', 'pressure_unit', 'precipitation_unit', 'visibility_unit', 'apparent_temperature', 'humidity', 'wind_speed']) attributes[field] = entity?.attributes?.[field];
    states[id] = { entity_id: id, state: entity?.state, attributes };
  }
  const bridge = window[key];
  return { status: 'ok', states, timezone: hass.config?.time_zone,
    isDaytime: hass.states?.['sun.sun']?.state === 'above_horizon' ? true : hass.states?.['sun.sun']?.state === 'below_horizon' ? false : undefined,
    bridgeToken: bridge?.token, forecastFailed: !!bridge?.failed, forecastId: bridge?.entityId, forecastType: bridge?.type, forecast: bridge?.forecast, dailyForecast: bridge?.daily?.forecast };
}
function stopPage(key, token) {
  const bridge = window[key];
  if (!bridge || (token && bridge.token !== token)) return;
  bridge.dispose();
  delete window[key];
}
function subscribePage(key, token, entityId, type, daily = false) {
  const old = window[key];
  if (old?.token === token && old.entityId === entityId && old.type === type && !!old.daily === daily &&
      (!old.failed || Date.now() - old.failed < 30000) && (!old.daily?.failed || Date.now() - old.daily.failed < 30000)) return;
  // Cleanup is defined here so the bridge can be serialized into native HA.
  old?.dispose();
  const bridge = { token, entityId, type, closed: false, forecast: null };
  if (daily) bridge.daily = { type: 'daily', closed: false, forecast: null };
  window[key] = bridge;
  const slots = bridge.daily ? [bridge, bridge.daily] : [bridge];
  const cleanup = slot => {
    slot.closed = true; clearTimeout(slot.timer);
    const unsubscribe = slot.unsubscribe; slot.unsubscribe = null;
    if (typeof unsubscribe === 'function') { try { Promise.resolve(unsubscribe()).catch(() => {}); } catch {} }
  };
  bridge.dispose = () => { bridge.disposed = true; slots.forEach(cleanup); window.removeEventListener('pagehide', bridge.dispose); };
  window.addEventListener('pagehide', bridge.dispose, { once: true });
  const connection = document.querySelector('home-assistant')?.hass?.connection;
  for (const slot of slots) {
    if (!slot.type) continue;
    const active = () => !bridge.disposed && !slot.closed && window[key] === bridge;
    const fail = () => {
      if (!active()) return;
      slot.failed = Date.now(); slot.forecast = null; cleanup(slot);
    };
    if (typeof connection?.subscribeMessage !== 'function') { fail(); continue; }
    slot.timer = setTimeout(fail, 7000);
    const callback = event => {
      if (!active() || event?.type !== slot.type) return;
      slot.forecast = Array.isArray(event.forecast) ? event.forecast.slice(0, 192).map(row => ({ datetime: row?.datetime, temperature: row?.temperature, templow: row?.templow, condition: row?.condition, is_daytime: row?.is_daytime, precipitation_probability: row?.precipitation_probability })) : null;
      if (slot.forecast?.some(row => typeof row.temperature === 'number' && Number.isFinite(row.temperature) && typeof row.datetime === 'string' && Number.isFinite(Date.parse(row.datetime)))) clearTimeout(slot.timer);
    };
    Promise.resolve().then(() => {
      if (!active()) return null;
      return connection.subscribeMessage(callback, { type: 'weather/subscribe_forecast', entity_id: entityId, forecast_type: slot.type });
    }).then(unsubscribe => {
      if (!active()) {
        if (typeof unsubscribe === 'function') { try { Promise.resolve(unsubscribe()).catch(() => {}); } catch {} }
      } else if (typeof unsubscribe === 'function') slot.unsubscribe = unsubscribe;
      else fail();
    }).catch(fail);
  }
}

const script = (fn, ...args) => `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`;
function bounded(promise, ms = 5000) {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('weather-timeout')), ms); Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });
}
class WeatherRuntime {
  constructor({ onUnavailable = () => {} } = {}) { this.onUnavailable = onUnavailable; this.generation = 0; this.checkGeneration = 0; this.entityId = null; }
  async check(nativeContents) {
    const generation = this.generation, checkGeneration = ++this.checkGeneration;
    try {
      if (!nativeContents || nativeContents.isDestroyed?.()) return { status: 'unavailable' };
      const url = nativeContents.getURL?.();
      const snapshot = await bounded(nativeContents.executeJavaScript(script(readPage, KEY)));
      if (generation !== this.generation || checkGeneration !== this.checkGeneration || nativeContents.isDestroyed?.() || url !== nativeContents.getURL?.()) return { status: 'stale' };
      if (snapshot?.status !== 'ok') return { status: 'unavailable' };
      const entity = selectWeather(snapshot.states, this.entityId);
      const data = normalizeWeather(entity, null, snapshot);
      if (data) this.entityId = data.entityId;
      return data ? { status: 'ok', data } : { status: 'unavailable' };
    } catch { return { status: generation !== this.generation || checkGeneration !== this.checkGeneration ? 'stale' : 'error' }; }
  }
  async start(nativeContents, faceContents) {
    this.stop();
    const generation = this.generation, token = `weather-${Date.now()}-${generation}`;
    const run = { nativeContents, faceContents, token, url: nativeContents?.getURL?.(), generation };
    this.run = run;
    const valid = () => this.run === run && !nativeContents?.isDestroyed?.() && !faceContents?.isDestroyed?.() && run.url === nativeContents?.getURL?.();
    const unavailable = () => { if (this.run !== run) return; this.stop(); try { this.onUnavailable(); } catch {} };
    const poll = async () => {
      if (!valid()) { unavailable(); return { status: 'stale' }; }
      try {
        const snapshot = await bounded(nativeContents.executeJavaScript(script(readPage, KEY)));
        if (!valid()) { unavailable(); return { status: 'stale' }; }
        const entity = snapshot?.status === 'ok' ? selectWeather(snapshot.states, this.entityId) : null;
        if (!entity) { unavailable(); return { status: 'unavailable' }; }
        this.entityId = entity.entity_id;
        const { forecastType } = require('./weather-data');
        let type = forecastType(entity);
        if (run.fallbackId === entity.entity_id || (snapshot.bridgeToken === token && snapshot.forecastId === entity.entity_id && snapshot.forecastType === 'hourly' && snapshot.forecastFailed)) {
          if (entity.attributes.supported_features & 1) { type = 'daily'; run.fallbackId = entity.entity_id; }
        }
        const forecast = snapshot.bridgeToken === token && snapshot.forecastId === entity.entity_id && snapshot.forecastType === type ? snapshot.forecast : null;
        const daily = type === 'hourly' && !!(entity.attributes.supported_features & 1);
        const dailyForecast = daily && snapshot.bridgeToken === token && snapshot.forecastId === entity.entity_id && snapshot.forecastType === type ? snapshot.dailyForecast : null;
        const data = normalizeWeather(entity, forecast, { ...snapshot, forecastType: type, dailyForecast });
        await bounded(nativeContents.executeJavaScript(script(subscribePage, KEY, token, entity.entity_id, type, daily)));
        if (!valid()) { unavailable(); return { status: 'stale' }; }
        await bounded(faceContents.executeJavaScript(`window.weatherFace?.update(${JSON.stringify(data).replace(/</g, '\\u003c')})`));
        if (!valid()) { unavailable(); return { status: 'stale' }; }
        this.timer = setTimeout(poll, 1000);
        return { status: 'ok', data };
      } catch { unavailable(); return { status: 'error' }; }
    };
    return poll();
  }
  stop() {
    ++this.generation; clearTimeout(this.timer); this.timer = null;
    const run = this.run; this.run = null;
    if (run?.nativeContents && !run.nativeContents.isDestroyed?.()) {
      try { Promise.resolve(run.nativeContents.executeJavaScript(script(stopPage, KEY, run.token))).catch(() => {}); } catch {}
    }
  }
}
module.exports = { WeatherRuntime, KEY, readPage, subscribePage, stopPage, bounded };
