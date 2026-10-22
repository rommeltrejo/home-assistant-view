/** Read-only weather availability. Never changes HA configuration or saved face preferences. */
'use strict';
const TOAST = 'set up weather on Home Assistant';
class WeatherAvailability {
  constructor({ contents, probe, changed = () => {} }) {
    Object.assign(this, { contents, probe, changed }); this.available = false; this.generation = 0;
  }
  blocked(id) { return id === 'weather' && !this.available; }
  hidden(ids) { return [...new Set([...ids, ...(this.available ? [] : ['weather'])])]; }
  invalidate() { this.generation++; }
  setAvailable(available) {
    const next = available === true;
    if (this.available !== next) { this.available = next; this.changed(); }
  }
  async refresh() {
    const generation = ++this.generation, contents = this.contents(), url = contents?.getURL?.();
    let result;
    try { result = await this.probe(contents); } catch { result = null; }
    if (generation !== this.generation || contents !== this.contents() || contents?.isDestroyed?.() || url !== contents?.getURL?.()) return false;
    this.setAvailable(result?.status === 'ok'); return true;
  }
}
module.exports = { WeatherAvailability, TOAST };
