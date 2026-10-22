/** HA.View static gate: ESLint plus syntax and JSON checks for owned source. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString().split('\0').filter(Boolean);
let failed = false;
let count = 0;
for (const file of files) {
  // These two files are synchronized verbatim from upstream.
  if (file === 'js/hardware.js' || file === 'js/integration.js') continue;
  if (!/\.(?:js|cjs|mjs|json)$/.test(file)) continue;
  count += 1;
  const fullPath = path.join(root, file);
  const source = fs.readFileSync(fullPath, 'utf8');
  if (file.endsWith('.json')) {
    try { JSON.parse(source); } catch (error) { console.error(`${file}: ${error.message}`); failed = true; }
  } else {
    const result = spawnSync(process.execPath, ['--check', fullPath], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(`${file}: ${result.stderr || result.error}`); failed = true; }
  }
  if (/\r/.test(source)) { console.error(`${file}: CR line ending`); failed = true; }
  if (!source.endsWith('\n')) { console.error(`${file}: missing final newline`); failed = true; }
}
const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const result = spawnSync(process.execPath, [eslint, 'ha.view', 'index.js', 'forge.config.js', '--no-warn-ignored'],
  { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error(result.error || `ESLint exited with status ${result.status}`);
  failed = true;
}
if (failed) process.exitCode = 1;
else console.log(`ESLint, syntax, and JSON validated for ${count} source files.`);
