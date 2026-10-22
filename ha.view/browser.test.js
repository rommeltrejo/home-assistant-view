'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { externalURL, geometry } = require('./browser-policy');
const { install, createSettings } = require('./browser');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
function fixture(settings, hookOwnership = false) {
  const views = [], handlers = new Map(), interactions = [];
  class View {
    constructor(options) { this.options = options; this.webContents = new EventEmitter(); Object.assign(this.webContents, { mainFrame: {}, isDestroyed: () => this.closed || false, close: () => { this.closed = true; }, setWindowOpenHandler: h => this.popup = h, loadFile: async f => { this.file = f; }, loadURL: async url => { this.url = url; }, getURL: () => this.url || '', focus() {}, send: (_channel, state) => { this.state = state; }, isLoading: () => false, reload: () => this.reloaded = true, navigationHistory: { canGoBack: () => true, canGoForward: () => true, goBack: () => this.back = true, goForward: () => this.forward = true } }); views.push(this); }
    setVisible(v) { this.visible = v; } setBounds(b) { this.bounds = b; } setBackgroundColor() {}
  }
  const browsing = new EventEmitter(); Object.assign(browsing, { setPermissionRequestHandler: h => browsing.permission = h, setPermissionCheckHandler: h => browsing.check = h, webRequest: { onBeforeRequest: h => browsing.request = h }, clearStorageData: async () => {}, clearCache: async () => {}, clearAuthCache: async () => {} });
  const parent = new EventEmitter(); Object.assign(parent, { getContentBounds: () => ({ width: 1000, height: 800 }), isDestroyed: () => false, contentView: { addChildView(view) { assert.ok(view instanceof View, 'Native child must be a View'); }, removeChildView() {} } });
  let off = false, wake = false, allowed = true;
  const dispose = install({ settings, electron: { WebContentsView: View, ipcMain: { handle: (c, h) => handlers.set(c, h), removeHandler: c => handlers.delete(c) }, session: { fromPartition: p => { browsing.partition = p; return browsing; } } }, parent, allowed: () => allowed, off: () => off, wakeBlocked: () => wake, interaction: v => { interactions.push(v); if (hookOwnership) allowed = !v; } });
  const command = (view, action, value, frame = view.webContents.mainFrame) => handlers.get('ha.view:browser')({ sender: view.webContents, senderFrame: frame }, action, value);
  return { views, browsing, parent, interactions, dispose, command, setOff: v => off = v, setWake: v => wake = v, setAllowed: v => allowed = v };
}
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'about:blank', 'chrome://settings', 'data:text/html,x', 'ftp://x', 'https://u:p@example.com', 'https://example.com\n', '//example.com']) test(`reject ${JSON.stringify(url)}`, () => assert.throws(() => externalURL(url)));
test('explicit HTTP/HTTPS URLs accepted', () => { assert.equal(externalURL('https://example.com'), 'https://example.com/'); assert.equal(externalURL('http://127.0.0.1:123/a'), 'http://127.0.0.1:123/a'); });
test('responsive bounds remain inside parent including small screens', () => { for (const [w,h] of [[1000,800],[390,844],[320,240],[120,100]]) { const b = geometry(w,h); for (const r of Object.values(b)) { assert.ok(r.x >= 0 && r.y >= 0 && r.x+r.width <= w && r.y+r.height <= h); } } });
test('launcher single button and modal practical blank without external provider', () => { const fs = require('node:fs'); const html = fs.readFileSync(`${__dirname}/browser-launcher.html`,'utf8'); assert.equal((html.match(/<button /g)||[]).length,1); assert.match(html,/Open browser/); assert.match(fs.readFileSync(`${__dirname}/browser.html`,'utf8'),/Website address/); });
test('security prefs and ephemeral session deny grants, requests, downloads, popups', async () => { const f = fixture(); await f.command(f.views[0],'open'); const page=f.views[2]; assert.deepEqual(page.options.webPreferences, { sandbox:true, contextIsolation:true, nodeIntegration:false, session:f.browsing }); assert.ok(!f.browsing.partition.startsWith('persist:')); assert.deepEqual(page.popup(),{action:'deny'}); let granted; f.browsing.permission(null,'camera',v=>granted=v); assert.equal(granted,false); assert.equal(f.browsing.check(),false); let prevented=false; f.browsing.emit('will-download',{preventDefault:()=>prevented=true}); assert.ok(prevented); f.browsing.request({url:'file:///x'},r=>assert.ok(r.cancel)); f.dispose(); });
test('IPC only launcher opens and shell mainFrame controls, never external page', async () => { const f=fixture(); await assert.rejects(f.command(f.views[0],'open',null,{})); await f.command(f.views[0],'open'); await assert.rejects(f.command(f.views[2],'navigate','https://example.com')); await assert.rejects(f.command(f.views[1],'reload',null,{})); await assert.rejects(f.command(f.views[1],'unknown')); f.dispose(); });
test('navigation/history/reload, protocol guards and close/reopen lifecycle', async () => { const f=fixture(); await f.command(f.views[0],'open'); const shell=f.views[1],page=f.views[2]; await f.command(shell,'navigate','javascript:alert(1)'); assert.equal(page.url,'https://duckduckgo.com/'); await f.command(shell,'navigate','https://example.com'); assert.equal(page.url,'https://example.com/'); for(const action of ['back','forward','reload']) await f.command(shell,action); assert.ok(page.back && page.forward && page.reloaded); let prevented=false; page.webContents.emit('will-redirect',{preventDefault:()=>prevented=true},'file:///x'); assert.ok(prevented); await f.command(shell,'close'); assert.ok(shell.closed && page.closed); assert.deepEqual(f.interactions,[true,false]); assert.ok(f.views[0].visible); await assert.rejects(f.command(shell,'reload')); await f.command(f.views[0],'open'); assert.notEqual(f.views[3],shell); f.dispose(); });
test('Escape closes, blocked settings/wake/off cannot open, resize preserves contents', async () => { const f=fixture(); f.setWake(true); await assert.rejects(f.command(f.views[0],'open')); f.setWake(false); f.setAllowed(false); await f.command(f.views[0],'open'); assert.equal(f.views.length,1); f.setAllowed(true); await f.command(f.views[0],'open'); const page=f.views[2]; f.parent.emit('resize'); assert.equal(f.views[2],page); f.views[1].webContents.emit('before-input-event',{preventDefault(){}},{type:'keyDown',key:'Escape'}); assert.ok(page.closed); f.setOff(true); await assert.rejects(f.command(f.views[0],'open')); f.dispose(); });

