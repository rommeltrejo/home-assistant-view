/** HA.View durable startup settings; operational switches are never configuration. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspect, validateURL } = require('./initial-settings');
const settings = new Set(['web_url', 'web_theme', 'web_zoom', 'web_widget', 'web_pager',
  'app_kiosk', 'app_disable', 'app_early', 'mqtt_enable', 'mqtt_url', 'mqtt_user', 'mqtt_password',
  'mqtt_discovery', 'ignore_certificate_errors', 'ha_view_idle_ms', 'ha_view_clock_face']);
const transient = new Set(['help', 'version', 'setup', 'app_reset', 'app_debug', 'enable_logging']);
function operational(key) {
  return transient.has(key) || /^(user_data_dir|remote_debugging_|inspect(?:_|$)|trace_|enable_logging|disable_gpu|no_sandbox|ozone_platform)/.test(key);
}
function meaningful(args = {}) {
  return Object.fromEntries(Object.entries(args).filter(([key, value]) =>
    settings.has(key) && (value === null ? ['app_early', 'ignore_certificate_errors', 'mqtt_enable'].includes(key) :
      Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.trim() !== '' : value !== undefined)));
}
function merge(saved, cli = {}) {
  return { ...meaningful(saved || {}), ...meaningful(cli),
    ...Object.fromEntries(Object.entries(cli).filter(([key]) => transient.has(key))) };
}
function validate(args) {
  const list = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const urls = list(args.web_url);
  if (!urls.length) throw new Error('Enter a Home Assistant URL.');
  urls.forEach(validateURL);
  const oneOf = (key, values) => {
    if (Object.hasOwn(args, key) && !values.includes(args[key])) throw new Error(`Invalid ${key}.`);
  };
  // Upstream intentionally falls back for unrecognized strings; do not reject old profiles.
  for (const key of ['web_theme', 'app_kiosk']) {
    if (Object.hasOwn(args, key) && typeof args[key] !== 'string') throw new Error(`Invalid ${key}.`);
  }
  for (const key of ['web_widget', 'web_pager']) oneOf(key, ['true', 'false']);
  for (const key of ['app_early', 'ignore_certificate_errors', 'mqtt_enable']) oneOf(key, [null, 'true', 'false']);
  for (const key of ['web_zoom', 'ha_view_idle_ms']) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    const number = Number(value);
    if (!['number', 'string'].includes(typeof value) || !String(value).trim() || !Number.isFinite(number) || number <= 0 ||
        (key === 'ha_view_idle_ms' && (!Number.isSafeInteger(number) || number > 2147483647))) throw new Error(`Invalid ${key}.`);
  }
  if (Object.hasOwn(args, 'ha_view_clock_face')) {
    const ids = require('./face-modes').FACE_IDS;
    const value = args.ha_view_clock_face;
    if (!ids.includes(value) && !(['number', 'string'].includes(typeof value) &&
        Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= ids.length))
      throw new Error('Invalid ha_view_clock_face.');
  }
  if (Object.hasOwn(args, 'app_disable') && (!list(args.app_disable).length || list(args.app_disable).some(v => typeof v !== 'string' || !v.trim())))
    throw new Error('Invalid app_disable.');
  for (const key of ['mqtt_url', 'mqtt_user', 'mqtt_password', 'mqtt_discovery']) {
    if (Object.hasOwn(args, key) && typeof args[key] !== 'string') throw new Error(`Invalid ${key}.`);
  }
  if (args.mqtt_url) {
    let url;
    try { url = new URL(args.mqtt_url); } catch { throw new Error('Invalid mqtt_url.'); }
    if (!['mqtt:', 'mqtts:'].includes(url.protocol) || !url.hostname) throw new Error('Invalid mqtt_url.');
  }
}
function same(current, prior) {
  return current.kind !== 'error' && current.kind === prior.kind &&
    (prior.raw !== undefined ? current.raw === prior.raw && current.identity === prior.identity :
      JSON.stringify(current.value) === JSON.stringify(prior.value));
}
// Shared by native first-launch settings and normal startup. Never break stale locks:
// a competing writer or interrupted startup must fail closed, not overwrite evidence.
function atomicWrite(file, next, prior) {
  if (!prior || prior.kind === 'error') throw new Error(prior?.message || 'Invalid settings snapshot.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let lockFd;
  let temporary;
  try {
    lockFd = fs.openSync(lock, 'wx', 0o600);
    const current = inspect(file);
    if (!same(current, prior)) throw new Error('Arguments.json changed during startup. Nothing was overwritten.');
    if (JSON.stringify(next) === JSON.stringify(current.value)) return next;
    temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Recheck AFTER staging the write; detect editors/replacements during startup.
    if (!same(inspect(file), current)) throw new Error('Arguments.json changed during startup. Nothing was overwritten.');
    if (current.kind === 'missing') fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
    // Unix needs directory fsync to durably publish the new name. Windows does
    // not support this directory operation; keep file fsync and atomic publication
    // above, without turning an already-published write into a startup failure.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return next;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  }
}
function persist(file, effective, prior, encodePassword = value => value) {
  if (prior.kind === 'error') throw new Error(prior.message);
  // Validate saved known fields as well: an override must not mask invalid stored data.
  if (prior.value) validate({ web_url: 'https://validation.invalid/', ...prior.value });
  validate(effective);
  const durable = meaningful(effective);
  const next = { ...(prior.value || {}), ...durable };
  if (Object.hasOwn(durable, 'mqtt_password')) next.mqtt_password = encodePassword(durable.mqtt_password);
  for (const key of Object.keys(next)) if (operational(key)) delete next[key];
  return atomicWrite(file, next, prior);
}
module.exports = { meaningful, merge, validate, persist, atomicWrite };
