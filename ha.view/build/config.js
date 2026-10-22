/** HA.View unsigned local builds. Intentionally separate from default Forge policy. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertTarget } = require('./targets');
const { ignore } = require('./files');
const metadata = require('../../package.json');
function denyPublishing() { throw new Error('HA View publishing is disabled; local unsigned builds only.'); }
function appPath(output, platform) {
  if (platform === 'darwin') return path.join(output, 'ha.view.app', 'Contents', 'Resources', 'app');
  if (platform === 'win32') return path.join(output, 'resources', 'app');
  throw new Error(`Unsupported platform: ${platform}`);
}
function createConfig(target) {
  const { platform, arch } = assertTarget(target.platform, target.arch);
  function guard(_config, actualPlatform, actualArch) {
    assertTarget(actualPlatform, actualArch);
    if (platform !== actualPlatform || arch !== actualArch) throw new Error('Build target differs from explicitly authorized target');
  }
  return {
    packagerConfig: {
      name: 'ha.view', executableName: 'ha.view', appBundleId: 'org.ha-view.desktop',
      appCopyright: 'HA.View contributors; based on TouchKio by leukipp (MIT)',
      asar: false, prune: true, ignore,
      osxSign: false, osxNotarize: false,
      win32metadata: { ProductName: 'HA View', FileDescription: metadata.description },
    },
    makers: platform === 'darwin' ? [{ name: makerName(platform), platforms: [platform], config: {} }] : [],
    publishers: [],
    hooks: {
      generateAssets: guard,
      prePackage: guard,
      preMake: () => assertTarget(platform, arch),
      prePublish: denyPublishing,
      postPackage: async (_config, results) => {
        guard(_config, results.platform, results.arch);
        for (const output of results.outputPaths) {
          const data = {
            id: crypto.createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(-6),
            platform, arch, maker: platform === 'darwin' ? 'zip' : 'portable', date: new Date().toISOString(),
            portable: true, signed: false, ...(platform === 'win32' ? { installer: false } : {}),
          };
          // Write before the maker creates the ZIP / Windows portable EXE.
          await fs.writeFile(path.join(appPath(output, platform), 'build.json'), JSON.stringify(data, null, 2) + '\n');
        }
      },
    },
  };
}
function makerName(platform) {
  return platform === 'darwin' ? '@electron-forge/maker-zip' : null;
}
module.exports = { createConfig, appPath, denyPublishing, makerName };
