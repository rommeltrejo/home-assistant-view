'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = new Map();
  const listeners = new Map();
  const document = { activeElement: null, addEventListener(name, handler) { listeners.set(name, handler); }, createElement: () => element('') };
  function element(id) {
    return { id, hidden: true, value: '', textContent: '', disabled: false,
      focus() { document.activeElement = this; }, contains(target) { for (let node = target; node; node = node.parent) if (node === this) return true; return false; }, setAttribute() {}, append() {}, replaceChildren() {},
      reset() { elements.get('provider-name').value = ''; elements.get('provider-template').value = ''; } };
  }
  document.getElementById = id => id === 'open' ? null : elements.get(id) || (elements.set(id, element(id)), elements.get(id));
  let onState, invoke = async () => ({ ok: true });
  const calls = [];
  vm.runInNewContext(fs.readFileSync(`${__dirname}/browser-renderer.js`, 'utf8'), {
    document, HTMLInputElement: class {}, window: { browserUI: {
      onState: callback => { onState = callback; },
      command: (...args) => { calls.push(args); return invoke(...args); },
    } },
  });
  const state = { settingsOpen: true, homepage: 'https://example.com/', clearing: false, error: '',
    search: { enabled: true, provider: 'duckduckgo', customProviders: [] }, builtins: [], url: '', back: false, forward: false };
  onState(state);
  const get = id => document.getElementById(id);
  function draft() { get('add-provider').onclick(); get('provider-name').value = 'My search'; get('provider-template').value = 'https://example.com/?q={query}'; get('provider-template').focus(); }
  return { get, draft, calls, state, pointer: target => listeners.get('pointerdown')({ target }), update: changes => onState({ ...state, ...changes }),
    respond: fn => { invoke = fn; }, submit: () => get('provider-popup').onsubmit({ preventDefault() {} }) };
}
function assertDraft(f) {
  assert.equal(f.get('provider-popup').hidden, false);
  assert.equal(f.get('provider-name').value, 'My search');
  assert.equal(f.get('provider-template').value, 'https://example.com/?q={query}');
}
test('typing survives unrelated loading, history and settings state notifications', () => {
  const f = fixture(); f.draft();
  for (const change of [{ loading: true }, { back: true, forward: true }, { homepage: 'https://other.example/' }]) {
    f.update(change); assertDraft(f);
  }
});
test('only own successful add acknowledgement closes and resets popup', async () => {
  const f = fixture(); f.draft(); let resolve;
  f.respond(() => new Promise(done => { resolve = done; }));
  const pending = f.submit();
  f.update({ search: { ...f.state.search, customProviders: [{ id: 'custom-new', name: 'My search' }] } });
  assertDraft(f);
  resolve({ ok: true, error: '' }); await pending;
  assert.equal(f.calls[0][0], 'search-add');
  assert.equal(f.get('provider-popup').hidden, true);
  assert.equal(f.get('provider-name').value, ''); assert.equal(f.get('provider-template').value, '');
});
test('failed validation retains draft and acknowledged error', async () => {
  const f = fixture(); f.draft();
  f.respond(async () => { f.update({ error: 'Invalid provider' }); return { ok: false, error: 'Invalid provider' }; });
  await f.submit(); assertDraft(f); assert.equal(f.get('settings-status').textContent, 'Invalid provider');
});
test('rejected or missing acknowledgement never clears draft', async () => {
  const f = fixture(); f.draft();
  f.respond(async () => { throw new Error('IPC failed'); });
  await f.submit(); assertDraft(f); assert.match(f.get('settings-status').textContent, /Unable/);
  f.respond(async () => undefined); await f.submit(); assertDraft(f);
});
test('explicit Cancel closes and resets draft', () => {
  const f = fixture(); f.draft(); f.get('cancel-provider').onclick();
  assert.equal(f.get('provider-popup').hidden, true);
  f.get('add-provider').onclick(); assert.equal(f.get('provider-name').value, ''); assert.equal(f.get('provider-template').value, '');
});

test('outside pointer dismisses Browser Settings without dismissing the browser', () => {
  const f = fixture();
  f.pointer({ parent: { parent: f.get('browser-settings') } }); f.pointer(f.get('settings'));
  assert.equal(f.calls.length, 0, 'inside panel or gear does not dismiss');
  f.pointer(f.get('address'));
  assert.deepEqual(f.calls, [['settings', false]]);
  f.update({ settingsOpen: false }); f.pointer(f.get('address'));
  assert.equal(f.calls.length, 1, 'closed panel cannot send repeated dismissals');
});

test('browser settings visibility switch sends the shared setting', async () => {
  const f = fixture();
  assert.equal(f.get('show-browser-icon').checked, true);
  f.get('show-browser-icon').checked = false; await f.get('show-browser-icon').onchange();
  assert.deepEqual(f.calls, [['show-icon', false]]);
  f.update({ showIcon: false }); assert.equal(f.get('show-browser-icon').checked, false);
});

test('failed browser visibility save restores the switch', async () => {
  const f = fixture();
  f.respond(async () => ({ ok: false, error: 'Could not save' }));
  f.get('show-browser-icon').checked = false;
  await f.get('show-browser-icon').onchange();
  assert.equal(f.get('show-browser-icon').checked, true);
  assert.equal(f.get('show-browser-icon').disabled, false);
});
