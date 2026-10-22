'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./camera-config');
const backend = 'http://ha.example.test:8123/lovelace/home';
test('unconfigured never guesses a dashboard', () => {
  assert.equal(config.resolveDashboard('', backend), null);
  assert.equal(config.configured({ path: '' }, backend), null);
});
test('root path / same-origin URL / hash route normalization', () => {
  for (const input of ['/dashboard-cameras/overview', 'http://ha.example.test:8123/dashboard-cameras/overview']) {
    assert.equal(config.resolveDashboard(input, backend).url, 'http://ha.example.test:8123/dashboard-cameras/overview');
  }
  assert.equal(config.resolveDashboard('/lovelace/cameras#view', backend).path, '/lovelace/cameras#view');
});
test('reject foreign URLs, scheme tricks, credentials and credential-bearing query', () => {
  for (const value of ['https://foreign.test/cameras', '//foreign.test/cameras', 'javascript:alert(1)', 'data:text/html,x',
    'http://user:password@ha.example.test:8123/cameras', '/\\foreign.test/cameras', 'cameras', 'http://ha.example.test:8124/cameras',
    '/cameras?token=secret', '/cameras\nfoo', '/%5cforeign', 'file:///cameras']) {
    assert.throws(() => config.resolveDashboard(value, backend), undefined, value);
  }
  assert.throws(() => config.resolveDashboard('/cameras', 'http://user:password@ha.example.test:8123'));
});
test('persist normalized local path; backend changes require deliberate resave; clear and corrupt recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-camera-test-'));
  try {
    const file = path.join(dir, 'camera.json');
    assert.deepEqual(config.read(file), { path: '', origin: '' });
    config.write(file, '/dashboard-cameras/overview', backend);
    assert.equal(config.configured(config.read(file), backend).path, '/dashboard-cameras/overview');
    assert.throws(() => config.configured(config.read(file), 'http://other.test'));
    assert.throws(() => config.write(file, 'https://foreign.test', backend));
    assert.equal(config.read(file).path, '/dashboard-cameras/overview');
    config.write(file, '', backend); assert.equal(config.configured(config.read(file), backend), null);
    fs.writeFileSync(file, '{'); assert.equal(config.read(file).path, '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