test('forced display-off hides launcher and closes page; wake release keeps icon hidden', async () => { const f=fixture(); await f.command(f.views[0],'open'); f.dispose.power(true); assert.ok(f.views[2].closed); assert.equal(f.views[0].visible,false); await assert.rejects(f.command(f.views[0],'open')); f.setWake(true); f.dispose.power(false); assert.equal(f.views[0].visible,false); f.setWake(false); f.dispose.sync(); assert.equal(f.views[0].visible,true); f.dispose(); });

test('typed host/path addresses default to HTTPS, preserving explicit schemes', () => {
  for (const [input, expected] of [
    ['google.com', 'https://google.com/'], ['google.com/path?q=one#two', 'https://google.com/path?q=one#two'],
    ['example.com:8443/path', 'https://example.com:8443/path'], ['localhost:8123', 'https://localhost:8123/'],
    ['localhost/path', 'https://localhost/path'], ['127.0.0.1:8123/path', 'https://127.0.0.1:8123/path'],
    ['[::1]:8123/path', 'https://[::1]:8123/path'], ['http://google.com/path', 'http://google.com/path'],
    ['https://google.com/path', 'https://google.com/path']
  ]) assert.equal(externalURL(input, true), expected, input);
});
test('typed addresses reject schemes, credentials, controls and malformed authorities', () => {
  for (const input of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', 'ftp://example.com', 'about:blank',
    'javascript:443', 'http:example.com', 'https:/example.com', '//example.com', '/example.com',
    'https:///example.com', 'https://@example.com', 'user:pass@example.com', 'user@example.com',
    'https://u:p@example.com', 'https://example.com\\evil', 'example.com\n', 'example.com\u0085',
    'example.com:bad', 'example.com:', 'example.com:65536', 'example..com', '-example.com',
    'example.com%2f.evil.com', '[not-ip]:8123', '999.999.999.999', 'search words', '', null]) {
    assert.throws(() => externalURL(input, true), String(input));
  }
});
test('address DOM declaration permits scheme-less native submission and explains HTTPS', () => {
  const html = require('node:fs').readFileSync(`${__dirname}/browser.html`, 'utf8');
  const input = html.match(/<input\b[^>]*id="address"[^>]*>/)[0];
  assert.match(input, /type="text"/); assert.doesNotMatch(input, /type="url"|pattern=/);
  assert.match(input, /inputmode="url"/); assert.match(input, /placeholder="duckduckgo.com/);
  assert.match(input, /aria-describedby="address-help"/);
  assert.match(html, /id="address-help">.*HTTPS is added automatically/);
});
test('only typed navigation completes HTTPS; redirects, frame navigation and requests stay strict', async () => {
  const f = fixture();
  try {
    await f.command(f.views[0], 'open'); const shell = f.views[1], page = f.views[2];
    await f.command(shell, 'navigate', 'google.com/path'); assert.equal(page.url, 'https://google.com/path');
    await f.command(shell, 'navigate', 'localhost:8123'); assert.equal(page.url, 'https://localhost:8123/');
    await f.command(shell, 'navigate', 'http://127.0.0.1:8123/path'); assert.equal(page.url, 'http://127.0.0.1:8123/path');
    for (const input of ['google.com/path', '//example.com', 'javascript:alert(1)', 'https://u:p@example.com', 'https:///example.com']) {
      assert.throws(() => externalURL(input));
      for (const name of ['will-redirect', 'will-navigate', 'will-frame-navigate']) {
        let prevented = false; page.webContents.emit(name, { preventDefault: () => prevented = true }, input);
        assert.equal(prevented, true, `${name}: ${input}`);
      }
      f.browsing.request({ url: input }, result => assert.equal(result.cancel, true));
    }
    for (const input of ['https://example.com/path', 'http://localhost:8123/path']) {
      let prevented = false; page.webContents.emit('will-redirect', { preventDefault: () => prevented = true }, input);
      assert.equal(prevented, false); f.browsing.request({ url: input }, result => assert.equal(result.cancel, false));
    }
  } finally { f.dispose(); }
});

test('homepage opens on each open and settings only hide the isolated page', async () => {
  const f = fixture();
  try {
    await f.command(f.views[0], 'open');
    assert.equal(f.views[2].url, 'https://duckduckgo.com/');
    await f.command(f.views[1], 'settings', true); assert.equal(f.views[2].visible, false);
    assert.equal(f.views[1].state.homepage, 'https://duckduckgo.com/');
    await f.command(f.views[1], 'settings', false); assert.equal(f.views[2].visible, true);
    await f.command(f.views[1], 'close'); await f.command(f.views[0], 'open');
    assert.equal(f.views[4].url, 'https://duckduckgo.com/');
  } finally { f.dispose(); }
});
test('website and subframe cannot use settings, homepage or clear IPC', async () => {
  const f = fixture();
  try {
    await f.command(f.views[0], 'open');
    for (const [action, value] of [['settings', true], ['homepage', 'example.com'], ['clear', true]]) {
      await assert.rejects(f.command(f.views[2], action, value));
      await assert.rejects(f.command(f.views[1], action, value, {}));
      await assert.rejects(f.command(f.views[0], action, value));
    }
    await assert.rejects(f.command(f.views[1], 'settings', {}));
    await assert.rejects(f.command(f.views[1], 'clear', true));
  } finally { f.dispose(); }
});
test('clear waits for all isolated operations, closes page/history and survives close/reopen', async () => {
  const f = fixture(); let release; const pending = new Promise(resolve => release = resolve); const calls = [];
  for (const name of ['clearStorageData', 'clearCache', 'clearAuthCache']) f.browsing[name] = () => { calls.push(name); return pending; };
  try {
    await f.command(f.views[0], 'open'); const shell = f.views[1], old = f.views[2];
    await f.command(shell, 'settings', true);
    const first = f.command(shell, 'clear', true), second = f.command(shell, 'clear', true);
    assert.ok(old.closed); assert.equal(shell.state.clearing, true); assert.equal(calls.length, 3);
    let historyCalls = 0; old.webContents.navigationHistory.goBack = () => historyCalls++;
    f.parent.emit('swipe', {}, 'right'); assert.equal(historyCalls, 0);
    assert.doesNotThrow(() => f.dispose.sync());
    assert.doesNotThrow(() => f.parent.emit('resize'));
    await f.command(shell, 'settings', false);
    f.parent.emit('swipe', {}, 'right'); assert.equal(historyCalls, 0);
    await f.command(shell, 'settings', true);
    await assert.rejects(f.command(shell, 'navigate', 'example.com'));
    await f.command(shell, 'close'); await f.command(f.views[0], 'open');
    assert.equal(f.views.length, 4);
    assert.doesNotThrow(() => f.dispose.sync());
    assert.doesNotThrow(() => f.parent.emit('resize'));
    release(); await Promise.all([first, second]);
    assert.equal(f.views[4].url, 'https://duckduckgo.com/'); assert.equal(f.views[3].state.clearing, false);
    assert.equal(f.views[3].state.homepage, 'https://duckduckgo.com/');
  } finally { release(); f.dispose(); }
});
test('clear failure is honest and recoverable without changing homepage', async () => {
  const f = fixture();
  try {
    f.browsing.clearCache = async () => { throw new Error('failure'); };
    await f.command(f.views[0], 'open'); await f.command(f.views[1], 'settings', true);
    await f.command(f.views[1], 'clear', true);
    assert.match(f.views[1].state.error, /could not be cleared/);
    assert.equal(f.views[1].state.clearing, false); assert.equal(f.views[3].url, 'https://duckduckgo.com/');
    f.browsing.clearCache = async () => {};
    await f.command(f.views[1], 'clear', true); assert.match(f.views[1].state.error, /Homepage kept/);
  } finally { f.dispose(); }
});
test('dispose during clearing does not recreate a website or send to destroyed shell', async () => {
  const f = fixture(); let release;
  f.browsing.clearCache = () => new Promise(resolve => release = resolve);
  await f.command(f.views[0], 'open'); await f.command(f.views[1], 'settings', true);
  const pending = f.command(f.views[1], 'clear', true); f.dispose(); release(); await pending;
  assert.equal(f.views.length, 3); assert.ok(f.views.every(view => view.closed));
});

test('shell saves homepage and next open uses it, clear never calls preference save', async () => {
  let homepage = 'https://duckduckgo.com/', saves = 0;
  const settings = { get homepage() { return homepage; }, error: '', save(value) { homepage = externalURL(value, true); saves++; } };
  const f = fixture(settings);
  try {
    await f.command(f.views[0], 'open'); await f.command(f.views[1], 'homepage', 'example.com/path');
    assert.equal(f.views[1].state.homepage, 'https://example.com/path');
    await f.command(f.views[1], 'close'); await f.command(f.views[0], 'open');
    assert.equal(f.views[4].url, homepage);
    await f.command(f.views[3], 'settings', true); await f.command(f.views[3], 'clear', true);
    assert.equal(saves, 1); assert.equal(f.views[5].url, homepage);
  } finally { f.dispose(); }
});
test('search IPC requires trusted awake shell settings and uses validated selected provider', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-browser-search-ipc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = require('./browser').createSettings(path.join(dir, 'browser-settings.json')), f = fixture(settings);
  try {
    await f.command(f.views[0], 'open'); const shell = f.views[1], page = f.views[2];
    await f.command(shell, 'navigate', 'hello world'); assert.equal(page.url, 'https://duckduckgo.com/?q=hello%20world');
    await assert.rejects(f.command(shell, 'search-enabled', false));
    await f.command(shell, 'settings', true);
    for (const action of ['search-enabled', 'search-provider', 'search-add', 'search-remove']) {
      await assert.rejects(f.command(page, action, false)); await assert.rejects(f.command(shell, action, false, {}));
      f.setWake(true); await assert.rejects(f.command(shell, action, false)); f.setWake(false);
    }
    await f.command(shell, 'search-provider', 'bing'); await f.command(shell, 'navigate', 'hello world');
    assert.equal(page.url, 'https://www.bing.com/search?q=hello%20world'); assert.equal(page.visible, false);
    await f.command(shell, 'search-enabled', false); await f.command(shell, 'navigate', 'other words'); assert.equal(page.url, 'https://www.bing.com/search?q=hello%20world');
    await f.command(shell, 'navigate', 'example.com'); assert.equal(page.url, 'https://example.com/');
    await f.command(shell, 'search-enabled', true);
    for (const v of ['javascript:alert(1)', 'user@example.com', 'https:/example.com']) { await f.command(shell, 'navigate', v); assert.equal(page.url, 'https://example.com/'); }
  } finally { f.dispose(); }
});
test('explicit settings Close returns same webpage without closing browser', async () => {
  const html = require('node:fs').readFileSync(`${__dirname}/browser.html`, 'utf8');
  const renderer = require('node:fs').readFileSync(`${__dirname}/browser-renderer.js`, 'utf8');
  assert.match(html, /id="close-settings"/); assert.match(renderer, /\$\('close-settings'\)\.onclick = \(\) => command\('settings', false\)/);
  const f = fixture();
  try { await f.command(f.views[0], 'open'); const shell = f.views[1], page = f.views[2];
    await f.command(shell, 'settings', true); assert.equal(page.visible, false);
    await f.command(shell, 'settings', false); assert.equal(page.visible, true); assert.ok(!shell.closed && !page.closed); assert.equal(f.views.length, 3);
  } finally { f.dispose(); }
});

