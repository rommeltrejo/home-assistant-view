/** HA.View first-launch configuration policy; never replaces a malformed file. */
'use strict';
const fs = require('node:fs');
const operational = new Set(['user_data_dir', 'remote_debugging_port', 'remote_debugging_address', 'inspect', 'inspect_brk', 'trace_warnings', 'enable_logging', 'disable_gpu', 'no_sandbox', 'ozone_platform']);
function meaningfulArgs(args) { return Object.fromEntries(Object.entries(args).filter(([key]) => !operational.has(key))); }
function inspect(file) {
  let text, identity;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile()) throw new Error('Expected a regular settings file');
      identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      text = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  }
  catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', message: `Cannot read Arguments.json: ${error.message}` };
  }
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected a JSON object');
    return { kind: Object.keys(value).length ? 'saved' : 'empty', value, raw: text, identity };
  } catch (error) { return { kind: 'error', message: `Invalid Arguments.json: ${error.message}` }; }
}
function decision(config, args, packaged, isTTY) {
  if (config.kind === 'error') return 'error';
  if ('setup' in args) return packaged && !isTTY ? 'native' : 'terminal';
  const durable = require('./startup-settings').meaningful;
  // Kiosk/theme/MQTT options are not a dashboard address. In particular the
  // Windows watchdog always supplies app_kiosk on a never-configured profile.
  const effective = { ...durable(config.value || {}), ...durable(args) };
  if (Object.hasOwn(effective, 'web_url')) return 'existing';
  return 'native';
}
function validateURL(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a Home Assistant URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('Use an HTTP or HTTPS URL without credentials.');
  return url.href;
}
// Atomic replacement ensures an existing empty object remains intact if writing fails.
function saveURL(file, value, prior) {
  const url = validateURL(value);
  const snapshot = typeof prior === 'object' ? prior : { kind: prior, ...(prior === 'empty' ? { value: {} } : {}) };
  if (snapshot.kind === 'error') throw new Error(snapshot.message);
  const args = { ...(snapshot.value || {}), web_url: url };
  return require('./startup-settings').atomicWrite(file, args, snapshot);
}
module.exports = { meaningfulArgs, inspect, decision, validateURL, saveURL };
