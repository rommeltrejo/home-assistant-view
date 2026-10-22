'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const policy = require('./initial-settings');
const { merge, persist, meaningful } = require('./startup-settings');
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-startup-'));
  try { return fn(path.join(dir, 'Arguments.json')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('meaningful overrides preserve saved settings; empty CLI values do not erase them', () => {
  const saved = { web_url: 'https://saved.test', web_theme: 'dark', web_widget: 'false' };
  assert.deepEqual(merge(saved, { web_theme: 'light', web_url: '', remote_debugging_port: '9222' }), { ...saved, web_theme: 'light' });
  assert.deepEqual(merge(saved, {}), saved);
  assert.equal(merge(saved, { web_widget: 'true' }).web_widget, 'true');
});
test('first CLI launch persists atomically and a fresh no-args load restores URL', () => fixture(file => {
  const effective = merge({}, { web_url: 'https://saved.test', app_debug: null, app_reset: 'session', user_data_dir: '/tmp/a', trace_warnings: null });
  persist(file, effective, policy.inspect(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { web_url: 'https://saved.test' });
  assert.deepEqual(merge(policy.inspect(file).value, {}), { web_url: 'https://saved.test' });
  assert.equal(policy.decision(policy.inspect(file), {}, false, false), 'existing');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['Arguments.json']);
}));
test('one override preserves unknown keys and untouched credential ciphertext', () => fixture(file => {
  const saved = { web_url: 'https://saved.test', web_theme: 'dark', future_setting: { a: 1 }, mqtt_password: 'ciphertext' };
  fs.writeFileSync(file, JSON.stringify(saved));
  const next = merge(saved, { web_theme: 'light' });
  delete next.mqtt_password; // index keeps unchanged stored credentials out of the write set
  persist(file, next, policy.inspect(file), () => assert.fail('must not re-encrypt'));
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...saved, web_theme: 'light' });
  persist(file, { ...next, mqtt_password: 'new' }, policy.inspect(file), value => `encrypted:${value}`);
  assert.equal(policy.inspect(file).value.mqtt_password, 'encrypted:new');
}));
test('transient and operational settings do not persist or suppress native first launch', () => fixture(file => {
  for (const args of [{}, { remote_debugging_port: '9222' }, { app_debug: null }, { app_reset: 'session' }, { web_url: '' }])
    assert.equal(policy.decision(policy.inspect(file), args, false, false), 'native');
  assert.deepEqual(meaningful({ help: null, version: null, setup: null, inspect_brk: null, app_debug: null }), {});
  fs.writeFileSync(file, '{"trace_warnings":null}');
  assert.equal(policy.decision(policy.inspect(file), {}, false, false), 'native');
}));
test('malformed objects cannot be bypassed by CLI/setup; invalid URL and races leave bytes intact', () => fixture(file => {
  for (const text of ['{broken', 'null', '[]', '"string"']) {
    fs.writeFileSync(file, text);
    const state = policy.inspect(file);
    assert.equal(policy.decision(state, { web_url: 'https://good.test', setup: null }, false, true), 'error');
    assert.throws(() => persist(file, { web_url: 'https://good.test' }, state));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  fs.writeFileSync(file, '{}');
  assert.throws(() => persist(file, { web_url: 'file:///tmp' }, policy.inspect(file)));
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  const prior = policy.inspect(file);
  fs.writeFileSync(file, '{"web_url":"https://other.test"}');
  assert.throws(() => persist(file, { web_url: 'https://good.test' }, prior), /changed/);
  assert.equal(policy.inspect(file).value.web_url, 'https://other.test');
}));
test('no-args repeat is a no-op and retains unrelated browser storage', () => fixture(file => {
  const storage = path.join(path.dirname(file), 'Cookies');
  fs.writeFileSync(storage, 'untouched');
  persist(file, { web_url: 'https://good.test', app_disable: ['install'] }, policy.inspect(file));
  const before = fs.statSync(file).mtimeMs;
  persist(file, merge(policy.inspect(file).value, {}), policy.inspect(file));
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(fs.readFileSync(storage, 'utf8'), 'untouched');
}));

test('HA.View idle and legacy face settings survive saved load, explicit override and no-args restart', () => fixture(file => {
  const saved = { web_url: 'https://saved.test', web_theme: 'dark', ha_view_idle_ms: '6000', ha_view_clock_face: '1' };
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.deepEqual(merge(saved, {}), saved);
  const effective = merge(saved, { ha_view_idle_ms: '9000', ha_view_clock_face: '2', remote_debugging_port: '9222' });
  assert.deepEqual(effective, { ...saved, ha_view_idle_ms: '9000', ha_view_clock_face: '2' });
  persist(file, effective, policy.inspect(file));
  assert.deepEqual(merge(policy.inspect(file).value, {}), effective);
  assert.deepEqual(merge(effective, { ha_view_idle_ms: '', ha_view_clock_face: null }), effective);
}));
test('every production ARGS access has an explicit durable or runtime-only policy', () => {
  const root = path.resolve(__dirname, '..');
  const files = ['index.js', ...['js', 'ha.view'].flatMap(dir => fs.readdirSync(path.join(root, dir))
    .filter(name => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map(name => `${dir}/${name}`))];
  const consumed = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bARGS(?:\?\.|\.)([a-z_]+)/g)) consumed.add(match[1]);
    for (const match of source.matchAll(/["']([a-z_]+)["']\s+in\s+ARGS/g)) consumed.add(match[1]);
    for (const match of source.matchAll(/\bARGS\s*\[\s*["']([a-z_]+)["']\s*\]/g)) consumed.add(match[1]);
  }
  assert.ok(consumed.has('ha_view_idle_ms'));
  assert.ok(consumed.has('ha_view_clock_face'));
  const runtimeOnly = new Set(['app_reset', 'app_debug', 'enable_logging']);
  for (const key of consumed) {
    if (runtimeOnly.has(key)) {
      assert.ok(Object.hasOwn(merge({}, { [key]: 'test' }), key), `${key}: missing runtime policy`);
      assert.ok(!Object.hasOwn(meaningful({ [key]: 'test' }), key), `${key}: must not persist`);
    } else {
      assert.ok(Object.hasOwn(meaningful({ [key]: 'test' }), key), `${key}: missing durable policy`);
    }
  }
});

test('invalid saved fields cannot be masked by valid overrides; invalid effective types do not write', () => fixture(file => {
  const { validate } = require('./startup-settings');
  for (const bad of [{ web_url: ['https://ok.test', null] }, { web_zoom: 'NaN' }, { ha_view_idle_ms: -1 },
    { ha_view_clock_face: 'unknown' }, { mqtt_url: 'http://broker.test' }, { app_disable: {} },
    { web_theme: {} }, { app_kiosk: [] }, { mqtt_password: {} }]) {
    const saved = { web_url: 'https://saved.test', ...bad };
    const text = JSON.stringify(saved);
    fs.writeFileSync(file, text);
    assert.throws(() => persist(file, { web_url: 'https://good.test' }, policy.inspect(file)));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.throws(() => validate({ web_url: 'https://good.test', ...bad }));
  }
  for (const face of require('./face-modes').FACE_IDS) validate({ web_url: 'https://good.test', ha_view_clock_face: face });
  validate({ web_url: 'https://good.test', ha_view_clock_face: String(require('./face-modes').FACE_IDS.length),
    web_theme: 'system', app_kiosk: 'legacy-fallback' });
}));
test('competing writer, byte-only edit, replacement, symlink and post-stage race fail without overwrite', () => fixture(file => {
  fs.writeFileSync(file, '{"web_url":"https://saved.test"}');
  let snapshot = policy.inspect(file);
  fs.writeFileSync(`${file}.lock`, 'another writer');
  assert.throws(() => persist(file, { web_url: 'https://good.test' }, snapshot), /EEXIST/);
  assert.equal(fs.readFileSync(`${file}.lock`, 'utf8'), 'another writer');
  fs.unlinkSync(`${file}.lock`);
  fs.writeFileSync(file, JSON.stringify(snapshot.value, null, 2));
  assert.throws(() => persist(file, { web_url: 'https://good.test' }, snapshot), /changed/);
  snapshot = policy.inspect(file);
  fs.writeFileSync(`${file}.replacement`, snapshot.raw);
  fs.renameSync(`${file}.replacement`, file);
  assert.throws(() => persist(file, { web_url: 'https://good.test' }, snapshot), /changed/);
  snapshot = policy.inspect(file);
  const originalWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (target, ...rest) => {
      const result = originalWrite(target, ...rest);
      if (typeof target === 'number') originalWrite(file, '{"web_url":"https://racer.test"}');
      return result;
    };
    assert.throws(() => persist(file, { web_url: 'https://good.test' }, snapshot), /changed/);
  } finally { fs.writeFileSync = originalWrite; }
  assert.equal(policy.inspect(file).value.web_url, 'https://racer.test');
  const target = `${file}.target`;
  fs.renameSync(file, target); fs.symlinkSync(target, file);
  assert.equal(policy.inspect(file).kind, 'error');
  assert.throws(() => persist(file, { web_url: 'https://good.test' }, policy.inspect(file)));
  assert.equal(JSON.parse(fs.readFileSync(target)).web_url, 'https://racer.test');
  assert.ok(!fs.readdirSync(path.dirname(file)).some(name => /\.tmp$|\.lock$/.test(name)));
}));
test('staging failure preserves original bytes and cleans only own temporary/lock files', () => fixture(file => {
  const text = '{"web_url":"https://saved.test"}';
  fs.writeFileSync(file, text);
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw new Error('simulated disk failure'); };
    assert.throws(() => persist(file, { web_url: 'https://good.test' }, policy.inspect(file)), /disk failure/);
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['Arguments.json']);
}));
test('browser auth files remain byte-identical across overrides and no-args restarts', () => fixture(file => {
  const root = path.dirname(file);
  const auth = ['Cookies', 'Network/Cookies', 'Local Storage/leveldb/auth.ldb', 'Session Storage/auth.log'];
  for (const name of auth) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `synthetic auth ${name}`);
  }
  persist(file, { web_url: 'https://saved.test', ha_view_idle_ms: '9000', ha_view_clock_face: '2' }, policy.inspect(file));
  persist(file, merge(policy.inspect(file).value, { web_theme: 'light', app_debug: null }), policy.inspect(file));
  persist(file, merge(policy.inspect(file).value, {}), policy.inspect(file));
  for (const name of auth) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), `synthetic auth ${name}`);
}));

