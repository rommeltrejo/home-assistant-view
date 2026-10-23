/** `npm run build`: package HA View for the current platform, using the same targets as CI. */
'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const targets = { linux: 'build:linux-kiosk', win32: 'build:windows-portable', darwin: 'build:macos' };
function main(platform = process.platform) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`No package target for platform "${platform}". Linux, Windows and macOS have package targets.`);
  }
  const result = spawnSync(platform === 'win32' ? 'npm.cmd' : 'npm', ['run', target], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main, targets };
