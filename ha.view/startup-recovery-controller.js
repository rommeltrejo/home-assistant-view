/** HA.View startup gate state: one check at a time, cancellation invalidates stale work. */
'use strict';
const { probe } = require('./startup-recovery-probe');
function createController({ check = probe, publish, ready, intervalMs = 30000, timers = globalThis }) {
  let generation = 0, abort, timer, disposed = false, waiting = false;
  function cancel() {
    generation++;
    abort?.abort();
    abort = undefined;
    timers.clearTimeout(timer);
    timer = undefined;
    waiting = false;
  }
  async function run(args, wait = false) {
    cancel();
    if (disposed) return;
    waiting = wait;
    const token = generation;
    abort = new AbortController();
    publish({ checking: true, waiting, message: 'Checking Home Assistant…' });
    const urls = Array.isArray(args.web_url) ? args.web_url : typeof args.web_url === 'string' ? args.web_url.split(',').map(v => v.trim()) : [''];
    let result = { ok: false, message: 'Enter a Home Assistant URL.' };
    try {
      for (const url of urls.length ? urls : ['']) {
        result = await check(url, { signal: abort.signal,
          // Match the explicit Electron command-line switch: absent means strict TLS.
          ignoreCertificateErrors: Object.hasOwn(args, 'ignore_certificate_errors') && args.ignore_certificate_errors !== 'false' });
        if (disposed || generation !== token) return;
        if (!result.ok) break;
      }
    } catch { result = { ok: false, message: 'Home Assistant could not be reached.' }; }
    if (disposed || generation !== token) return;
    if (result.ok) { cancel(); ready(args); return; }
    publish({ checking: false, waiting, message: result.message });
    if (waiting) timer = timers.setTimeout(() => run(args, true), intervalMs);
  }
  return { run, cancelWait() { cancel(); if (!disposed) publish({ checking: false, waiting: false, message: 'Waiting cancelled. Choose an option below.' }); },
    cancel, dispose() { cancel(); disposed = true; } };
}
module.exports = { createController };
