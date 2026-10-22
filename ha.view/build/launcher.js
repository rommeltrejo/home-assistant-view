/** HA.View cross-platform Node launcher; no shell, global CLI, signing or publishing. */
'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const { parseArguments, assertHost } = require('./targets');
const { createConfig, makerName } = require('./config');
async function run(args, dependencies = {}) {
  const target = parseArguments(args, dependencies.host);
  assertHost(target, dependencies.host);
  const root = path.resolve(__dirname, '../..');
  // Register the dedicated config via Forge public utilities, without editing package.json.
  const forge = dependencies.forge || require('@electron-forge/core').api;
  const registry = dependencies.registry || require('./forge-config');
  const config = createConfig(target);
  let packagedPaths;
  const postPackage = config.hooks.postPackage;
  config.hooks.postPackage = async (...args) => {
    await postPackage(...args);
    packagedPaths = args[1].outputPaths;
  };
  registry.registerForgeConfigForDirectory(root, config);
  const earlyExit = () => {
    console.error('HA View build ended before Forge completed; no successful artifacts were produced.');
    process.exitCode = 1;
  };
  process.once('beforeExit', earlyExit);
  try {
    console.info(`HA View: making ${target.platform === 'darwin' ? 'ZIP' : 'portable EXE'} for ${target.platform}/${target.arch}`);
    const results = target.platform === 'win32'
      ? await require('./windows').makeWindows(root, target, forge, dependencies.builder, () => packagedPaths)
      : await forge.make({ dir: root, ...target, interactive: true, overrideTargets: [makerName(target.platform)] });
    const artifacts = await validateArtifacts(results, target, dependencies.stat);
    for (const artifact of artifacts) console.info(`HA View artifact: ${artifact}`);
    return results;
  } finally {
    process.removeListener('beforeExit', earlyExit);
    registry.unregisterForgeConfigForDirectory(root);
  }
}
async function validateArtifacts(results, target, stat = fs.stat) {
  if (!Array.isArray(results) || !results.length) throw new Error('Forge returned no build outputs');
  const artifacts = [];
  for (const result of results) {
    if (result.platform !== target.platform || result.arch !== target.arch) throw new Error('Forge returned an unexpected build target');
    if (!Array.isArray(result.artifacts) || !result.artifacts.length) throw new Error('Forge returned no artifacts');
    if (!result.artifacts.some(artifact => typeof artifact === 'string' && path.extname(artifact) === (target.platform === 'darwin' ? '.zip' : '.exe'))) throw new Error('Forge returned no primary build artifact');
    for (const artifact of result.artifacts) {
      if (typeof artifact !== 'string' || !path.isAbsolute(artifact) || !(target.platform === 'darwin' ? path.extname(artifact) === '.zip' : (path.extname(artifact) === '.exe' && !/(?:^|[-_.])setup(?:[-_.]|$)/i.test(path.basename(artifact))))) throw new Error('Expected an absolute ZIP or portable EXE artifact path');
      const info = await stat(artifact);
      if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty build artifact: ${artifact}`);
      artifacts.push(artifact);
    }
  }
  return artifacts;
}
function main(args) {
  const runtime = process.env.HA_VIEW_BUILD_NODE;
  if (runtime && path.resolve(runtime) !== path.resolve(process.execPath)) {
    const child = spawnSync(runtime, [__filename, ...args], { stdio: 'inherit', env: { ...process.env, HA_VIEW_BUILD_NODE: '' } });
    if (child.error) console.error(child.error.message);
    process.exitCode = child.status ?? 1;
    return;
  }
  // Installed extract-zip/fd-slicer stalls on Node 26 stream behavior. Do not
  // patch dependencies or allow an unresolved build promise to count as success.
  if (![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    console.error('HA View builds require Node 22 or 24 LTS with the installed Forge dependencies. Set HA_VIEW_BUILD_NODE to that Node executable, or run npm under Node 22/24.');
    process.exitCode = 1;
    return;
  }
  run(args).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run, validateArtifacts };
if (require.main === module) main(process.argv.slice(2));
