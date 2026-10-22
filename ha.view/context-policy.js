/** HA.View read-only context policy. Times and samples are injectable. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULT = { enabled: false, rules: [] };
const FRESH_MS = 15000, MANUAL_MS = 15 * 60 * 1000;
function validate(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.rules) || value.rules.length > 32) throw Error('Expected enabled boolean and at most 32 ordered rules.');
  const rules = value.rules.map(r => {
    if (!r || typeof r.entity_id !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(r.entity_id) || r.entity_id.length > 255 || typeof r.state !== 'string' || !r.state.length || r.state.length > 255 || ['unknown', 'unavailable'].includes(r.state) || !['dashboard', 'clock1', 'clock2'].includes(r.mode)) throw Error('Each rule needs an entity_id, exact nonempty state (not unknown/unavailable), and dashboard/clock1/clock2.');
    return { entity_id: r.entity_id, state: r.state, mode: r.mode };
  });
  if (value.enabled && !rules.length) throw Error('Enable requires at least one rule.');
  return { enabled: value.enabled, rules };
}
function read(file) {
  try { return { config: validate(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null }; }
  catch (e) { return { config: { enabled: false, rules: [] }, error: e.code === 'ENOENT' ? null : e.message }; }
}
function write(file, value) {
  const config = validate(value); fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return config;
}
class ContextPolicy {
  constructor({ config = DEFAULT, now = Date.now } = {}) { this.now = now; this.config = validate(config); this.sample = null; this.manual = null; }
  update(config) { this.config = validate(config); this.sample = null; this.manual = null; }
  ids() { return this.config.enabled ? [...new Set(this.config.rules.map(r => r.entity_id))] : []; }
  accept(sample) {
    // Copy only requested scalar values. Never retain hass, attributes or credentials.
    const values = Object.create(null);
    if (sample?.connected === true && sample.values && typeof sample.values === 'object') {
      for (const id of this.ids()) if (typeof sample.values[id] === 'string' && sample.values[id].length <= 255 && !['unknown', 'unavailable'].includes(sample.values[id])) values[id] = sample.values[id];
      this.sample = { at: this.now(), values };
    } else this.sample = null;
  }
  choose(face) { if (!this.config.enabled) return; const mode = require('./face-modes').fromLegacyFace(face, ''); if (!mode) return; this.manual = { mode, until: this.now() + MANUAL_MS }; }
  mode(fallback = null) {
    if (!this.config.enabled) { this.manual = null; return fallback; }
    if (this.manual && this.now() < this.manual.until) return this.manual.mode;
    this.manual = null;
    if (this.config.enabled && this.sample && this.now() >= this.sample.at && this.now() - this.sample.at < FRESH_MS) {
      const rule = this.config.rules.find(r => this.sample.values[r.entity_id] === r.state);
      if (rule) return rule.mode;
    }
    return fallback;
  }
}
module.exports = { DEFAULT, FRESH_MS, MANUAL_MS, validate, read, write, ContextPolicy };
