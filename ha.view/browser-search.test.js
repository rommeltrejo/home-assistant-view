'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BUILTINS, defaults, validateProvider, validateSearch, typedURL } = require('./browser-policy');
test('enabled default DDG search encodes Unicode and query punctuation', () => {
  assert.equal(typedURL('café & tea # ?'), 'https://duckduckgo.com/?q=caf%C3%A9%20%26%20tea%20%23%20%3F');
  for (const p of BUILTINS) assert.equal(typedURL('hello world', { ...defaults(), provider: p.id }), p.template.replace('{query}', 'hello%20world'));
  const custom = { id: 'custom-one', name: '<img onerror=alert(1)>', template: 'https://example.com/find/{query}?x=1' };
  assert.equal(typedURL('hello world', { enabled: true, provider: custom.id, customProviders: [custom] }), 'https://example.com/find/hello%20world?x=1');
});
test('disabled search still permits direct HTTPS completion and explicit HTTP', () => {
  const search = { ...defaults(), enabled: false };
  for (const v of ['hello world', 'hello']) assert.throws(() => typedURL(v, search));
  assert.equal(typedURL('example.com', search), 'https://example.com/');
  assert.equal(typedURL('http://localhost:8123', search), 'http://localhost:8123/');
});
test('unsafe schemes, credentials and malformed address intent never become searches', () => {
  for (const v of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'https:/example.com', '//example.com', '/example.com', 'https:///x', 'user@example.com', 'user:pass@example.com', 'https://u:p@example.com', 'example..com', 'example.com:bad', 'example.com:65536', '-example.com', '999.999.999.999', '[not-ip]', 'example%2ecom', 'example.com\n', 'hello\u0085', '', {}, null]) assert.throws(() => typedURL(v), String(v));
});
test('templates require one path/query placeholder and strict credential-free HTTP(S)', () => {
  const provider = template => ({ id: 'custom-one', name: 'Example', template });
  for (const template of ['https://example.com/?q={query}', 'http://localhost:8123/{query}']) assert.doesNotThrow(() => validateProvider(provider(template)));
  for (const template of ['https://{query}.example.com/', '{query}://example.com/', 'https://{query}@example.com/', 'https://u:p@example.com/?q={query}', 'https://example.com/#{query}', 'https://example.com/?q={query}&x={query}', 'https://example.com/', 'javascript:{query}', 'https:///example.com/{query}', 'https://example.com/{other}/{query}', 'https://example.com\\evil/{query}', 'https://example.com/{query}\n']) assert.throws(() => validateProvider(provider(template)), template);
  for (const name of ['', 'x'.repeat(61), ' a', 'a\n']) assert.throws(() => validateProvider({ ...provider('https://example.com/{query}'), name }));
  assert.throws(() => validateSearch({ ...defaults(), provider: 'missing' }));
  assert.throws(() => validateSearch({ ...defaults(), customProviders: [{ ...provider('https://example.com/{query}'), name: 'Google' }] }));
});

test('ordinary multiword punctuation is encoded search text, not address intent', () => {
  for (const query of ['how to use node.js', 'save 50% on recipes', 'recipe/media slash examples', 'node.js tutorial?', 'version [1.2] guide', 'feeding guide: cats']) {
    assert.equal(typedURL(query), `https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
  }
});
test('explicit and disguised schemes and embedded credentials never leak into search', () => {
  for (const query of ['java script:alert(1)', 'data : text/html,x', 'file : ///etc/passwd', 'https : /example.com', 'look up https://u:p@example.com today', 'look up https:/u:p@example.com today', 'look up https: u : p @ example.com today', 'look up http://u%3Ap%40example.com today', 'find user:pass@example.com help', 'https://example.com bad path', 'find ftp://example.com help']) {
    assert.throws(() => typedURL(query), query);
  }
});
