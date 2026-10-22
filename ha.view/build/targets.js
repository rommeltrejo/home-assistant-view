/** HA.View: only explicit local archive/portable targets; never publishing. */
'use strict';
function assertTarget(platform, arch) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);
  return { platform, arch };
}
function parseArguments(args, host = { platform: process.platform, arch: process.arch }) {
  const platform = args[0];
  let arch = platform === 'darwin' ? (host.platform === 'darwin' ? host.arch : 'arm64') : 'x64';
  if (args.length === 2 && args[1].startsWith('--arch=')) arch = args[1].slice(7);
  else if (args.length === 3 && args[1] === '--arch') arch = args[2];
  else if (args.length !== 1) throw new Error('Usage: launcher.js darwin|win32 [--arch arm64|x64]');
  return assertTarget(platform, arch);
}
function assertHost(target, host = { platform: process.platform }) {
  if (target.platform === 'win32' && !['win32', 'darwin'].includes(host.platform)) {
    throw new Error('HA View Windows portable builds support macOS and Windows hosts only.');
  }
}
module.exports = { assertTarget, parseArguments, assertHost };
