/** HA.View: package current source with Forge, then make an unsigned local portable EXE. */
'use strict';
const path = require('node:path');
function builderOptions(root, target, prepackaged) {
  return {
    prepackaged, publish: 'never',
    config: {
      appId: 'org.ha-view.desktop', productName: 'HA View',
      directories: { output: path.join(root, 'out/make/portable', target.arch) },
      win: { signAndEditExecutable: false, executableName: 'ha.view' },
      portable: { artifactName: 'ha.view-${version}-${arch}.exe' },
      npmRebuild: false,
    },
  };
}
async function makeWindows(root, target, forge, builder = require('electron-builder'), outputPaths) {
  await forge.package({ dir: root, ...target, interactive: true });
  const packaged = outputPaths();
  if (!Array.isArray(packaged) || packaged.length !== 1 || typeof packaged[0] !== 'string' || !path.isAbsolute(packaged[0])) {
    throw new Error('Forge did not return exactly one absolute Windows package path');
  }
  const arch = target.arch === 'x64' ? builder.Arch.x64 : builder.Arch.arm64;
  const artifacts = await builder.build({ ...builderOptions(root, target, packaged[0]),
    targets: builder.Platform.WINDOWS.createTarget('portable', arch) });
  return [{ ...target, artifacts }];
}
module.exports = { builderOptions, makeWindows };
