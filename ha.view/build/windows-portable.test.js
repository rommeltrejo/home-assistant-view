'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const kiosk = require('./windows-kiosk');
const portable = require('./windows-portable');
const root = path.resolve(__dirname, '../..');
test('direct launcher uses quoted self-relative payload, forwards CLI and preserves exit status without installation', async () => {
  const text = await fs.readFile(path.join(root, 'os/windows/portable/Run.cmd'), 'utf8');
  assert.match(text, /setlocal DisableDelayedExpansion/);
  assert.match(text, /if not exist "%~dp0payload\\ha.view.exe"/);
  assert.match(text, /pushd "%~dp0payload"\r\nif errorlevel 1 exit \/b 1/);
  assert.match(text, /"%~dp0payload\\ha.view.exe" %\*/);
  assert.match(text, /set "result=%errorlevel%"\r\npopd\r\nexit \/b %result%/);
  assert.doesNotMatch(text, /node|npm|powershell|start |install|setup-development|watchdog|Unblock|ExecutionPolicy/i);
});
test('optional scripts exclusively map native fixed operations and report errors', async () => {
  for (const [name, operation] of [['Install-Kiosk', 'setup-development'], ['Update-Kiosk', 'update-development']]) {
    const text = await fs.readFile(path.join(root, 'os/windows/portable', name + '.cmd'), 'utf8');
    assert.match(text, /setlocal DisableDelayedExpansion/);
    assert.ok(text.includes('"%~dp0kiosk\\HA.View.Kiosk.exe" ' + operation));
    assert.match(text, /set "result=%errorlevel%"/);
    assert.match(text, /exit \/b %result%/);
    assert.doesNotMatch(text, /node|npm|powershell|Unblock|ExecutionPolicy|SHA256|-Bundle/i);
  }
});
async function fixture(change) {
  const zip = new JSZip();
  const files = [['payload/ha.view.exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)])],
    ['payload/resources/app/package.json', Buffer.from(JSON.stringify({name:'ha.view',version:'1.6.0',main:'index.js'}))],
    ['payload/resources/app/index.js', Buffer.from('// app')]];
  const inner = [...files, ...kiosk.scripts.map(name => [name, Buffer.from(name.endsWith('.exe') ? 'MZnative' : 'fixture')])];
  for (const [name, data] of files) zip.file(name, data, {createFolders:false});
  for (const [name, data] of inner) zip.file('kiosk/' + name, data, {createFolders:false});
  zip.file('kiosk/manifest.json', JSON.stringify({schema:1,platform:'win32',arch:'x64',version:'1.6.0',executable:'payload/ha.view.exe',signing:'unsigned-development',files:inner.map(([name,data])=>({path:name,size:data.length,sha256:kiosk.digest(data)}))}), {createFolders:false});
  for (const name of portable.launchers) zip.file(name, await fs.readFile(path.join(root,'os/windows/portable',name)), {createFolders:false});
  if (change) change(zip);
  return zip.generateAsync({type:'nodebuffer'});
}
test('archive validates complete isolated kiosk and byte-identical direct payload; rejects corruption and extras', async () => {
  assert.equal((await portable.validateZip(await fixture())).signing, 'unsigned-development');
  for (const change of [z=>z.remove('Run.cmd'), z=>z.file('Run.cmd','changed'), z=>z.file('payload/ha.view.exe','bad'), z=>z.remove('kiosk/HA.View.Kiosk.exe'), z=>z.file('payload/extra.txt','extra'), z=>z.file('other.txt','extra'), z=>z.file('PAYLOAD/ha.view.exe','alias'), z=>z.file('../escape','bad')]) {
    await assert.rejects(portable.validateZip(await fixture(change)));
  }
});
test('portable configuration reuses existing win32 packager without signing/publishing', () => {
  const cfg = kiosk.config();
  assert.equal(cfg.packagerConfig.executableName, 'ha.view');
  assert.equal(cfg.packagerConfig.win32Sign, undefined);
  assert.equal(cfg.packagerConfig.asar, false);
  assert.deepEqual(cfg.publishers, []);
  assert.throws(()=>cfg.hooks.prePackage(null,'darwin','x64'));
});