test('browser edit IPC uses native shell methods only and rejects website/subframe/blocked senders', async () => {
  const f = fixture();
  try {
    await f.command(f.views[0], 'open'); const shell = f.views[1], page = f.views[2];
    for (const action of ['selectAll', 'copy', 'paste', 'cut', 'undo']) {
      let calls = 0; shell.webContents[action] = () => calls++;
      await f.command(shell, 'edit', action); assert.equal(calls, 1);
      await assert.rejects(f.command(page, 'edit', action));
      await assert.rejects(f.command(shell, 'edit', action, {}));
      f.setWake(true); await assert.rejects(f.command(shell, 'edit', action)); f.setWake(false);
      f.setOff(true); await assert.rejects(f.command(shell, 'edit', action)); f.setOff(false);
      assert.equal(calls, 1);
    }
    await assert.rejects(f.command(shell, 'edit', 'reload'));
  } finally { f.dispose(); }
});

test('isolated gesture reports require secret and main frame, guard history and debounce native duplicates', async () => {
  const f = fixture();
  try {
    await f.command(f.views[0], 'open'); const page = f.views[2], shell = f.views[1]; let source, calls = 0;
    page.webContents.executeJavaScriptInIsolatedWorld = async (world, scripts) => { assert.equal(world, 1004); source = scripts[0].code; };
    page.webContents.emit('did-finish-load');
    const token = source.match(/ha\.view-gesture-[a-f0-9-]+/)[0];
    page.webContents.navigationHistory.goBack = () => calls++;
    const report = (message = token + ':back', frame = page.webContents.mainFrame) => page.webContents.emit('console-message', { message, frame });
    report('forged:back'); report(token + ':back', {}); assert.equal(calls, 0);
    await f.command(shell, 'settings', true); report(); assert.equal(calls, 0);
    await f.command(shell, 'settings', false);
    f.setOff(true); report(); f.setOff(false); f.setWake(true); report(); f.setWake(false);
    assert.equal(calls, 0);
    page.webContents.navigationHistory.canGoBack = () => false; report(); assert.equal(calls, 0);
    page.webContents.navigationHistory.canGoBack = () => true;
    report(); report(); f.parent.emit('swipe', {}, 'right'); assert.equal(calls, 1);
    f.dispose(); assert.equal(f.parent.listenerCount('swipe'), 0); report(); assert.equal(calls, 1);
  } finally { f.dispose(); }
});

