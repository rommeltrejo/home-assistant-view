'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettings, DEFAULT_HOMEPAGE } = require('./browser');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-browser-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'browser-settings.json');
}
test('separate atomic browser preferences persist normalized homepage across restart', t => {
  const file = fixture(t), settings = createSettings(file);
  assert.equal(settings.homepage, DEFAULT_HOMEPAGE); assert.equal(fs.existsSync(file), false);
  settings.save('example.com/path');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { homepage: 'https://example.com/path', search: { enabled: true, provider: 'duckduckgo', customProviders: [] }, showIcon: true });
  assert.equal(createSettings(file).homepage, 'https://example.com/path');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
test('invalid and credential-bearing input never replaces preferences', t => {
  const file = fixture(t), settings = createSettings(file); settings.save('localhost:8123');
  const before = fs.readFileSync(file, 'utf8');
  for (const input of ['https://u:p@example.com', 'javascript:alert(1)', '//example.com', {}, '']) assert.throws(() => settings.save(input));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('corrupt, unexpected and unsafe saved settings default without overwriting evidence', t => {
  const file = fixture(t);
  for (const raw of ['bad json', '{"homepage":"file:///x"}', '{"homepage":"https://u:p@example.com"}', '{"token":"secret"}']) {
    fs.writeFileSync(file, raw); const settings = createSettings(file);
    assert.equal(settings.homepage, DEFAULT_HOMEPAGE); assert.ok(settings.error);
    assert.throws(() => settings.save('example.com')); assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
});
test('concurrent edits and locks fail closed', t => {
  const file = fixture(t), settings = createSettings(file); settings.save('example.com');
  fs.writeFileSync(file, '{"homepage":"https://other.example/"}');
  assert.throws(() => settings.save('third.example')); assert.equal(createSettings(file).homepage, 'https://other.example/');
  const fresh = createSettings(file); fs.writeFileSync(`${file}.lock`, '');
  assert.throws(() => fresh.save('third.example')); assert.equal(createSettings(file).homepage, 'https://other.example/');
});
test('homepage-only migration preserves homepage; custom selection and removal persist safely', t => {
  const file = fixture(t); fs.writeFileSync(file, JSON.stringify({ homepage: 'https://example.com/' }));
  let settings = createSettings(file); assert.equal(settings.search.enabled, true); assert.equal(settings.error, '');
  settings.saveSearch('search-add', { name: 'Example', template: 'https://example.com/search?q={query}' });
  const id = settings.search.customProviders[0].id;
  settings.saveSearch('search-provider', id); settings.saveSearch('search-enabled', false);
  settings = createSettings(file); assert.equal(settings.homepage, 'https://example.com/'); assert.equal(settings.search.provider, id); assert.equal(settings.search.enabled, false);
  const copy = settings.search; copy.customProviders.length = 0; assert.equal(settings.search.customProviders.length, 1);
  const before = fs.readFileSync(file, 'utf8');
  for (const [action, value] of [['search-remove', 'google'], ['search-provider', 'missing'], ['search-enabled', 'yes'], ['search-add', { name: 'Bad', template: 'https://{query}.example.com/' }]]) assert.throws(() => settings.saveSearch(action, value));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  settings.saveSearch('search-remove', id); assert.equal(createSettings(file).search.provider, 'duckduckgo'); assert.deepEqual(settings.search.customProviders, []);
});
test('search writes preserve atomic concurrency protection and corrupt file evidence', t => {
  const file = fixture(t), settings = createSettings(file); settings.save('example.com');
  fs.writeFileSync(file, '{"homepage":"https://other.example/"}');
  assert.throws(() => settings.saveSearch('search-enabled', false)); assert.equal(settings.search.enabled, true);
  fs.writeFileSync(file, '{"search":{"enabled":true,"provider":"missing","customProviders":[]}}');
  const broken = createSettings(file), before = fs.readFileSync(file, 'utf8'); assert.ok(broken.error);
  assert.throws(() => broken.saveSearch('search-enabled', false)); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('browser visibility persists, notifies both surfaces and fails closed for corrupt or concurrent files', t => {
  const file = fixture(t), settings = createSettings(file), seen = [];
  const unsubscribe = settings.subscribe(value => seen.push(value));
  assert.equal(settings.showIcon, true);
  assert.equal(settings.saveShowIcon(false), false);
  assert.deepEqual(seen, [false]);
  assert.equal(createSettings(file).showIcon, false);
  settings.save('example.com'); settings.saveSearch('search-enabled', false);
  assert.equal(createSettings(file).showIcon, false);
  for (const value of ['false', 0, null]) assert.throws(() => settings.saveShowIcon(value));
  unsubscribe(); settings.saveShowIcon(true); assert.deepEqual(seen, [false]);
  const concurrent = createSettings(file); fs.writeFileSync(file, '{}');
  assert.throws(() => concurrent.saveShowIcon(false));
  fs.writeFileSync(file, '{"showIcon":"false"}');
  const broken = createSettings(file); assert.ok(broken.error); assert.equal(broken.showIcon, false);
  assert.throws(() => broken.saveShowIcon(false));
});

test('malformed browser preferences fail closed and never expose a browsing launcher', t => {
  const file = fixture(t); fs.writeFileSync(file, 'invalid json');
  const settings = createSettings(file);
  assert.equal(settings.showIcon, false); assert.ok(settings.error);
  assert.throws(() => settings.saveShowIcon(true));
});
