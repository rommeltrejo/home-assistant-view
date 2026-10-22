/** HA.View local, daily idle presentation policy. No timers run while disabled. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const modes = require('./face-modes');
const DEFAULT = { enabled: true, strategy: 'rotation', rules: [], idleMs: 120000, calendarEntities: [], rotationMs: 300000, rotationFaces: modes.FACE_IDS.filter(id => id !== 'weather') };
const MAX_CALENDARS = 8;
function validate(value) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !Array.isArray(value.rules) || value.rules.length > 1440) throw new Error('Expected enabled boolean and rules array (maximum 1440).');
  const idleMs = value.idleMs === undefined ? DEFAULT.idleMs : value.idleMs;
  if (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < 6000 || idleMs > 86400000) throw new Error('Inactivity timer must be between 0.1 and 1440 minutes.');
  // Saved schedules without a strategy predate rotation and remain daily.
  const strategy = value.strategy ?? 'daily';
  if (!['daily', 'rotation'].includes(strategy)) throw new Error('Choose daily or rotation strategy.');
  const rotationMs = value.rotationMs === undefined ? DEFAULT.rotationMs : value.rotationMs;
  if (typeof rotationMs !== 'number' || !Number.isFinite(rotationMs) || rotationMs < 6000 || rotationMs > 86400000) throw new Error('Rotation interval must be between 0.1 and 1440 minutes.');
  const rotationFaces = value.rotationFaces === undefined ? [...DEFAULT.rotationFaces] : value.rotationFaces;
  if (!Array.isArray(rotationFaces) || !rotationFaces.length || rotationFaces.length > modes.FACE_IDS.length || new Set(rotationFaces).size !== rotationFaces.length || rotationFaces.some(face => !modes.FACE_IDS.includes(face))) throw new Error('Choose unique ordered rotation faces (not Dashboard).');
  const seen = new Set();
  const rules = value.rules.map(rule => {
    if (!rule || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time) || !modes.SCHEDULE_MODES.includes(rule.mode)) throw new Error('Each rule needs HH:MM local time and a supported idle face.');
    if (seen.has(rule.time)) throw new Error(`Duplicate time: ${rule.time}`);
    seen.add(rule.time);
    return { time: rule.time, mode: rule.mode };
  }).sort((a, b) => a.time.localeCompare(b.time));
  if (value.enabled && strategy === 'daily' && !rules.length) throw new Error('An enabled schedule needs at least one rule.');
  const rawCalendars = value.calendarEntities === undefined ? [] : value.calendarEntities;
  if (!Array.isArray(rawCalendars) || rawCalendars.length > MAX_CALENDARS) throw new Error(`Choose no more than ${MAX_CALENDARS} calendar entities.`);
  const calendarEntities = [...new Set(rawCalendars)];
  if (calendarEntities.some(id => typeof id !== 'string' || !/^calendar\.[a-z0-9_]+$/.test(id) || id.length > 255)) throw new Error('Calendar entity IDs must be valid calendar.* entities.');
  return { enabled: value.enabled, strategy, rules, idleMs, calendarEntities, rotationMs, rotationFaces: [...rotationFaces] };
}
function read(file) {
  try { return { config: validate(JSON.parse(fs.readFileSync(file, 'utf8'))), error: null }; }
  catch (error) { return { config: { ...DEFAULT, enabled: error.code === 'ENOENT', rules: [], rotationFaces: [...DEFAULT.rotationFaces] }, error: error.code === 'ENOENT' ? null : error.message }; }
}
function write(file, value) {
  const config = validate(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  return config;
}
function period(config, date) {
  if (!config.enabled || config.strategy === 'rotation') return null;
  // Enumerate civil days rather than adding 24 hours: DST and midnight are local.
  const candidates = [];
  for (const offset of [-1, 0, 1]) for (const rule of config.rules) {
    const [h, m] = rule.time.split(':').map(Number);
    const at = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, h, m);
    candidates.push({ at: at.getTime(), mode: rule.mode });
  }
  candidates.sort((a, b) => a.at - b.at);
  const current = candidates.filter(p => p.at <= date.getTime()).at(-1);
  const next = candidates.find(p => p.at > date.getTime());
  return { ...current, next: next.at };
}
class DaySchedule {
  constructor({ config = DEFAULT, hidden = [], now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, changed = () => {} } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, changed });
    this.active = false; this.rotationIndex = 0; this.hidden = new Set(hidden);
    this.config = validate(config); this.manual = null; this.timer = null; this.lastKey = undefined;
  }
  rotationFaces() { return this.config.rotationFaces.filter(id => !this.hidden.has(id)); }
  setHidden(hidden) {
    const current = this.mode();
    this.hidden = new Set(hidden);
    const faces = this.rotationFaces();
    this.rotationIndex = Math.max(0, faces.indexOf(current));
    if (this.config.strategy === 'rotation' && this.manual && this.hidden.has(this.manual.mode)) this.manual = null;
    if (this.config.enabled && this.config.strategy === 'rotation') this.changed(this.mode());
    this.refresh();
  }
  mode() {
    if (this.config.enabled && this.config.strategy === 'rotation') return this.rotationFaces().length ? this.manual?.mode || this.rotationFaces()[this.rotationIndex] || this.rotationFaces()[0] : 'dashboard';
    const p = period(this.config, this.now());
    if (!p) return null;
    if (this.manual?.at !== p.at) this.manual = null;
    return this.manual?.mode || p.mode;
  }
  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    if (this.config.strategy === 'rotation') this.refresh();
  }
  choose(face) { if (this.hidden.has(modes.fromLegacyFace(face))) return; if (this.config.enabled && this.config.strategy === 'rotation') { this.manual = { mode: modes.fromLegacyFace(face) }; return; } const mode = modes.fromLegacyFace(face); const p = period(this.config, this.now()); if (p) this.manual = { at: p.at, mode }; }
  update(config) { this.config = validate(config); this.manual = null; this.rotationIndex = 0; this.lastKey = undefined; if (this.config.strategy === 'rotation') this.changed(this.mode()); this.refresh(); }
  refresh() {
    this.stop();
    if (this.config.strategy === 'rotation') {
      if (this.config.enabled && this.active && this.rotationFaces().length) {
        this.timer = this.setTimer(() => {
          this.stop();
          if (!this.active) return;
          // One step per callback, never catch up across inactivity/resume.
          const current = this.rotationFaces().indexOf(this.mode());
          const previous = this.rotationIndex, manual = this.manual;
          this.rotationIndex = (current < 0 ? this.rotationIndex + 1 : current + 1) % this.rotationFaces().length;
          this.manual = null;
          if (this.changed(this.mode()) === false) { this.rotationIndex = previous; this.manual = manual; }
          this.refresh();
        }, this.config.rotationMs);
        this.timer?.unref?.();
      }
      return;
    }
    const mode = this.mode();
    const p = period(this.config, this.now());
    const key = `${p?.at}:${mode}`;
    if (key !== this.lastKey && this.changed(mode) !== false) this.lastKey = key;
    if (p) {
      // A minute ceiling reconciles wall-clock jumps/resume; never a zero-delay loop.
      this.timer = this.setTimer(() => this.refresh(), Math.max(1000, Math.min(60000, p.next - this.now().getTime())));
      this.timer?.unref?.();
    }
  }
  stop() { if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
}
module.exports = { DEFAULT, validate, read, write, period, DaySchedule };