// Simulate the platform at the production branch without changing its public API.
function onPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    return fn();
  } finally { Object.defineProperty(process, 'platform', descriptor); }
}
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const existing of [false, true]) {
    test(`${platform}: ${existing ? 'replacement' : 'first write'} syncs file before atomic publication`, () => fixture(file => {
      if (existing) fs.writeFileSync(file, '{"web_url":"https://saved.test"}');
      const originals = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync, renameSync: fs.renameSync };
      const events = [];
      try {
        fs.openSync = (target, ...args) => {
          if (target === path.dirname(file)) {
            events.push('directory-open');
            if (platform === 'win32') throw Object.assign(new Error('unsupported directory operation'), { code: 'EPERM' });
          }
          return originals.openSync(target, ...args);
        };
        fs.fsyncSync = fd => {
          const directory = fs.fstatSync(fd).isDirectory();
          events.push(directory ? 'directory-sync' : 'file-sync');
          // Unix directory behavior is simulated even if these tests run on Windows.
          if (!directory) return originals.fsyncSync(fd);
        };
        for (const method of ['linkSync', 'renameSync']) fs[method] = (...args) => {
          events.push(method);
          return originals[method](...args);
        };
        const next = { web_url: 'https://good.test' };
        onPlatform(platform, () => assert.deepEqual(persist(file, next, policy.inspect(file)), next));
        assert.deepEqual(events, ['file-sync', existing ? 'renameSync' : 'linkSync',
          ...(platform === 'win32' ? [] : ['directory-open', 'directory-sync'])]);
        assert.deepEqual(policy.inspect(file).value, next);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['Arguments.json']);
      } finally { Object.assign(fs, originals); }
    }));
  }
}
for (const platform of ['win32', 'darwin', 'linux']) {
  for (const operation of ['file-sync', 'rename', ...(platform === 'win32' ? [] : ['directory-open', 'directory-sync'])]) {
    test(`${platform}: ${operation} errors propagate without being swallowed`, () => fixture(file => {
      const text = '{"web_url":"https://saved.test"}';
      fs.writeFileSync(file, text);
      const originals = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
      const failure = Object.assign(new Error(`simulated ${operation} failure`), { code: 'EPERM' });
      try {
        fs.openSync = (target, ...args) => {
          if (operation === 'directory-open' && target === path.dirname(file)) throw failure;
          return originals.openSync(target, ...args);
        };
        fs.fsyncSync = fd => {
          const directory = fs.fstatSync(fd).isDirectory();
          if (operation === (directory ? 'directory-sync' : 'file-sync')) throw failure;
          if (!directory) return originals.fsyncSync(fd);
        };
        fs.renameSync = (...args) => {
          if (operation === 'rename') throw failure;
          return originals.renameSync(...args);
        };
        onPlatform(platform, () => assert.throws(
          () => persist(file, { web_url: 'https://good.test' }, policy.inspect(file)), error => error === failure));
        if (['file-sync', 'rename'].includes(operation)) assert.equal(fs.readFileSync(file, 'utf8'), text);
        else assert.equal(policy.inspect(file).value.web_url, 'https://good.test');
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['Arguments.json']);
      } finally { Object.assign(fs, originals); }
    }));
  }
}

 test('Windows watchdog kiosk launch requires UI URL setup, not credentials or CLI', () => fixture(file => {
  const kiosk = { app_kiosk: 'fullscreen' };
  assert.equal(policy.decision(policy.inspect(file), kiosk, true, false), 'native');
  const saved = { app_kiosk: 'fullscreen', web_theme: 'dark', mqtt_password: 'existing-ciphertext', future_setting: 7 };
  fs.writeFileSync(file, JSON.stringify(saved));
  const prior = policy.inspect(file);
  assert.equal(policy.decision(prior, kiosk, true, false), 'native');
  assert.deepEqual(policy.saveURL(file, 'https://ha.test/', prior), { ...saved, web_url: 'https://ha.test/' });
  assert.equal(policy.decision(policy.inspect(file), kiosk, true, false), 'existing');
  assert.equal(policy.decision({ kind: 'missing' }, { ...kiosk, web_url: 'https://ha.test/' }, true, false), 'existing');
}));
