'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probe } = require('./startup-recovery-probe');
const { createController } = require('./startup-recovery-controller');
async function server(t, handler) {
  const value = http.createServer(handler);
  await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  t.after(() => { value.closeAllConnections(); value.close(); });
  return `http://127.0.0.1:${value.address().port}`;
}
test('real HTTP probe accepts HA frontend, rejects generic 200 and HTTP errors', async t => {
  const base = await server(t, (req, res) => {
    if (req.url === '/ha') res.end('<html><home-assistant></home-assistant><script src="/frontend_latest/core.js"></script></html>');
    else if (req.url === '/error') { res.writeHead(503); res.end('secret'); }
    else res.end('<html><h1>Other service</h1></html>');
  });
  assert.equal((await probe(base + '/ha')).ok, true);
  assert.equal((await probe(base)).code, 'unrelated');
  assert.equal((await probe(base + '/error')).code, 'unavailable');
});
test('invalid and credential-bearing URLs return nonsecret errors', async () => {
  for (const url of ['bad-secret', 'file:///tmp/secret', 'https://user:secret@example.test']) {
    const result = await probe(url);
    assert.equal(result.code, 'invalid');
    assert.ok(!result.message.includes('secret'));
  }
});
test('timeout bounds entire response and cancellation ends pending sockets', async t => {
  const base = await server(t, (_req, res) => { res.writeHead(200); res.write('waiting'); });
  assert.equal((await probe(base, { timeoutMs: 30 })).code, 'timeout');
  const abort = new AbortController();
  const pending = probe(base, { signal: abort.signal });
  abort.abort();
  assert.equal((await pending).code, 'cancelled');
  assert.equal((await probe(base, { signal: abort.signal })).code, 'cancelled');
});
test('redirects are bounded, credential redirects rejected, oversized bodies rejected', async t => {
  const base = await server(t, (req, res) => {
    if (req.url === '/large') return res.end('x'.repeat(1024 * 1024 + 1));
    res.writeHead(302, { Location: req.url === '/credentials' ? 'http://user:secret@example.test/' : '/loop' }); res.end();
  });
  assert.equal((await probe(base + '/loop')).code, 'redirect');
  assert.equal((await probe(base + '/credentials')).code, 'redirect');
  assert.equal((await probe(base + '/large')).code, 'unrelated');
});
test('controller 30-second retry, cancel, stale results and disposal', async () => {
  let timer, delay, ready = 0, checks = [], publications = [];
  const controller = createController({ check: (_url, options) => new Promise(resolve => checks.push({ resolve, options })),
    publish: state => publications.push(state), ready: () => ready++,
    timers: { setTimeout(fn, ms) { timer = fn; delay = ms; return 1; }, clearTimeout() { timer = undefined; } } });
  const args = { web_url: 'http://ha.test' };
  const first = controller.run(args, true);
  checks[0].resolve({ ok: false, message: 'offline' }); await first;
  assert.equal(delay, 30000); assert.equal(publications.at(-1).waiting, true);
  const retry = timer();
  controller.cancelWait();
  assert.equal(checks[1].options.signal.aborted, true);
  checks[1].resolve({ ok: true }); await retry;
  assert.equal(ready, 0); assert.equal(timer, undefined);
  const last = controller.run(args); controller.dispose();
  checks[2].resolve({ ok: true }); await last;
  assert.equal(ready, 0);
});
test('all configured URLs are probed; certificate bypass requires explicit policy', async () => {
  const calls = [];
  const controller = createController({ check: async (url, options) => { calls.push([url, options.ignoreCertificateErrors]); return { ok: true }; }, publish() {}, ready() {} });
  await controller.run({ web_url: ['http://one', 'https://two'] });
  await controller.run({ web_url: 'https://two', ignore_certificate_errors: 'false' });
  await controller.run({ web_url: 'https://two', ignore_certificate_errors: null });
  assert.deepEqual(calls, [['http://one', false], ['https://two', false], ['https://two', false], ['https://two', true]]);
  controller.dispose();
});
test('packaging includes recovery runtime but excludes tests', () => {
  const { ignore } = require('./build/files');
  for (const file of ['startup-recovery.js', 'startup-recovery-controller.js', 'startup-recovery-probe.js', 'startup-recovery-preload.js', 'startup-recovery-renderer.js', 'startup-recovery.html']) assert.equal(ignore('/ha.view/' + file), false);
  assert.equal(ignore('/ha.view/startup-recovery.test.js'), true);
});
test('real HTTPS respects strict/default and explicit bypass; never follows HTTPS to HTTP', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-probe-cert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  const result = require('node:child_process').spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  const value = require('node:https').createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    if (req.url === '/downgrade') { res.writeHead(302, { Location: 'http://127.0.0.1:1/' }); res.end(); }
    else res.end('<home-assistant></home-assistant>');
  });
  await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  t.after(() => { value.closeAllConnections(); value.close(); });
  const url = `https://127.0.0.1:${value.address().port}`;
  assert.equal((await probe(url)).code, 'certificate');
  assert.equal((await probe(url, { ignoreCertificateErrors: true })).ok, true);
  assert.equal((await probe(url + '/downgrade', { ignoreCertificateErrors: true })).code, 'redirect');
});
