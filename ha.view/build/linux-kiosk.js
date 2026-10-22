/** HA.View prebuilt Linux bundle; build on the real target, no publishing. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ignore } = require('./files');
async function main() {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Build on Linux x64 or arm64');
  const root = path.resolve(__dirname, '../..');
  const metadata = require('../../package.json');
  const { packager: pack } = await import('@electron/packager');
  const [payload] = await pack({ dir: root, out: path.join(root, 'out/linux-package'), name: 'ha.view',
    executableName: 'ha.view', platform: 'linux', arch: process.arch, overwrite: true, prune: true, asar: false, ignore });
  const output = path.join(root, 'out/linux-kiosk', `ha.view-${metadata.version}-linux-${process.arch}-kiosk`);
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await fs.cp(payload, path.join(output, 'payload'), { recursive: true });
  for (const file of ['Run.sh', 'install.sh', 'install.py', 'supervisor.py', 'README.md']) {
    await fs.copyFile(path.join(root, 'os/linux/kiosk', file), path.join(output, file));
  }
  for (const file of ['Run.sh', 'install.sh']) await fs.chmod(path.join(output, file), 0o755);
  const files = [];
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Bundle links forbidden: ' + name);
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/');
      else if (entry.isFile()) {
        const data = await fs.readFile(path.join(dir, entry.name));
        files.push({ path: name, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
      } else throw new Error('Unsupported bundle file: ' + name);
    }
  }
  await walk(output);
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schema: 1, platform: 'linux', arch: process.arch,
    version: metadata.version, integrity: 'sha256-unsigned', files: files.sort((a,b) => a.path.localeCompare(b.path)) }, null, 2));
  const archive = output + '.tar.gz';
  const result = spawnSync('tar', ['-czf', archive, '-C', path.dirname(output), path.basename(output)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Bundle archiving failed');
  const hash = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(archive + '.sha256', `${hash}  ${path.basename(archive)}\n`);
  console.log(archive + '\nSHA256 ' + hash);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
