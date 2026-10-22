/** HA.View bounded read of the authenticated embedded HA frontend. No API writes. */
'use strict';
const POLL_MS = 5000, READ_TIMEOUT_MS = 2000;
function script(ids) {
  return `(() => { try {
    const root = document.querySelector('home-assistant');
    const hass = root && root.hass;
    if (!hass || hass.connected !== true || !hass.states) return {connected:false};
    const values = Object.create(null);
    for (const id of ${JSON.stringify(ids)}) {
      const state = hass.states[id]?.state;
      if (typeof state === 'string' && state.length <= 255) values[id] = state;
    }
    return {connected:true,values};
  } catch (_) { return {connected:false}; } })()`;
}
class ContextBridge {
  constructor({ policy, contents, needed, changed, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { policy, contents, needed, changed, setTimer, clearTimer }); this.generation = 0; this.timer = null; this.pending = false; this.stopped = false;
  }
  refresh() {
    this.clearTimer(this.timer); this.timer = null;
    if (this.stopped) return;
    this.changed(); // Also reconciles manual expiry / interaction that previously deferred application.
    if (!this.needed() || !this.policy.ids().length) {
      this.policy.accept(null);
      if (this.policy.config.enabled || this.policy.manual) this.schedule();
      return;
    }
    if (this.pending) { this.policy.accept(null); this.changed(); this.schedule(); return; }
    const generation = this.generation, contents = this.contents();
    if (!contents || contents.isDestroyed?.()) { this.policy.accept(null); this.changed(); this.schedule(); return; }
    this.pending = true;
    let timeout;
    const read = Promise.resolve().then(() => contents.executeJavaScript(script(this.policy.ids())));
    // Keep pending true until Chromium actually resolves: no accumulating hung reads.
    read.finally(() => { this.pending = false; }).catch(() => {});
    Promise.race([read, new Promise(resolve => { timeout = this.setTimer(() => resolve(null), READ_TIMEOUT_MS); })]).then(sample => {
      if (this.stopped || generation !== this.generation || contents !== this.contents()) return;
      this.policy.accept(sample); this.changed();
    }).catch(() => { if (!this.stopped && generation === this.generation) { this.policy.accept(null); this.changed(); } }).finally(() => { this.clearTimer(timeout); if (!this.stopped && generation === this.generation) this.schedule(); });
  }
  schedule() { this.clearTimer(this.timer); this.timer = this.setTimer(() => this.refresh(), POLL_MS); this.timer?.unref?.(); }
  invalidate() { this.generation++; this.policy.accept(null); this.changed(); this.refresh(); }
  stop() { this.stopped = true; this.generation++; this.clearTimer(this.timer); this.policy.accept(null); }
}
module.exports = { ContextBridge, script, POLL_MS, READ_TIMEOUT_MS };
