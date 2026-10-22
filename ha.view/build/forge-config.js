/** HA.View: register per-build config through Forge's public utility API. */
'use strict';
const forge = require('@electron-forge/core');
module.exports = {
  registerForgeConfigForDirectory: forge.utils.registerForgeConfigForDirectory.bind(forge.utils),
  unregisterForgeConfigForDirectory: forge.utils.unregisterForgeConfigForDirectory.bind(forge.utils),
};