test('real hooks admission becomes false on browser ownership but both gesture directions navigate', async () => {
  for (const direction of ['back', 'forward']) {
    const f = fixture(undefined, true);
    try {
      await f.command(f.views[0], 'open');
      const shell = f.views[1], page = f.views[2];
      let source, calls = 0;
      page.webContents.executeJavaScriptInIsolatedWorld = async (_world, scripts) => { source = scripts[0].code; };
      page.webContents.emit('did-finish-load');
      const token = source.match(/ha\.view-gesture-[a-f0-9-]+/)[0];
      page.webContents.navigationHistory[direction === 'back' ? 'goBack' : 'goForward'] = () => { calls++; page.url = `https://example.com/${direction}`; };
      const report = () => page.webContents.emit('console-message', { message: `${token}:${direction}`, frame: page.webContents.mainFrame });
      f.dispose.sync(); assert.equal(f.views[0].visible, false);
      await f.command(shell, 'settings', true); report();
      await f.command(shell, 'settings', false);
      f.setOff(true); report(); f.setOff(false);
      f.setWake(true); report(); f.setWake(false);
      page.webContents.isLoading = () => true; report(); page.webContents.isLoading = () => false;
      assert.equal(calls, 0);
      report(); assert.equal(calls, 1); assert.equal(page.url, `https://example.com/${direction}`);
      f.dispose.power(true); report(); assert.equal(calls, 1);
      await assert.rejects(f.command(f.views[0], 'open'));
      f.dispose(); report(); assert.equal(calls, 1);
    } finally { f.dispose(); }
  }
});

