/** HA.View initial-settings policy and native IPC tests. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { inspect, decision, validateURL, saveURL } = require('../initial-settings');
const { openInitialSettings } = require('../installer-startup');
const { run, validateArtifacts } = require('./launcher');
const fixture = callback => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-initial-'));
  try { return callback(path.join(dir, 'Arguments.json')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
test('missing and empty objects open native; saved config and explicit CLI retain original path', () => fixture(file => {
  assert.equal(inspect(file).kind, 'missing');
  assert.equal(decision(inspect(file), {}, false, true), 'native');
  fs.writeFileSync(file, '{}');
  assert.equal(inspect(file).kind, 'empty');
  assert.equal(decision(inspect(file), {}, true, false), 'native');
  assert.equal(decision(inspect(file), { web_url: 'https://local/' }, true, false), 'existing');
  assert.equal(decision(inspect(file), { setup: null }, false, false), 'terminal');
  assert.equal(decision(inspect(file), { setup: null }, true, false), 'native');
  assert.equal(decision(inspect(file), { setup: null }, true, true), 'terminal');
  fs.writeFileSync(file, '{"web_url":"https://saved.test","web_theme":"dark"}');
  assert.equal(decision(inspect(file), {}, true, false), 'existing');
  assert.equal(inspect(file).value.web_theme, 'dark');
}));
test('malformed config remains untouched; save persists only validated URL', () => fixture(file => {
  fs.writeFileSync(file, '{invalid');
  assert.equal(inspect(file).kind, 'error');
  assert.equal(decision(inspect(file), {}, true, false), 'error');
  assert.throws(() => saveURL(file, 'https://test.local', 'empty'), /changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
  fs.writeFileSync(file, '{}');
  for (const bad of ['', 'file:///tmp', 'javascript:alert(1)', 'https://u:p@test.local']) assert.throws(() => validateURL(bad));
  assert.deepEqual(saveURL(file, ' https://test.local:8123/ ', 'empty'), { web_url: 'https://test.local:8123/' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { web_url: 'https://test.local:8123/' });
}));
test('native settings rejects other sender and subframes, handles cancel and removes IPC handler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-initial-'));
  const file = path.join(dir, 'Arguments.json');
  try {
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      const wc = this.webContents; wc.mainFrame = { url: require('node:url').pathToFileURL(path.resolve(__dirname, '../initial-settings.html')).href };
      wc.getURL = () => wc.mainFrame.url; wc.isDestroyed = () => false;
      wc.setWindowOpenHandler = handler => { assert.equal(handler().action, 'deny'); };
      Window.current = this;
    }
    loadFile() { return Promise.resolve(); }
    show() {}
    hide() {}
    close() { this.emit('closed'); }
  }
  const handlers = new Map();
  const electron = { app: new EventEmitter(), BrowserWindow: Window, ipcMain: { handle: (key, cb) => handlers.set(key, cb), removeHandler: key => handlers.delete(key) }, dialog: { showErrorBox: () => assert.fail('unexpected dialog') } };
  const pending = openInitialSettings(file, 'missing', electron);
  const wc = Window.current.webContents;
  const save = handlers.get('ha.view:initial-settings:save');
  assert.throws(() => save({ sender: {}, senderFrame: wc.mainFrame }, 'https://test.local'), /Untrusted/);
  assert.throws(() => save({ sender: wc, senderFrame: {} }, 'https://test.local'), /Untrusted/);
  const event = { preventDefault() { this.blocked = true; } };
  wc.emit('will-navigate', event, 'https://evil.example'); assert.equal(event.blocked, true);
  assert.equal(fs.existsSync(file), false);
  Window.current.close(); assert.equal(await pending, null);
  assert.equal(handlers.size, 0);
  const second = openInitialSettings(file, 'missing', electron);
  const next = Window.current.webContents;
  handlers.get('ha.view:initial-settings:save')({ sender: next, senderFrame: next.mainFrame }, 'http://home.local:8123');
  assert.deepEqual(await second, { web_url: 'http://home.local:8123/' });
  assert.equal(handlers.size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('Linux host is rejected before packaging', async () => {
  await assert.rejects(run(['win32'], { host: { platform: 'linux' } }), /macOS and Windows/);
});
test('portable requires nonempty EXE, rejects setup, blockmap, Squirrel and ZIP artifacts', async () => {
  const target = { platform: 'win32', arch: 'x64' };
  const stat = async () => ({ isFile: () => true, size: 10 });
  const result = artifacts => [{ ...target, artifacts }];
  const artifacts = ['/out/ha.view-1.6.0-x64.exe'];
  assert.deepEqual(await validateArtifacts(result(artifacts), target, stat), artifacts);
  await assert.rejects(validateArtifacts(result(artifacts), target, async () => ({ isFile: () => true, size: 0 })), /empty/);
  await assert.rejects(validateArtifacts(result(['/out/ha.view-Setup.exe']), target, stat));
  for (const extra of ['RELEASES', 'a.nupkg', 'a.zip', 'a.exe.blockmap', 'ha.view-Setup.exe']) {
    await assert.rejects(validateArtifacts(result(['/out/a.exe', '/out/' + extra]), target, stat));
  }
});
test('Chromium switches are not configuration and explicit native setup preserves keys with race guard', () => fixture(file => {
  assert.equal(decision(inspect(file), { user_data_dir: '/tmp/profile', trace_warnings: null }, false, false), 'native');
  fs.writeFileSync(file, JSON.stringify({web_url:'https://old.local/',web_theme:'light',app_kiosk:'framed'}));
  const snapshot = inspect(file);
  assert.deepEqual(saveURL(file,'http://new.local:8123/',snapshot), {web_url:'http://new.local:8123/',web_theme:'light',app_kiosk:'framed'});
  assert.throws(() => saveURL(file,'https://race.local/',snapshot), /changed/);
}));
test('missing parent directory is created only when saving', () => fixture(file => {
  const nested=path.join(path.dirname(file),'new','Arguments.json');
  assert.equal(inspect(nested).kind,'missing');
  saveURL(nested,'http://local.test/',{kind:'missing'});
  assert.equal(inspect(nested).value.web_url,'http://local.test/');
}));
