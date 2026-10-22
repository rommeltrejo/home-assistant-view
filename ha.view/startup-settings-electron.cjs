/** Isolated actual index.js startup verifier; no hardware, integration or real-profile access. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
if (process.versions.electron) {
  const { app, dialog } = require('electron');
  const profile = process.env.HA_VIEW_STARTUP_PROFILE;
  const os = require('node:os');
  if (!profile || path.dirname(profile) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(profile).startsWith('ha-view-startup-electron-') ||
      fs.readFileSync(path.join(profile, '.startup-verifier'), 'utf8') !== 'isolated fixture')
    throw new Error('Owned temporary profile required');
  app.setPath('userData', profile);
  app.setPath('logs', path.join(profile, 'logs'));
  app.getAppPath = () => path.resolve(__dirname, '..');
  dialog.showErrorBox = (_title, message) => { console.error(message); app.exit(2); };
  // Stub BEFORE loading production index: no device modules, Bonjour, dashboard or UI.
  const forbidden = () => { throw new Error('Forbidden production initialization'); };
  const stub = (name, exports) => {
    const id = require.resolve(name);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  stub('../ha.view/startup-recovery', { ensureReachable: async args => args, dashboardReady() {} });
  stub('../js/hardware', { init: forbidden, getMachineId: forbidden });
  stub('../js/integration', { init: forbidden });
  stub('bonjour-service', forbidden);
  stub('../ha.view/installer-startup', { openInitialSettings: forbidden });
  const webview = {};
  stub('../js/webview', webview);
  webview.init = async () => {
    assert.ok(!global.ARGS.app_reset.includes('session'), 'startup must not clear browser auth');
    const { session, BrowserWindow } = require('electron');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    const cookies = session.defaultSession.cookies;
    if (process.env.HA_VIEW_STARTUP_FIRST === '1') {
      await cookies.set({ url: 'https://example.test/', name: 'startup-auth-fixture', value: 'preserved',
        expirationDate: Math.floor(Date.now() / 1000) + 86400 });
      await cookies.flushStore();
    }
    const auth = await cookies.get({ url: 'https://example.test/', name: 'startup-auth-fixture' });
    assert.equal(auth[0]?.value, 'preserved', 'auth cookie survives fresh-process startup');
    assert.equal(fs.readFileSync(path.join(profile, 'Local Storage', 'auth-sentinel'), 'utf8'), 'preserved');
    assert.equal(global.ARGS.web_url[0], process.env.HA_VIEW_EXPECTED_URL);
    assert.equal(global.ARGS.web_theme, process.env.HA_VIEW_EXPECTED_THEME || undefined);
    assert.equal(global.ARGS.ha_view_idle_ms, '9000');
    assert.equal(global.ARGS.ha_view_clock_face, '2');
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'Arguments.json'), 'utf8'));
    assert.equal(saved.ha_view_idle_ms, '9000');
    assert.equal(saved.ha_view_clock_face, '2');
    assert.equal(saved.web_url, process.env.HA_VIEW_EXPECTED_URL);
    if (process.env.HA_VIEW_STARTUP_FIRST !== '1') assert.deepEqual(saved.future_setting, { preserve: true });
    for (const key of ['app_debug', 'app_reset', 'user_data_dir', 'remote_debugging_port', 'trace_warnings']) assert.ok(!(key in saved));
    console.log('PASS production index.js isolated startup', JSON.stringify(saved));
    app.exit(0);
    return false;
  };
  setTimeout(() => app.exit(3), 20000).unref();
  require('../index');
} else {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ha-view-startup-electron-'));
  fs.writeFileSync(path.join(profile, '.startup-verifier'), 'isolated fixture');
  fs.mkdirSync(path.join(profile, 'Local Storage'));
  fs.writeFileSync(path.join(profile, 'Local Storage', 'auth-sentinel'), 'preserved');
  let count = 0;
  try {
    const run = (args, theme) => {
      const env = { ...process.env, HA_VIEW_STARTUP_PROFILE: profile, HA_VIEW_EXPECTED_URL: 'https://example.test/', HA_VIEW_EXPECTED_THEME: theme || '', HA_VIEW_STARTUP_FIRST: ++count === 1 ? '1' : '0' };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(require('electron'), [__filename, ...args], { env, encoding: 'utf8', timeout: 30000 });
      process.stdout.write(result.stdout || '');
      if (result.status !== 0) process.stderr.write(result.stderr || '');
      assert.equal(result.status, 0, result.error?.message || result.stderr);
    };
    run(['--web-url=https://example.test/', '--trace-warnings', '--app-debug', '--ha-view-idle-ms=9000', '--ha-view-clock-face=2']);
    const file = path.join(profile, 'Arguments.json');
    const saved = JSON.parse(fs.readFileSync(file));
    fs.writeFileSync(file, JSON.stringify({ ...saved, future_setting: { preserve: true } }));
    run([]);
    run(['--web-theme=light'], 'light');
    run([], 'light');
    console.log('PASS four fresh Electron processes: CLI, no args, single override, no-args restart');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