test('search add IPC acknowledges persisted success and validation failure explicitly', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-browser-add-ack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture(require('./browser').createSettings(path.join(dir, 'browser-settings.json')));
  try {
    await f.command(f.views[0], 'open'); await f.command(f.views[1], 'settings', true);
    const success = await f.command(f.views[1], 'search-add', { name: 'Acknowledged', template: 'https://example.com/?q={query}' });
    assert.deepEqual(success, { ok: true, error: '' });
    assert.equal(f.views[1].state.search.customProviders.length, 1);
    const failure = await f.command(f.views[1], 'search-add', { name: '', template: 'invalid' });
    assert.equal(failure.ok, false); assert.match(failure.error, /not saved/);
    assert.equal(failure.error, f.views[1].state.error);
    assert.equal(f.views[1].state.search.customProviders.length, 1);
  } finally { f.dispose(); }
});

test('shared browser visibility closes active page, hides launcher and rejects all IPC until enabled', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-browser-visibility-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = createSettings(path.join(dir, 'browser.json'));
  const f = fixture(settings);
  try {
    await f.command(f.views[0], 'open');
    const shell = f.views[1], page = f.views[2];
    await f.command(shell, 'settings', true);
    await assert.rejects(f.command(page, 'show-icon', false));
    await f.command(shell, 'show-icon', false);
    assert.equal(settings.showIcon, false); assert.equal(shell.closed, true); assert.equal(page.closed, true);
    assert.equal(f.views[0].visible, false);
    await assert.rejects(f.command(f.views[0], 'open'), /unavailable/);
    await assert.rejects(f.command(shell, 'navigate', 'example.com'), /unavailable/);
    settings.saveShowIcon(true);
    assert.equal(f.views[0].visible, true);
    await f.command(f.views[0], 'open');
    settings.saveShowIcon(false);
    assert.equal(f.views.at(-1).closed, true);
  } finally { f.dispose(); }
});
