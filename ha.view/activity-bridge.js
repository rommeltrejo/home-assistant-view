/** HA.View one-shot read through authenticated frontend hass.callWS; never stores hass. */
'use strict';
const { requestWindow, summarize, MAX_EVENTS } = require('./activity-policy');
const READ_TIMEOUT_MS = 10000;
function script(hours, now) {
  const window = requestWindow(now, hours);
  return `(async () => { try { const app = document.querySelector('home-assistant'); const hass = app && app.hass; if (!hass || hass.connected !== true || typeof hass.callWS !== 'function') return { state: 'login' }; const response = await hass.callWS({ type: 'logbook/get_events', start_time: ${JSON.stringify(window.start_time)}, end_time: ${JSON.stringify(window.end_time)} }); if (app !== document.querySelector('home-assistant') || hass !== app.hass || hass.connected !== true) return { state: 'login' }; if (!Array.isArray(response)) return { state: 'error' }; return { state: 'ready', received: response.length, truncated: response.length > 500, events: response.slice(0, ${MAX_EVENTS}).map(item => { if (!item || typeof item !== 'object') return null; const out = {}; for (const key of ['when','name','entity_id','domain','message','state']) if (typeof item[key] === 'string' || typeof item[key] === 'number') out[key] = typeof item[key] === 'string' ? item[key].slice(0,512) : item[key]; return out; }).filter(Boolean) }; } catch (_) { return { state: 'error' }; } })()`;
}
class ActivityBridge {
  constructor({ contents, visible, changed, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) { Object.assign(this,{contents,visible,changed,now,setTimer,clearTimer}); this.pending = false; this.generation = 0; this.stopped = false; this.state = { state:'idle' }; }
  snapshot() { return { ...this.state }; }
  async read(hours = 24) {
    if (this.stopped) return this.snapshot();
    if (!this.visible()) { this.state = { state:'hidden' }; this.changed(this.snapshot()); return this.snapshot(); }
    if (this.pending) return this.snapshot();
    let bounds; try { bounds = requestWindow(this.now(), hours); } catch (_) { this.state = { state:'error' }; this.changed(this.snapshot()); return this.snapshot(); }
    const wc = this.contents(); const url = wc?.getURL?.(); if (!wc || wc.isDestroyed?.()) { this.state={state:'login'}; this.changed(this.snapshot()); return this.snapshot(); }
    this.pending = true; const generation = this.generation;
    this.state = { state:'loading' }; this.changed(this.snapshot());
    let deadline;
    const read = Promise.resolve().then(() => {
      if (generation !== this.generation || wc !== this.contents() || !this.visible() || wc.getURL?.() !== url) return { state:'hidden' };
      return wc.executeJavaScript(script(hours, new Date(bounds.end_time).getTime()));
    });
    // The outstanding flag belongs to the actual Chromium promise, not the UI timeout.
    read.finally(() => { this.pending = false; }).catch(() => {});
    const timeout = new Promise(resolve => { deadline = this.setTimer(() => resolve(null), READ_TIMEOUT_MS); });
    try {
      const result = await Promise.race([read, timeout]);
      if (generation !== this.generation || this.stopped) return this.snapshot();
      if (wc !== this.contents() || wc.getURL?.() !== url || !this.visible()) this.state = { state:'hidden' };
      else if (result === null) this.state = { state:'error' };
      else if (result?.state === 'login') this.state = { state:'login' };
      else if (result?.state !== 'ready') this.state = { state:'error' };
      else {
        const clean = summarize(result.events, { start: new Date(bounds.start_time).getTime(), end: new Date(bounds.end_time).getTime() });
        this.state = { state: clean.count ? 'ready' : 'empty', ...clean, truncated: clean.truncated || result.truncated === true, received: Number.isInteger(result.received) ? result.received : result.events.length, start: bounds.start_time, end: bounds.end_time };
      }
    } catch (_) { if (generation === this.generation && !this.stopped) this.state = { state:'error' }; }
    finally { this.clearTimer(deadline); }
    if (generation === this.generation && !this.stopped) this.changed(this.snapshot());
    return this.snapshot();
  }
  invalidate() { this.generation++; this.state={state:'idle'}; this.changed(this.snapshot()); }
  stop() { this.stopped=true; this.invalidate(); }
}
module.exports = { ActivityBridge, script, READ_TIMEOUT_MS };
