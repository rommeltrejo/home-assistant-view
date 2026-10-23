const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createIdentity, assertPackagingAllowed } = require("./identity");
const metadata = require("../package.json");
const root = path.join(__dirname, "..");

function withRepository(url, verified = true) {
  return { ...metadata, haView: { projectRepository: { url, verified } } };
}

test("actual package identity never derives links from author, homepage, or upstream", () => {
  const identity = createIdentity(metadata);
  assert.equal(identity.title, "HA View");
  assert.equal(metadata.name, "ha.view");
  assert.deepEqual(identity.repository, { owner: "rommeltrejo", name: "home-assistant-view", url: "https://github.com/rommeltrejo/home-assistant-view" });
  assert.equal(identity.homepage, identity.repository.url);
  assert.equal(identity.issues, `${identity.repository.url}/issues`);
  assert.deepEqual(identity.releases, { url: "https://api.github.com/repos/rommeltrejo/home-assistant-view/releases", latest: null });
  assert.deepEqual(identity.scripts, { install: "builtin" });
  assert.deepEqual(identity.source, { name: "TouchKio", author: "leukipp", license: "MIT", url: "https://github.com/leukipp/touchkio" });
  assert.equal(createIdentity({ ...metadata, homepage: "https://github.com/leukipp/ha.view", author: { name: "Other Owner" } }).repository.url, identity.repository.url);
});

test("explicit verified project repository supports links and the built-in updater, not remote installers or packaging", () => {
  // Syntactic fixture only; no claim that this example repository exists.
  const identity = createIdentity(withRepository("https://github.com/example-owner/example-project"));
  assert.equal(identity.homepage, "https://github.com/example-owner/example-project");
  assert.equal(identity.issues, `${identity.homepage}/issues`);
  assert.equal(identity.releases.url, "https://api.github.com/repos/example-owner/example-project/releases");
  assert.equal(identity.scripts.install, "builtin");
  assert.equal(identity.sourceOnly, true);
});

test("unverified, upstream, and malformed repositories fail closed", () => {
  assert.equal(createIdentity(withRepository("https://github.com/example-owner/example-project", false)).repository, null);
  for (const url of ["https://github.com/leukipp/touchkio", "https://github.com/LEUKIPP/HA.VIEW", "http://github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b;whoami", "https://github.com/a/..", "https://github.com@evil.test/a/b", "https://github.com/a/b/main"]) {
    assert.equal(createIdentity(withRepository(url)).repository, null, url);
  }
});

function runInitApp(APP, updater, platform = process.platform) {
  const source = fs.readFileSync(path.join(root, "js/integration.js"), "utf8");
  const start = source.indexOf("const initApp = () => {");
  const end = source.indexOf("const updateApp =", start);
  const seen = { quitCalls: 0, removed: false, updated: false, subscribed: undefined, handler: undefined };
  vm.runInNewContext(`${source.slice(start, end)}\ninitApp();`, {
    APP, ARGS: { app_disable: [] }, INTEGRATION: { root: "test", node: "test", device: {} }, process: { platform, arch: process.arch }, console,
    app: { quit() { seen.quitCalls += 1; } },
    HARDWARE: { support: { access: { install: true } } },
    hardware: { setDisplayStatus(status, callback) { if (callback) callback(); } },
    updater,
    removeConfig() { seen.removed = true; },
    updateApp() { seen.updated = true; },
    publishConfig(type, config) {
      seen.type = type; seen.config = config;
      const chain = { on(event, handler) { seen.handler = handler; return chain; }, subscribe(topic) { seen.subscribed = topic; return chain; } };
      return chain;
    },
  });
  return seen;
}

const appFixture = () => ({
  ...createIdentity(metadata),
  build: {},
  path: "/srv/ha.view/payload/resources/app",
  releases: { latest: { version: "9.9.9", assets: [] } },
});

