const { createIdentity, assertPackagingAllowed } = require("./ha.view/identity");
const identity = createIdentity(require("./package.json"));

module.exports = {
  packagerConfig: {
    ignore: [".github", ".gitignore", "install.sh", "forge.config.js"],
  },
  makers: [
    {
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          productName: identity.title,
          productDescription: require("./package.json").description,
          categories: ["Network"],
          icon: "img/icon.png",
        },
      },
    },
    {
      name: "@electron-forge/maker-zip",
    },
  ],
  publishers: [],
  hooks: {
    generateAssets: assertPackagingAllowed,
    prePackage: assertPackagingAllowed,
    preMake: assertPackagingAllowed,
    prePublish: assertPackagingAllowed,
  },
};
