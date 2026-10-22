'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const source = path.resolve(__dirname, '../../os/linux/kiosk/Run.sh');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'HA View direct run '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(source, path.join(root, 'Run.sh'));
  fs.chmodSync(path.join(root, 'Run.sh'), 0o755);
  fs.mkdirSync(path.join(root, 'payload'));
  return root;
}
test('direct launcher is executable and packaged explicitly without bypass', () => {
  assert.ok(fs.statSync(source).mode & 0o111);
  const build = fs.readFileSync(path.join(__dirname, 'linux-kiosk.js'), 'utf8');
  assert.match(build, /\['Run.sh', 'install.sh', 'install.py'/);
  assert.match(build, /fs.chmod/);
  assert.doesNotMatch(fs.readFileSync(source, 'utf8'), /--no-sandbox|sudo|npm|node /);
});
test('missing and non-executable payload fail clearly', t => {
  const root = fixture(t);
  let result = spawnSync(path.join(root, 'Run.sh'), [], { cwd: '/', encoding: 'utf8' });
  assert.equal(result.status, 127); assert.match(result.stderr, /missing bundled runtime/);
  fs.writeFileSync(path.join(root, 'payload/ha.view'), 'not executable', { mode: 0o644 });
  result = spawnSync(path.join(root, 'Run.sh'), [], { cwd: '/', encoding: 'utf8' });
  assert.equal(result.status, 126); assert.match(result.stderr, /not executable/);
});
test('spaced paths, unrelated cwd, exact args and nonzero runtime exit', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'payload/ha.view'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\nexit 37\n', { mode: 0o755 });
  const args = ['hello world', '', '"quoted"', '*', '--web-url=http://host/a b', '; echo unsafe'];
  const result = spawnSync(path.join(root, 'Run.sh'), args, { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 37);
  assert.equal(result.stdout, [fs.realpathSync(os.tmpdir()), ...args].join('\n') + '\n');
});
test('exec preserves PID and TERM signal without a launcher child', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'payload/ha.view'), '#!/bin/sh\necho $$\nexec sleep 30\n', { mode: 0o755 });
  const child = spawn(path.join(root, 'Run.sh'));
  t.after(() => child.kill('SIGKILL'));
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const pid = await new Promise(resolve => child.stdout.once('data', data => resolve(Number(data.toString().trim()))));
  assert.equal(pid, child.pid); child.kill('SIGTERM');
  assert.deepEqual(await done, { code: null, signal: 'SIGTERM' });
});
