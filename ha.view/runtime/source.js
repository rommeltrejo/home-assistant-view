/** Prepare the local source runtime; never signs packaged HA View or changes permissions. */
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
function prepare(executable, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'darwin') return false;
  const bundle = path.resolve(executable, '../../..');
  if (path.basename(bundle) !== 'Electron.app') throw new Error('Refusing to sign a non-source Electron bundle');
  const call = (bin, args) => run(bin, args, { encoding: 'utf8' });
  const plist = call('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')]);
  const id = (plist.stdout || '').trim();
  if (plist.status !== 0 || id !== 'com.github.Electron') throw new Error('Unexpected source Electron bundle identity');
  const details = call('/usr/bin/codesign', ['-dvv', bundle]);
  const text = `${details.stdout || ''}\n${details.stderr || ''}`;
  const valid = call('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  if (valid.status === 0 && text.includes(`Identifier=${id}\n`) && /Info\.plist entries=\d+/.test(text)) return false;
  // Local ad-hoc signing binds the existing plist/resources; no entitlements or TCC changes.
  const signed = call('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', id, bundle]);
  if (signed.status !== 0) throw new Error(`Electron identity preparation failed: ${signed.stderr}`);
  const check = call('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
  if (check.status !== 0) throw new Error(`Electron signature verification failed: ${check.stderr}`);
  const bound = call('/usr/bin/codesign', ['-dvv', bundle]);
  const identity = `${bound.stdout || ''}\n${bound.stderr || ''}`;
  if (bound.status !== 0 || !identity.includes(`Identifier=${id}\n`) || !/Info\.plist entries=\d+/.test(identity)) {
    throw new Error('Electron post-sign identity or bound plist verification failed');
  }
  return true;
}
function bootstrap(root) {
  return `const {app}=require('electron');const root=${JSON.stringify(root)};const metadata=require(require('node:path').join(root,'package.json'));app.setName(metadata.name);app.setVersion(metadata.version);app.setAppPath(root);require(require('node:path').join(root,metadata.main));\n`;
}
function wrapper(executable, root) {
  const original = path.resolve(executable, '../../..');
  const cache = path.join(root, 'node_modules/.cache/ha-view-source');
  const bundle = path.join(cache, 'Electron.app');
  const code = bootstrap(root);
  const plist = fs.readFileSync(path.join(original, 'Contents/Info.plist'));
  const key = crypto.createHash('sha256').update(code).update(plist).update(fs.readFileSync(executable)).digest('hex');
  const stamp = path.join(cache, 'identity.json');
  if (!fs.existsSync(stamp) || fs.readFileSync(stamp,'utf8') !== key || !fs.existsSync(bundle)) {
    fs.mkdirSync(cache,{recursive:true});
    // Replace only our generated, ignored wrapper. App profiles and the installed runtime are untouched.
    fs.rmSync(bundle,{recursive:true,force:true});
    const copy = spawnSync('/usr/bin/ditto',[original,bundle],{encoding:'utf8'});
    if(copy.status !== 0) throw new Error(`Source wrapper copy failed: ${copy.stderr}`);
    const appDir=path.join(bundle,'Contents/Resources/app');fs.mkdirSync(appDir,{recursive:true});
    fs.writeFileSync(path.join(appDir,'package.json'),JSON.stringify({name:'ha.view',version:require(path.join(root,'package.json')).version,main:'main.cjs'}));
    fs.writeFileSync(path.join(appDir,'main.cjs'),code);
    fs.writeFileSync(stamp,key);
  }
  prepare(path.join(bundle,'Contents/MacOS/Electron'));
  return bundle;
}
function launchArguments(bundle, args) { return ['-n','-W',bundle,'--args','--trace-warnings',...args]; }
if (require.main === module) {
  try {
    const executable = require('electron');
    const root=path.resolve(__dirname,'../..');
    const mac=process.platform==='darwin';
    const child = mac
      ? spawn('/usr/bin/open',launchArguments(wrapper(executable,root),process.argv.slice(2)),{stdio:'inherit'})
      : spawn(executable,['.','--trace-warnings',...process.argv.slice(2)],{cwd:root,stdio:'inherit'});
    child.on('error', e => { console.error(e.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { prepare, bootstrap, wrapper, launchArguments };
