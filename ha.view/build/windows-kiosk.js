/** HA.View Windows directory ZIP; deliberately independent of the legacy makers. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { ignore } = require('./files');
const metadata = require('../../package.json');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const scripts = ['HA.View.Kiosk.exe', 'README.md',
  'Setup.cmd', 'Update.cmd', 'Setup-Development.cmd', 'Update-Development.cmd'];
function safePath(name) {
  return typeof name === 'string' && name.length < 240 && !/[\\:?*<>"|\x00-\x1f]/.test(name) &&
    name.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}
async function walk(root, prefix = '') {
  let cursor = path.resolve(root);
  while (true) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`Links not permitted: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const result = [];
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (!safePath(name)) throw new Error(`Unsafe Windows path: ${name}`);
    if (item.isSymbolicLink()) throw new Error(`Links not permitted: ${name}`);
    if (item.isDirectory()) result.push(...await walk(path.join(root, item.name), name + '/'));
    else if (item.isFile()) result.push([name, await fs.readFile(path.join(root, item.name))]);
    else throw new Error(`Unsupported file: ${name}`);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}
function config() {
  const guard = (_config, platform, arch) => {
    if (platform !== 'win32' || arch !== 'x64') throw new Error('Only win32/x64 is authorized');
  };
  return {
    packagerConfig: { name: 'ha.view', executableName: 'ha.view', asar: false, prune: true, ignore,
      win32metadata: { ProductName: 'HA View', FileDescription: metadata.description } },
    makers: [], publishers: [],
    hooks: { generateAssets: guard, prePackage: guard,
      prePublish() { throw new Error('Publishing disabled'); } },
  };
}
async function validateZip(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) throw new Error('Missing manifest');
  const manifest = JSON.parse(await manifestFile.async('string'));
  if (manifest.schema !== 1 || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.executable !== 'payload/ha.view.exe' || !['unsigned-development', 'signed-input-unverified'].includes(manifest.signing) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.version) || !Array.isArray(manifest.files)) throw new Error('Invalid manifest');
  const names = new Set();
  const exactNames = new Set();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || entry.path === 'manifest.json' || names.has(entry.path.toLowerCase()) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Invalid manifest entry');
    if (!(entry.path.startsWith('payload/') || scripts.includes(entry.path))) throw new Error('Unexpected manifest file');
    names.add(entry.path.toLowerCase());
    exactNames.add(entry.path);
    const file = zip.file(entry.path);
    if (!file || file.dir) throw new Error(`Missing file: ${entry.path}`);
    const data = await file.async('nodebuffer');
    if (data.length !== entry.size || digest(data) !== entry.sha256) throw new Error(`Checksum mismatch: ${entry.path}`);
  }
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0xf000) === 0xa000) || !safePath(name) || (entry.unsafeOriginalName && entry.unsafeOriginalName !== name) ||
        (name !== 'manifest.json' && !(name === 'manifest.p7s' && manifest.signing === 'signed-input-unverified') && !exactNames.has(name))) throw new Error(`Unexpected ZIP entry: ${name}`);
  }
  for (const required of ['payload/ha.view.exe', 'payload/resources/app/package.json', 'payload/resources/app/index.js', ...scripts]) {
    if (!names.has(required.toLowerCase())) throw new Error(`Missing package component: ${required}`);
  }
  const app = JSON.parse(await zip.file('payload/resources/app/package.json').async('string'));
  if (app.name !== 'ha.view' || app.version !== manifest.version || app.main !== 'index.js') throw new Error('App identity mismatch');
  const exe = await zip.file('payload/ha.view.exe').async('nodebuffer');
  if (exe.length < 64 || exe.toString('ascii', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
  return manifest;
}
async function build(options, dependencies = {}) {
  if (!options.allowUnsigned && !options.signedInput) throw new Error('Provide --allow-unsigned for development, or --signed-input with externally signed payload and native host');
  if (options.allowUnsigned && options.signedInput) throw new Error('Signing modes are mutually exclusive');
  const root = path.resolve(__dirname, '../..');
  if (options.allowUnsigned && !process.env.HA_VIEW_KIOSK_NATIVE) throw new Error('HA_VIEW_KIOSK_NATIVE must name the VM-compiled Windows x64 native host; clients never compile');
  let files, signedManifest, manifestSignature;
  if (options.signedInput) {
    // This is not a claim of trust: Windows Setup verifies Authenticode plus the operator's pinned thumbprint.
    files = await walk(path.resolve(options.signedInput));
    signedManifest = files.find(([name]) => name === 'manifest.json')?.[1];
    manifestSignature = files.find(([name]) => name === 'manifest.p7s')?.[1];
    if (!signedManifest || !manifestSignature) throw new Error('Signed input requires externally signed manifest.json + detached manifest.p7s; no implicit re-signing');
    files = files.filter(([name]) => !['manifest.json', 'manifest.p7s'].includes(name));
    if (files.some(([name]) => !(name.startsWith('payload/') || scripts.includes(name)))) throw new Error('Signed input must contain only payload/ and kiosk native host/CMD/docs');
  } else {
    const forge = dependencies.forge || require('@electron-forge/core').api;
    const registry = dependencies.registry || require('./forge-config');
    let outputs;
    const dedicated = config();
    dedicated.hooks.postPackage = (_config, results) => {
      if (results.platform !== 'win32' || results.arch !== 'x64') throw new Error('Unexpected Forge target');
      outputs = results.outputPaths;
    };
    registry.registerForgeConfigForDirectory(root, dedicated);
    try { await forge.package({ dir: root, platform: 'win32', arch: 'x64', interactive: false }); }
    finally { registry.unregisterForgeConfigForDirectory(root); }
    if (!outputs || outputs.length !== 1) throw new Error('Expected one packaged Electron directory');
    files = (await walk(outputs[0])).map(([name, data]) => ['payload/' + name, data]);
    for (const name of scripts) {
      const file = name === 'HA.View.Kiosk.exe' ? process.env.HA_VIEW_KIOSK_NATIVE : path.join(root, 'os/windows/kiosk', name);
      if (!file) throw new Error('HA_VIEW_KIOSK_NATIVE must name the VM-compiled Windows x64 native host; clients never compile');
      const data = await fs.readFile(file);
      if (name.endsWith('.exe') && data.subarray(0, 2).toString() !== 'MZ') throw new Error('Native host is not a PE executable');
      files.push([name, data]);
    }
  }
  if (signedManifest && JSON.parse(signedManifest).signing !== 'signed-input-unverified') throw new Error('Signed manifest signing identity required');
  const appFile = files.find(([name]) => name === 'payload/resources/app/package.json');
  if (!appFile) throw new Error('Missing packaged app');
  const app = JSON.parse(appFile[1]);
  if (app.version !== metadata.version) throw new Error('Staging version differs from package.json; no implicit version changes');
  const manifest = { schema: 1, platform: 'win32', arch: 'x64', version: metadata.version,
    executable: 'payload/ha.view.exe', signing: options.allowUnsigned ? 'unsigned-development' : 'signed-input-unverified',
    files: files.map(([name, data]) => ({ path: name, size: data.length, sha256: digest(data) })) };
  const zip = new JSZip();
  for (const [name, data] of files) zip.file(name, data, { createFolders: false });
  zip.file('manifest.json', signedManifest || JSON.stringify(manifest, null, 2) + '\n');
  if (manifestSignature) zip.file('manifest.p7s', manifestSignature, { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  await validateZip(bytes);
  const output = path.resolve(root, 'out/windows-kiosk', `ha.view-${metadata.version}-win32-x64-kiosk.zip`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output + '.tmp', bytes, { flag: 'wx' });
  await fs.rename(output + '.tmp', output);
  await fs.writeFile(output + '.sha256', `${digest(bytes)}  ${path.basename(output)}\n`);
  console.info(`HA.View ${manifest.signing}: ${output}\nSHA256 ${digest(bytes)}`);
  return { output, manifest };
}
function parse(args) {
  if (args.length === 1 && args[0] === '--allow-unsigned') return { allowUnsigned: true };
  if (args.length === 2 && args[0] === '--signed-input' && args[1]) return { signedInput: args[1] };
  throw new Error('Usage: windows-kiosk.js --allow-unsigned | --signed-input DIRECTORY');
}
function main(args, dependencies = {}) {
  const runtime = process.env.HA_VIEW_BUILD_NODE;
  if (runtime && path.resolve(runtime) !== path.resolve(process.execPath)) {
    const spawn = dependencies.spawnSync || require('node:child_process').spawnSync;
    const child = spawn(runtime, [__filename, ...args], {
      stdio: 'inherit', env: { ...process.env, HA_VIEW_BUILD_NODE: '' },
    });
    if (child.error) console.error(child.error.message);
    process.exitCode = child.status ?? 1;
    return;
  }
  if (![22, 24].includes(Number((dependencies.nodeVersion || process.versions.node).split('.')[0]))) {
    console.error('HA.View builds require Node 22 or 24 LTS. Set HA_VIEW_BUILD_NODE to that Node executable, or run npm under Node 22/24.');
    process.exitCode = 1;
    return;
  }
  let pending = true;
  process.once('beforeExit', () => { if (pending) { console.error('Build did not complete'); process.exitCode = 1; } });
  Promise.resolve().then(() => (dependencies.build || build)(parse(args))).then(() => { pending = false; }, error => {
    pending = false; console.error(error.message); process.exitCode = 1;
  });
}

module.exports = { scripts, build, config, safePath, validateZip, digest, parse, main };
if (require.main === module) main(process.argv.slice(2));
