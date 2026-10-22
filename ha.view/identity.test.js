const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { createIdentity, applyIdentityPolicy, assertPackagingAllowed } = require("./identity");
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
  assert.deepEqual(identity.scripts, { install: null });
  assert.deepEqual(identity.source, { name: "TouchKio", author: "leukipp", license: "MIT", url: "https://github.com/leukipp/touchkio" });
  assert.equal(createIdentity({ ...metadata, homepage: "https://github.com/leukipp/ha.view", author: { name: "Other Owner" } }).repository.url, identity.repository.url);
});

test("explicit verified project repository supports links without enabling installers or packaging", () => {
  // Syntactic fixture only; no claim that this example repository exists.
  const identity = createIdentity(withRepository("https://github.com/example-owner/example-project"));
  assert.equal(identity.homepage, "https://github.com/example-owner/example-project");
  assert.equal(identity.issues, `${identity.homepage}/issues`);
  assert.equal(identity.releases.url, "https://api.github.com/repos/example-owner/example-project/releases");
  assert.equal(identity.scripts.install, null);
  assert.equal(identity.sourceOnly, true);
  const args = { app_disable: [] };
  applyIdentityPolicy(identity, args);
  assert.deepEqual(args.app_disable, ["mqtt_app"]);
});

test("unverified, upstream, and malformed repositories fail closed", () => {
  assert.equal(createIdentity(withRepository("https://github.com/example-owner/example-project", false)).repository, null);
  for (const url of ["https://github.com/leukipp/touchkio", "https://github.com/LEUKIPP/HA.VIEW", "http://github.com/a/b", "https://github.com/a/b?x=1", "https://github.com/a/b;whoami", "https://github.com/a/..", "https://github.com@evil.test/a/b", "https://github.com/a/b/main"]) {
    assert.equal(createIdentity(withRepository(url)).repository, null, url);
  }
});

test("policy preserves existing disables and prevents protected upstream installer registration", () => {
  const identity = createIdentity(metadata);
  const args = { app_disable: ["web_idle"] };
  applyIdentityPolicy(identity, args);
  applyIdentityPolicy(identity, args);
  assert.deepEqual(args.app_disable, ["web_idle", "mqtt_app"]);
  const source = fs.readFileSync(path.join(root, "js/integration.js"), "utf8");
  const start = source.indexOf("const initApp = () => {");
  const end = source.indexOf("const updateApp =", start);
  let removed = false;
  vm.runInNewContext(`${source.slice(start, end)}\ninitApp();`, {
    APP: identity, ARGS: args, INTEGRATION: { root: "test", node: "test", device: {} },
    HARDWARE: { support: { access: { install: true, service: true, deb: true } } },
    removeConfig(type, config) { removed = type === "update"; },
    publishConfig() { assert.fail("Must not register an installer or MQTT subscription"); },
  });
  assert.equal(removed, true);
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

test("default build script and Forge entry guards fail before builders run", () => {
  assert.throws(assertPackagingAllowed, /source-only/);
  assert.equal(metadata.scripts.build, "node ha.view/identity.js --check-packaging");
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
