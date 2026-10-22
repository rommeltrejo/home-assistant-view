/** HA.View unauthenticated, bounded HA frontend probe. Never logs URLs or transport errors. */
'use strict';
const http = require('node:http');
const https = require('node:https');
const { validateURL } = require('./initial-settings');
const messages = {
  invalid: 'Enter a valid HTTP or HTTPS Home Assistant URL without credentials.',
  unavailable: 'Home Assistant could not be reached. Check the address and network.',
  timeout: 'Home Assistant did not respond in time.',
  certificate: 'The HTTPS certificate could not be verified. Check the server certificate or your explicit certificate policy.',
  unrelated: 'This address did not return a Home Assistant dashboard.',
  redirect: 'The address redirected unsafely or too many times.',
  cancelled: 'Check cancelled.',
};
function probe(value, { signal, timeoutMs = 8000, ignoreCertificateErrors = false } = {}) {
  let url;
  try { url = new URL(validateURL(value)); } catch { return Promise.resolve({ ok: false, code: 'invalid', message: messages.invalid }); }
  return new Promise(resolve => {
    let request, timer, finished = false;
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      request?.destroy();
      resolve(code ? { ok: false, code, message: messages[code] } : { ok: true });
    };
    const abort = () => finish('cancelled');
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    const visit = (target, hops) => {
      if (finished) return;
      request = (target.protocol === 'https:' ? https : http).get(target, {
        rejectUnauthorized: !ignoreCertificateErrors,
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' },
      }, response => {
        if (finished) { response.destroy(); return; }
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          let next;
          try { next = new URL(response.headers.location, target); } catch { response.destroy(); return finish('redirect'); }
          response.destroy();
          if (hops >= 5 || !['http:', 'https:'].includes(next.protocol) || next.username || next.password ||
              (target.protocol === 'https:' && next.protocol !== 'https:')) return finish('redirect');
          return visit(next, hops + 1);
        }
        if (response.statusCode !== 200) { response.destroy(); return finish('unavailable'); }
        let body = '', bytes = 0;
        response.setEncoding('utf8');
        response.on('data', chunk => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 1024 * 1024) return finish('unrelated');
          body += chunk;
        });
        response.on('error', () => finish('unavailable'));
        response.on('end', () => finish(/<(?:home-assistant|ha-authorize)(?:\s|>)/i.test(body) &&
          /(?:frontend_latest|frontend_es5|\/frontend\/|home-assistant)/i.test(body) ? undefined : 'unrelated'));
      });
      request.on('error', error => finish(/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code || '') ? 'certificate' : 'unavailable'));
    };
    visit(url, 0);
  });
}
module.exports = { probe, messages };
