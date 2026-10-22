/** Unsigned direct-run ZIP, with an isolated optional existing kiosk bundle. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const kiosk = require('./windows-kiosk');
const metadata = require('../../package.json');
const root = path.resolve(__dirname, '../..');
const launchers = ['Run.cmd', 'Install-Kiosk.cmd', 'Update-Kiosk.cmd', 'README.md'];
async function validateZip(bytes) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const lower = new Set();
  const inner = new JSZip();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!kiosk.safePath(name) || entry.dir || lower.has(name.toLowerCase()) ||
        (entry.unsafeOriginalName && entry.unsafeOriginalName !== name) ||
        (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0xf000) === 0xa000) ||
        !(name.startsWith('payload/') || name.startsWith('kiosk/') || launchers.includes(name))) throw new Error('Unexpected portable entry: ' + name);
    lower.add(name.toLowerCase());
    if (name.startsWith('kiosk/')) inner.file(name.slice(6), await entry.async('nodebuffer'), { createFolders: false });
  }
  for (const name of [...launchers, 'payload/ha.view.exe', 'payload/resources/app/index.js', 'payload/resources/app/package.json']) {
    if (!zip.file(name)) throw new Error('Missing portable component: ' + name);
  }
  const manifest = await kiosk.validateZip(await inner.generateAsync({ type: 'nodebuffer' }));
  if (manifest.signing !== 'unsigned-development') throw new Error('Portable kiosk must be unsigned');
  for (const entry of manifest.files.filter(e => e.path.startsWith('payload/'))) {
    const file = zip.file(entry.path);
    if (!file) throw new Error('Missing direct payload: ' + entry.path);
    const data = await file.async('nodebuffer');
    if (data.length !== entry.size || kiosk.digest(data) !== entry.sha256) throw new Error('Direct payload differs: ' + entry.path);
  }
  const expected = new Set(manifest.files.filter(e => e.path.startsWith('payload/')).map(e => e.path));
  for (const name of Object.keys(zip.files)) if (name.startsWith('payload/') && !expected.has(name)) throw new Error('Extra direct payload: ' + name);
  for (const name of launchers) {
    if (await zip.file(name).async('string') !== await fs.readFile(path.join(root, 'os/windows/portable', name), 'utf8')) throw new Error('Portable launcher/docs differ: ' + name);
  }
  return manifest;
}
async function build(dependencies = {}) {
  const native = process.env.HA_VIEW_KIOSK_NATIVE;
  if (!native) throw new Error('HA_VIEW_KIOSK_NATIVE must name the privately VM-compiled native host');
  const nativeBytes = await fs.readFile(native);
  if (nativeBytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Native host is not PE');
  const forge = dependencies.forge || require('@electron-forge/core').api;
  const registry = dependencies.registry || require('./forge-config');
  const cfg = kiosk.config();
  let outputs;
  cfg.hooks.postPackage = (_config, result) => {
    if (result.platform !== 'win32' || result.arch !== 'x64') throw new Error('Unexpected target');
    outputs = result.outputPaths;
  };
  registry.registerForgeConfigForDirectory(root, cfg);
  try { await forge.package({ dir: root, platform: 'win32', arch: 'x64', interactive: false }); }
  finally { registry.unregisterForgeConfigForDirectory(root); }
  if (!outputs || outputs.length !== 1) throw new Error('Expected one Electron payload');
  // walk is private to the unchanged kiosk builder: enumerate the packager output here.
  async function walk(dir, prefix = '') {
    if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('Links forbidden');
    const result = [];
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (!kiosk.safePath(name) || item.isSymbolicLink()) throw new Error('Unsafe payload path');
      if (item.isDirectory()) result.push(...await walk(path.join(dir, item.name), name + '/'));
      else if (item.isFile()) result.push([name, await fs.readFile(path.join(dir, item.name))]);
      else throw new Error('Unsupported payload entry');
    }
    return result.sort(([a], [b]) => a.localeCompare(b));
  }
  const files = (await walk(outputs[0])).map(([name, data]) => ['payload/' + name, data]);
  const zip = new JSZip();
  for (const [name, data] of files) zip.file(name, data, { createFolders: false });
  const innerFiles = [...files];
  for (const name of kiosk.scripts) innerFiles.push([name, name === 'HA.View.Kiosk.exe' ? nativeBytes : await fs.readFile(path.join(root, 'os/windows/kiosk', name))]);
  const manifest = { schema: 1, platform: 'win32', arch: 'x64', version: metadata.version, executable: 'payload/ha.view.exe', signing: 'unsigned-development',
    files: innerFiles.map(([name, data]) => ({ path: name, size: data.length, sha256: kiosk.digest(data) })) };
  for (const [name, data] of innerFiles) zip.file('kiosk/' + name, data, { createFolders: false });
  zip.file('kiosk/manifest.json', JSON.stringify(manifest, null, 2) + '\n', { createFolders: false });
  for (const name of launchers) zip.file(name, await fs.readFile(path.join(root, 'os/windows/portable', name)), { createFolders: false });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'DOS' });
  await validateZip(bytes);
  const output = path.join(root, 'out/windows-portable', `ha.view-${metadata.version}-win32-x64-portable.zip`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output + '.tmp', bytes, { flag: 'wx' });
  await fs.rename(output + '.tmp', output);
  await fs.writeFile(output + '.sha256', `${kiosk.digest(bytes)}  ${path.basename(output)}\n`);
  console.info(`${output}\nSHA256 ${kiosk.digest(bytes)}`);
  return { output, sha256: kiosk.digest(bytes) };
}
function main(args) {
  const runtime = process.env.HA_VIEW_BUILD_NODE;
  if (runtime && path.resolve(runtime) !== path.resolve(process.execPath)) {
    const child = require('node:child_process').spawnSync(runtime, [__filename, ...args], { stdio: 'inherit', env: { ...process.env, HA_VIEW_BUILD_NODE: '' } });
    process.exitCode = child.status ?? 1; return;
  }
  if (args.length || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    console.error('Run windows-portable.js without arguments under private Node 22/24 (HA_VIEW_BUILD_NODE supported).'); process.exitCode = 1; return;
  }
  let pending = true;
  process.once('beforeExit', () => { if (pending) process.exitCode = 1; });
  build().then(() => { pending = false; }, error => { pending = false; console.error(error); process.exitCode = 1; });
}
module.exports = { build, validateZip, launchers, main };
if (require.main === module) main(process.argv.slice(2));
