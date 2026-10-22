/** HA.View source branding audit; upstream packaging artwork stays reusable. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("actual source initialization uses HA View title without upstream runtime artwork", async () => {
  const source = read("index.js");
  const start = source.indexOf("const initApp = async () => {");
  const end = source.indexOf("\n};", start) + 3;
  const APP = {};
  const app = {
    getAppPath: () => root, getName: () => "ha.view", getVersion: () => "1.6.0",
    getPath: () => "/tmp/ha.view-branding-test", requestSingleInstanceLock: () => true,
    on() {},
  };
  await vm.runInNewContext(`${source.slice(start, end)}\ninitApp();`, {
    fs, path, APP, app, createIdentity: require("./identity").createIdentity,
    process: { on() {} }, powerMonitor: { on() {} },
  });
  assert.equal(APP.name, "ha.view");
  assert.equal(APP.title, "HA View");
  assert.equal(APP.icon, undefined, "Use Electron default until approved HA.View artwork exists");
  assert.equal(APP.homepage, "https://github.com/rommeltrejo/home-assistant-view");
  assert.equal(APP.issues, "https://github.com/rommeltrejo/home-assistant-view/issues");
  assert.equal(APP.releases.url, "https://api.github.com/repos/rommeltrejo/home-assistant-view/releases");
  assert.equal(APP.scripts.install, null);
  const webview = read("js/webview.js");
  assert.match(webview, /title: APP\.title/);
  assert.match(webview, /icon: APP\.icon/);
  assert.doesNotMatch(webview, /new Tray\s*\(|img[/'", ]+icon\.png/);
  assert.match(read("html/header.html"), /<title>HA View window controls<\/title>/);
});

test("upstream installer fails before commands or downloads even with update arguments", () => {
  for (const args of [[], ["update"], ["early", "update"]]) {
    const result = spawnSync("/bin/bash", [path.join(root, "install.sh"), ...args], {
      encoding: "utf8", env: { PATH: "/nonexistent" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "HA View is source-only: installation and updates are disabled.\n");
  }
});

test("unsigned PR builds remain read-only and automatic one-shot release is gated", () => {
  const workflow = read(".github/workflows/release.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches: \['main'\]/);
  assert.match(workflow, /runs-on: windows-2022/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /needs: \[linux, windows\]/);
  assert.match(workflow, /needs: \[verify-release\]/);
  assert.match(workflow, /github.event_name == 'push'/);
  assert.match(workflow, /contains\(github.event.head_commit.message, 'Enable one-shot 0\.34 release'\)/);
  assert.doesNotMatch(workflow, /electron-forge publish/);
});

test("upstream assets, maker configuration and provenance remain available", () => {
  for (const file of ["img/icon.png", "img/display.png", "img/mqtt.png"]) {
    assert.equal(fs.readFileSync(path.join(root, file)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
  const forge = require("../forge.config");
  assert.equal(forge.makers[0].config.options.icon, "img/icon.png");
  assert.equal(forge.makers.length, 2);
  assert.deepEqual(forge.publishers, []);
  assert.match(read("LICENSE"), /Copyright \(c\) 2024 leukipp\nCopyright \(c\) 2026 HA\.View/);
  assert.match(read("README.md"), /## Credits/);
  assert.match(read("README.md"), /TouchKio.*leukipp.*MIT/);
  assert.match(read("README.md"), /not affiliated with Apple/);
  assert.match(read("README.md"), /https:\/\/github\.com\/leukipp\/touchkio/);
});

test("source start defaults to Home Assistant only, without a deferred photo backend", () => {
  const metadata = JSON.parse(read("package.json"));
  assert.equal(metadata.scripts.start, "electron .");
});
