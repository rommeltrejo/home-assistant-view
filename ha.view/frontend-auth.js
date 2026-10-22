/** HA.View admission is based only on the active embedded HA frontend. */
'use strict';
const PROBE = `(() => {
  const hass = document.querySelector('home-assistant')?.hass;
  return Boolean(hass?.user && typeof hass.user.id === 'string' && hass.user.id.length &&
    hass.connection?.connected === true);
})()`;
class FrontendAuth {
  constructor({ contents, changed = () => {}, interval = 1000, timeout = 5000 }) {
    Object.assign(this, { contents, changed, timeout });
    this.ready = false; this.revision = 0; this.target = null; this.listeners = [];
    this.timer = setInterval(() => this.refresh(), interval); this.timer.unref?.();
    this.bind();
  }
  setReady(value) { if (this.ready !== value) { this.ready = value; this.changed(value); } }
  invalidate() { this.revision++; this.probe?.finish(false); this.setReady(false); }
  bind() {
    for (const [target, event, fn] of this.listeners) target.removeListener?.(event, fn);
    this.listeners = []; this.navigating = false; this.target = this.contents(); this.invalidate();
    if (!this.target) return;
    const reset = () => { this.navigating = true; this.invalidate(); };
    const loaded = () => { this.navigating = false; this.refresh(); };
    const start = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame === false) return;
      this.navigating = !isInPlace;
      this.invalidate();
    };
    const inPage = (_event, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      this.navigating = false; this.invalidate(); this.refresh();
    };
    const failed = (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame === false) return;
      this.navigating = false; this.invalidate();
    };
    const handlers = {
      'did-start-navigation': start, 'will-navigate': reset,
      'did-navigate-in-page': inPage, 'did-fail-load': failed,
      'render-process-gone': reset, destroyed: reset,
      'dom-ready': loaded, 'did-finish-load': loaded,
    };
    for (const [event, fn] of Object.entries(handlers)) {
      this.target.on?.(event, fn); this.listeners.push([this.target, event, fn]);
    }
    this.refresh();
  }
  refresh() {
    if (this.stopped) return Promise.resolve(false);
    if (this.contents() !== this.target) { this.bind(); return Promise.resolve(false); }
    if (this.navigating) return Promise.resolve(false);
    // executeJavaScript cannot be cancelled. Keep its slot even after timeout,
    // navigation or target replacement, until the actual Chromium read settles.
    // Retrying a hung renderer would otherwise accumulate unbounded reads.
    if (this.probe) return this.probe.result;
    const target = this.target, revision = this.revision;
    if (!target || target.isDestroyed?.()) { this.setReady(false); return Promise.resolve(false); }
    let resolve;
    const probe = { result: new Promise(r => { resolve = r; }), done: false };
    probe.finish = value => {
      if (probe.done) return;
      probe.done = true; clearTimeout(probe.timer); resolve(value);
    };
    this.probe = probe;
    probe.timer = setTimeout(() => {
      probe.finish(false);
      if (!this.stopped && revision === this.revision && target === this.contents()) this.setReady(false);
    }, this.timeout);
    probe.timer.unref?.();
    const settled = value => {
      const valid = !probe.done && !this.stopped && !this.navigating &&
        revision === this.revision && target === this.contents();
      if (this.probe === probe) this.probe = null;
      if (valid) this.setReady(value === true);
      probe.finish(valid && value === true);
    };
    try { Promise.resolve(target.executeJavaScript(PROBE)).then(settled, () => settled(false)); }
    catch { settled(false); }
    return probe.result;
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.invalidate();
    for (const [target, event, fn] of this.listeners) target.removeListener?.(event, fn);
    this.listeners = []; this.target = null;
  }
}
module.exports = { FrontendAuth, PROBE };