test("MQTT app entity is published without an install command when the platform has no updater path", () => {
  const seen = runInitApp(appFixture(), { canInstall: () => false, install: async () => assert.fail("install must not run") });
  assert.equal(seen.removed, false);
  assert.equal(seen.type, "update");
  assert.equal(seen.config.command_topic, undefined);
  assert.equal(seen.subscribed, undefined);
  assert.equal(seen.updated, true);
});

test("MQTT app install command runs the built-in updater for the exact payload only", async () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const calls = [];
    let finish;
    const updater = {
      canInstall: () => true,
      install: (args) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); },
    };
    const fixture = appFixture();
    const seen = runInitApp(fixture, updater, platform);
    assert.equal(seen.config.command_topic, "test/app/install");
    assert.equal(seen.config.payload_install, "update");
    assert.equal(seen.subscribed, "test/app/install");
    seen.handler("test/app/install", Buffer.from("bogus"));
    assert.equal(calls.length, 0);
    seen.handler("test/app/install", Buffer.from("update"));
    seen.handler("test/app/install", Buffer.from("update"));
    assert.equal(calls.length, 1, "duplicate commands must not start a second concurrent install");
    assert.equal(calls[0].latest.version, "9.9.9");
    assert.equal(typeof calls[0].onProgress, "function");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen.quitCalls, platform === "linux" ? 0 : 1);
    seen.handler("test/app/install", Buffer.from("update"));
    assert.equal(calls.length, platform === "linux" ? 2 : 1, "keep duplicate gate closed during detached handoff");
  }
});

test("actual release consumer makes no request when repository is absent", async () => {
  const source = fs.readFileSync(path.join(root, "js/webview.js"), "utf8");
  const start = source.indexOf("const latestRelease = async () => {");
  const end = source.indexOf("\n};", start) + 3;
  let requests = 0;
  await vm.runInNewContext(`${source.slice(start, end)}\nlatestRelease();`, {
    APP: createIdentity({ name: "ha.view" }), axios: { get() { requests++; throw new Error("unexpected request"); } }, console,
  });
  assert.equal(requests, 0);
});

test("actual release consumer supports verified project release metadata", async () => {
  const source = fs.readFileSync(path.join(root, "js/webview.js"), "utf8");
  const start = source.indexOf("const latestRelease = async () => {");
  const end = source.indexOf("\n};", start) + 3;
  const identity = createIdentity(withRepository("https://github.com/example-owner/example-project"));
  let updated = false;
  await vm.runInNewContext(`${source.slice(start, end)}\nlatestRelease();`, {
    APP: identity, ARGS: {}, console,
    axios: { async get(url) { assert.equal(url, identity.releases.url); return { data: [{ tag_name: "v2.0.0", html_url: `${identity.homepage}/releases/tag/v2.0.0` }] }; } },
    EVENTS: { emit(name) { updated = name === "updateApp"; } },
  });
  assert.equal(identity.releases.latest.version, "2.0.0");
  assert.equal(updated, true);
});

test("build script packages for the platform and Forge entry guards fail before builders run", () => {
  assert.throws(assertPackagingAllowed, /source-only/);
  assert.equal(metadata.scripts.build, "node ha.view/build/build.js");
  assert.equal(metadata.scripts["check-packaging"], "node ha.view/identity.js --check-packaging");
  const { targets } = require("./build/build");
  assert.deepEqual(targets, { linux: "build:linux-kiosk", win32: "build:windows-portable", darwin: "build:macos" });
  assert.equal(metadata.scripts["build:macos"], "node ha.view/build/launcher.js darwin");
  const result = spawnSync(process.execPath, [path.join(__dirname, "identity.js"), "--check-packaging"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source-only/);
  const forge = require("../forge.config");
  assert.deepEqual(forge.publishers, []);
  assert.equal(forge.makers[0].config.options.productName, "HA View");
  assert.equal(forge.makers.length, 2, "Keep reusable upstream maker configuration");
  for (const hook of ["generateAssets", "prePackage", "preMake", "prePublish"]) assert.throws(() => forge.hooks[hook](), /source-only/);
  assert.equal(forge.hooks.postPackage, undefined);
  assert.equal(forge.hooks.postMake, undefined);
});
