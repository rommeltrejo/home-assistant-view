const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assetName, canInstall, selectAssets, verifySidecar, install } = require("./updater");

test("release asset names follow the published per-platform naming", () => {
  assert.ok(require("../package.json").dependencies.jszip, "The Windows updater needs jszip in the packaged runtime, not just development dependencies");
  assert.equal(assetName({ platform: "linux", arch: "x64", version: "1.2.3" }), "ha.view-1.2.3-linux-x64-kiosk.tar.gz");
  assert.equal(assetName({ platform: "win32", arch: "x64", version: "1.2.3" }), "ha.view-1.2.3-win32-x64-portable.zip");
  assert.equal(assetName({ platform: "darwin", arch: "arm64", version: "1.2.3" }), "ha.view-1.2.3-darwin-arm64.zip");
  assert.equal(assetName({ platform: "freebsd", arch: "x64", version: "1.2.3" }), null);
  assert.equal(assetName({ platform: "linux", arch: "x64", version: "" }), null);
});

test("install is offered only for packaged apps, and Linux also needs passwordless sudo", () => {
  const payload = "/opt/ha.view-kiosk/current/payload/resources/app";
  assert.equal(canInstall({ platform: "linux", arch: "x64", build: {}, appPath: payload, access: { install: true } }), true);
  assert.equal(canInstall({ platform: "linux", arch: "x64", build: {}, appPath: payload, access: { install: false } }), false);
  assert.equal(canInstall({ platform: "linux", arch: "x64", build: {}, appPath: "/home/user/home-assistant-view", access: { install: true } }), false);
  assert.equal(canInstall({ platform: "win32", arch: "x64", build: {}, appPath: "C:\\kiosk\\payload\\resources\\app".replaceAll("\\", path.sep), access: {} }), true);
  assert.equal(canInstall({ platform: "darwin", arch: "arm64", build: { platform: "darwin" }, appPath: "/Applications/HA View.app/Contents/Resources/app", access: {} }), true);
  assert.equal(canInstall({ platform: "darwin", arch: "arm64", build: {}, appPath: "/Users/x/home-assistant-view", access: {} }), false);
});

test("asset selection requires the platform asset and its sidecar", () => {
  const name = "ha.view-1.2.3-linux-x64-kiosk.tar.gz";
  const latest = { version: "1.2.3", assets: [{ name, url: "https://example.test/a" }, { name: `${name}.sha256`, url: "https://example.test/b" }] };
  assert.equal(selectAssets(latest, name).asset.url, "https://example.test/a");
  assert.throws(() => selectAssets({ version: "1.2.3", assets: [] }, name), /no asset named/);
  assert.throws(() => selectAssets({ version: "1.2.3", assets: [{ name, url: "https://example.test/a" }] }, name), /no SHA-256 sidecar/);
});

test("sidecar verification pins both the digest and the asset name", () => {
  const digest = "a".repeat(64);
  assert.equal(verifySidecar(`${digest}  ha.view-x.zip\n`, "ha.view-x.zip", digest), true);
  assert.equal(verifySidecar(`${digest}  other.zip\n`, "ha.view-x.zip", digest), false);
  assert.equal(verifySidecar(`${"b".repeat(64)}  ha.view-x.zip\n`, "ha.view-x.zip", digest), false);
  assert.equal(verifySidecar("", "ha.view-x.zip", digest), false);
});

const latestFixture = (name) => ({
  version: "9.9.9",
  assets: [
    { name, url: "https://example.test/asset" },
    { name: `${name}.sha256`, url: "https://example.test/sidecar" },
  ],
});

const downloadStub = (name, digest) => async (url, dest) => {
  await fs.promises.writeFile(dest, url.endsWith("sidecar") ? `${digest}  ${name}\n` : "ARCHIVE");
};

