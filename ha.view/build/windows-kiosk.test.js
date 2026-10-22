'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const JSZip = require('jszip');
const { scripts, safePath, config, parse, build, validateZip, digest } = require('./windows-kiosk');
const root = path.resolve(__dirname, '../..');
async function fixture(change) {
  const zip = new JSZip();
  const exe = Buffer.alloc(128); exe.write('MZ');
  const files = new Map([
    ['payload/ha.view.exe', exe],
    ['payload/resources/app/package.json', Buffer.from(JSON.stringify({name:'ha.view',version:'1.6.0',main:'index.js'}))],
    ['payload/resources/app/index.js', Buffer.from('/* runtime */')],
    ...scripts.map(n => [n, Buffer.from(n)])
  ]);
  const manifest = {schema:1,platform:'win32',arch:'x64',version:'1.6.0',executable:'payload/ha.view.exe',signing:'unsigned-development',
    files:[...files].map(([name, data])=>({path:name,size:data.length,sha256:digest(data)}))};
  for (const [name,data] of files) zip.file(name,data,{createFolders:false});
  if (change) change(zip, manifest);
  zip.file('manifest.json',JSON.stringify(manifest));
  return zip.generateAsync({type:'nodebuffer'});
}
test('Windows-safe paths and strict signing CLI', () => {
  for (const bad of ['../x','a/../b','a\\b','C:x','a?b','a*b','a<b','a>b','a"b','a|b','CON.txt','aux','a.','a ','/x','a//b']) assert.equal(safePath(bad),false,bad);
  assert.equal(safePath('payload/resources/app/index.js'),true);
  assert.throws(()=>parse([])); assert.throws(()=>parse(['--allow-unsigned','--other']));
  assert.deepEqual(parse(['--signed-input','/tmp/stage']),{signedInput:'/tmp/stage'});
  const cfg = config(); assert.equal(cfg.packagerConfig.asar,false); assert.deepEqual(cfg.publishers,[]);
  assert.throws(()=>cfg.hooks.prePackage(null,'darwin','x64'));
  assert.equal(cfg.packagerConfig.ignore('/os/windows/kiosk/Setup.ps1'),true);
  assert.equal(cfg.packagerConfig.ignore('/js/webview.js'),false);
});
test('actual ZIP bytes validate identity, exact files, checksums and case aliases', async () => {
  assert.equal((await validateZip(await fixture())).version,'1.6.0');
  for (const change of [
    z=>z.file('payload/ha.view.exe','tampered'),
    z=>z.file('Setup.PS1','extra'),
    z=>z.remove('HA.View.Kiosk.exe'),
    z=>z.file('extra.txt','extra'),
    (z,m)=>m.files.push({...m.files[0],path:'payload/HA.VIEW.exe'}),
    (z,m)=>{m.version='0.10';},
    (z,m)=>{m.files[0].path='../escape';}
  ]) await assert.rejects(validateZip(await fixture(change)));
});
test('build fails closed before invoking Forge; rejects linked signed staging', async () => {
  await assert.rejects(build({}, {forge:{package(){assert.fail('must not package');}}}), /allow-unsigned/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ha-view-kiosk-'));
  try { await fs.symlink('/tmp',path.join(dir,'payload')); await assert.rejects(build({signedInput:dir}),/Links not permitted/); }
  finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('Node guard rejects unsupported runtime before packaging', () => {
  const { main } = require('./windows-kiosk');
  const previousCode = process.exitCode;
  const previousRuntime = process.env.HA_VIEW_BUILD_NODE;
  delete process.env.HA_VIEW_BUILD_NODE;
  try {
    main(['--allow-unsigned'], { nodeVersion: '26.9.0', build() { assert.fail('must not package'); } });
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousCode;
    if (previousRuntime !== undefined) process.env.HA_VIEW_BUILD_NODE = previousRuntime;
  }
});
test('runtime trampoline preserves args, clears override and propagates child failures', () => {
  const { main } = require('./windows-kiosk');
  const previousCode = process.exitCode;
  const previousRuntime = process.env.HA_VIEW_BUILD_NODE;
  process.env.HA_VIEW_BUILD_NODE = '/tmp/ha-view-lts-node';
  try {
    main(['--signed-input', '/tmp/stage with spaces'], { spawnSync(runtime,args,options) {
      assert.equal(runtime, '/tmp/ha-view-lts-node');
      assert.deepEqual(args, [path.join(__dirname,'windows-kiosk.js'),'--signed-input','/tmp/stage with spaces']);
      assert.equal(options.env.HA_VIEW_BUILD_NODE,'');
      return {status:7};
    } });
    assert.equal(process.exitCode,7);
    main(['--allow-unsigned'], { spawnSync() { return {status:null}; } });
    assert.equal(process.exitCode,1);
  } finally {
    process.exitCode = previousCode;
    if (previousRuntime === undefined) delete process.env.HA_VIEW_BUILD_NODE;
    else process.env.HA_VIEW_BUILD_NODE = previousRuntime;
  }
});
test('native fixed operations and no client scripting/toolchain', async () => {
  const source = await fs.readFile(path.join(root, 'os/windows/kiosk/native/Kiosk.cs'), 'utf8');
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /powershell|EncodedCommand|Unblock-File|ExecutionPolicy|cmd\.exe/i);
  for (const contract of ['WinVerifyTrust', 'AssignProcessToJobObject', 'CreateProcess', 'File.Replace', 'transaction.json', 'installer.lock', 'watchdog.lock', 'RegisterTaskDefinition', 'oldTask', 'Manifest files missing', 'HA_VIEW_PUBLISHER_THUMBPRINT']) assert.ok(source.includes(contract), contract);
  assert.ok(source.indexOf('Check(AssignProcessToJobObject') < source.indexOf('if (ResumeThread'));
  for (const verb of ['Setup', 'Update']) for (const dev of [false, true]) {
    const text = await fs.readFile(path.join(root, 'os/windows/kiosk', verb + (dev ? '-Development' : '') + '.cmd'), 'utf8');
    assert.match(text, /"%~dp0HA.View.Kiosk.exe"/);
    assert.doesNotMatch(text, /powershell|EncodedCommand|Unblock-File|ExecutionPolicy|node|npm|-Bundle|-Sha256/i);
    assert.equal(text.includes('-development'), dev);
    assert.match(text, /pause/);
  }
  assert.ok(scripts.includes('HA.View.Kiosk.exe'));
  assert.ok(!scripts.some(n => n.endsWith('.ps1')));
});
test('native host bytes are covered by delivery manifest', async () => {
  await assert.rejects(validateZip(await fixture(zip => zip.file('HA.View.Kiosk.exe', 'tampered'))), /Checksum mismatch/);
});
test('unsigned build requires precompiled native artifact before Forge', async () => {
  const old = process.env.HA_VIEW_KIOSK_NATIVE;
  delete process.env.HA_VIEW_KIOSK_NATIVE;
  try { await assert.rejects(build({allowUnsigned:true}, {forge:{package(){assert.fail('must not package');}}}), /VM-compiled/); }
  finally { if (old === undefined) delete process.env.HA_VIEW_KIOSK_NATIVE; else process.env.HA_VIEW_KIOSK_NATIVE = old; }
});
test('signed staging needs detached publisher-authenticated manifest', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-native-signed-'));
  try { await assert.rejects(build({signedInput:await fs.realpath(dir)}), /detached manifest.p7s/); }
  finally { await fs.rm(dir, {recursive:true, force:true}); }
});
test('native rollback, ownership and bounded handshake contracts', async () => {
  const source = await fs.readFile(path.join(root, 'os/windows/kiosk/native/Kiosk.cs'), 'utf8');
  for (const contract of ['oldEnabled', 'oldRunning', 'Restore(folder, j)', 'Recover(folder)', 'i < 180', 'StartTime.ToUniversalTime()', 'MainModule.FileName.Equals', 'WaitForExit(5000)', 'cms.CheckSignature(false)', 'policy.VerifyManifestSigner(cms.SignerInfos[0].Certificate, cms.Certificates)', 'Native.VerifyTrust(path);', 'policy.Match(cert)', 'X509RevocationMode.Online', 'X509VerificationFlags.NoFlag', 'HA_VIEW_PUBLISHER_PROFILE_EKU']) assert.ok(source.includes(contract), contract);
  assert.ok(source.indexOf('Atomic(journal') < source.indexOf('Quiesce(folder); Register'));
  assert.ok(source.indexOf('Require(healthy') < source.indexOf('File.Delete(journal); Log("Install committed'));
});
test('native forced-death recovery is one interactive IgnoreNew task with owned triggers', async () => {
  const source = await fs.readFile(path.join(root, 'os/windows/kiosk/native/Kiosk.cs'), 'utf8');
  for (const contract of ['d.Triggers.Create(1)', 'recovery.Repetition.Interval = "PT1M"', 'd.Settings.MultipleInstances = 2', 'd.Principal.LogonType = 3', 'd.Principal.RunLevel = 0', 'OwnedDefinition(d)', 'OwnedDefinition(prior)', 'Refusing unrelated task triggers', 'Refusing duplicate task triggers']) assert.ok(source.includes(contract), contract);
  assert.ok(source.indexOf('OwnedDefinition(prior)') < source.indexOf('Quiesce(folder);'));
  const watchdog = source.slice(source.indexOf('static void Watchdog()'));
  assert.ok(watchdog.indexOf('File.Delete(stale)') < watchdog.indexOf('GetActive()'));
  assert.ok(watchdog.indexOf('Lock("watchdog.lock")') < watchdog.indexOf('File.Delete(stale)'));
});
