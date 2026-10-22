/** HA.View local camera dashboard routing. Never stores authentication data. */
'use strict';
const fs = require('node:fs');
function resolveDashboard(input, backend) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Enter a dashboard path on the configured Home Assistant backend.');
  const value = input.trim();
  if (!value) return null;
  let base, url;
  try {
    base = new URL(backend);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw 0;
    // Require a root-relative path or explicit HTTP(S) URL, not host-relative guesses.
    if (/[\\\u0000-\u0020\u007f]/.test(value) || value.startsWith('//') ||
        (!value.startsWith('/') && !/^https?:\/\//i.test(value))) throw 0;
    url = new URL(value, base.origin);
    if (url.origin !== base.origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw 0;
    // Queries may carry credentials; this feature only needs dashboard path/hash routing.
    if (url.search || /%00|%0a|%0d|%5c/i.test(url.pathname)) throw 0;
  } catch (_) { throw new Error('Use a path or HTTP(S) URL on the configured Home Assistant origin, without credentials or query parameters.'); }
  return { origin: base.origin, path: url.pathname + url.hash, url: url.href };
}
function read(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.path === 'string' && typeof data.origin === 'string') return { path: data.path, origin: data.origin };
  } catch (_) {}
  return { path: '', origin: '' };
}
function write(file, input, backend) {
  const result = resolveDashboard(input, backend);
  const data = result ? { path: result.path, origin: result.origin } : { path: '', origin: '' };
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  return data;
}
function configured(data, backend) {
  if (!data.path) return null;
  const result = resolveDashboard(data.path, backend);
  if (result.origin !== data.origin) throw new Error('Backend changed. Save the camera dashboard path again for this backend.');
  return result;
}
module.exports = { resolveDashboard, read, write, configured };
