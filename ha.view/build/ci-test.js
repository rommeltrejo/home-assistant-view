/** Shell-independent test discovery: absolute paths also work on Windows. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function findTests(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? findTests(file) : entry.isFile() && entry.name.endsWith('.test.js') ? [file] : [];
  }).sort();
}
if (require.main === module) {
  const tests = findTests(path.join(root, 'ha.view')).filter(file =>
    process.platform !== 'win32' || file.endsWith(path.join('build', 'actions-workflow.test.js')) || file.endsWith(path.join('build', 'windows-kiosk.test.js')) || file.endsWith(path.join('build', 'windows-portable.test.js')));
  // The full suite exercises POSIX file modes, bash and macOS-specific fixtures.
  // On Windows run its own package contracts, plus the cross-platform workflow contract.
  if (!tests.length) throw new Error('No Node regression tests found');
  const result = spawnSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { findTests };