test("Linux install downloads, verifies and runs the bundle installer", async () => {
  const name = assetName({ platform: "linux", arch: "x64", version: "9.9.9" });
  const digest = "c".repeat(64);
  const runs = [];
  const progress = [];
  await install({
    app: { path: "/opt/ha.view-kiosk/current/payload/resources/app" },
    latest: latestFixture(name),
    onProgress: (value) => progress.push(value),
    deps: {
      platform: "linux", arch: "x64",
      downloadToFile: downloadStub(name, digest),
      sha256File: async () => digest,
      run: async (command, args) => {
        runs.push([command, ...args]);
        if (command === "tar") {
          const staging = args[3];
          const bundle = path.join(staging, "ha.view-9.9.9-linux-x64-kiosk");
          await fs.promises.mkdir(bundle, { recursive: true });
          await fs.promises.writeFile(path.join(bundle, "install.py"), "# stub\n");
        }
      },
    },
  });
  assert.equal(runs[0][0], "tar");
  assert.equal(runs[1][0], "python3");
  assert.ok(runs[1][1].endsWith(path.join("ha.view-9.9.9-linux-x64-kiosk", "install.py")));
  assert.equal(runs[1][2], "--force");
  assert.equal(progress.at(-1), 100);
});

test("a hash mismatch refuses the install before anything runs", async () => {
  const name = assetName({ platform: "linux", arch: "x64", version: "9.9.9" });
  let ran = false;
  await assert.rejects(
    install({
      app: { path: "/opt/ha.view-kiosk/current/payload/resources/app" },
      latest: latestFixture(name),
      deps: {
        platform: "linux", arch: "x64",
        downloadToFile: downloadStub(name, "d".repeat(64)),
        sha256File: async () => "e".repeat(64),
        run: async () => { ran = true; },
      },
    }),
    /SHA-256 mismatch/,
  );
  assert.equal(ran, false);
});

test("Windows install extracts the portable ZIP and hands off to a detached swap helper", async () => {
  const name = assetName({ platform: "win32", arch: "x64", version: "9.9.9" });
  const digest = "f".repeat(64);
  const detached = [];
  await install({
    app: { path: path.join(os.tmpdir(), "portable", "payload", "resources", "app") },
    latest: latestFixture(name),
    deps: {
      platform: "win32", arch: "x64",
      downloadToFile: downloadStub(name, digest),
      sha256File: async () => digest,
      readZip: async () => ({ files: { "payload/ha.view.exe": { dir: false, name: "payload/ha.view.exe", async: async () => Buffer.from("exe") }, "Run.cmd": { dir: false, name: "Run.cmd", async: async () => Buffer.from("run") } } }),
      spawnDetached: (command, args) => detached.push([command, ...args]),
    },
  });
  assert.equal(detached.length, 1);
  assert.equal(detached[0][0], "cmd");
  const helper = await fs.promises.readFile(detached[0][2], "utf8");
  assert.match(helper, /robocopy/);
  assert.match(helper, /Run\.cmd/);
});

test("macOS install extracts the app ZIP and hands off to a detached swap helper", async () => {
  const name = assetName({ platform: "darwin", arch: "arm64", version: "9.9.9" });
  const digest = "0".repeat(64);
  const detached = [];
  const runs = [];
  await install({
    app: { path: "/Applications/HA View.app/Contents/Resources/app" },
    latest: latestFixture(name),
    deps: {
      platform: "darwin", arch: "arm64",
      execPath: "/Applications/HA View.app/Contents/MacOS/ha.view",
      downloadToFile: downloadStub(name, digest),
      sha256File: async () => digest,
      run: async (command, args) => {
        runs.push(command);
        const extracted = args[3];
        await fs.promises.mkdir(path.join(extracted, "ha.view.app"), { recursive: true });
      },
      spawnDetached: (command, args) => detached.push([command, ...args]),
    },
  });
  assert.deepEqual(runs, ["ditto"]);
  assert.equal(detached.length, 1);
  const helper = await fs.promises.readFile(detached[0][1], "utf8");
  assert.match(helper, /cp -R/);
  assert.match(helper, /xattr -dr com\.apple\.quarantine/);
  assert.match(helper, /open "\/Applications\/HA View\.app"/);
});
