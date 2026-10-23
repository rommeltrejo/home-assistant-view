/** HA.View built-in updater: installs a verified release asset with the platform installer bundled in it. No remote scripts are downloaded or executed; the only network inputs are the release assets and their SHA-256 sidecars from the project repository. */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const https = require("node:https");
const http = require("node:http");
const { spawn } = require("node:child_process");

const assetName = ({ platform, arch, version }) => {
  if (!version) return null;
  if (platform === "linux") return `ha.view-${version}-linux-${arch}-kiosk.tar.gz`;
  if (platform === "win32") return `ha.view-${version}-win32-${arch}-portable.zip`;
  if (platform === "darwin") return `ha.view-${version}-darwin-${arch}.zip`;
  return null;
};

// A packaged app either carries a build.json written for its platform
// (Forge/launcher builds) or runs from a bundle payload directory
// (Linux kiosk and Windows portable layouts). Source checkouts qualify as neither.
const isPackaged = ({ platform, build, appPath }) => {
  if (build && build.platform === platform) return true;
  return typeof appPath === "string" && appPath.split(path.sep).includes("payload");
};

const canInstall = ({ platform, arch, build, appPath, access }) => {
  if (!assetName({ platform, arch, version: "0.0.0" })) return false;
  if (!isPackaged({ platform, build, appPath })) return false;
  // The Linux bundle installer elevates with sudo; without passwordless
  // sudo it would block on a prompt no one can answer from MQTT.
  if (platform === "linux") return Boolean(access && access.install);
  return true;
};

const selectAssets = (latest, name) => {
  const assets = Array.isArray(latest?.assets) ? latest.assets : [];
  const asset = assets.find((entry) => entry.name === name);
  const sidecar = assets.find((entry) => entry.name === `${name}.sha256`);
  if (!asset || !asset.url) throw new Error(`Release ${latest?.version ?? "?"} has no asset named ${name}`);
  if (!sidecar || !sidecar.url) throw new Error(`Release asset ${name} has no SHA-256 sidecar`);
  return { asset, sidecar };
};

const verifySidecar = (text, name, digest) => {
  const line = String(text).split("\n").find((entry) => entry.trim().length > 0);
  if (!line) return false;
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
  return Boolean(match) && match[1].toLowerCase() === digest.toLowerCase() && match[2].trim() === name;
};

const downloadToFile = (url, dest, onBytes) =>
  new Promise((resolve, reject) => {
    const request = (current, redirects) => {
      const transport = current.startsWith("https:") ? https : http;
      transport
        .get(current, { headers: { "User-Agent": "HA.View updater" } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            if (redirects <= 0) return reject(new Error(`Too many redirects for ${url}`));
            return request(new URL(response.headers.location, current).toString(), redirects - 1);
          }
          if (response.statusCode !== 200) {
            response.resume();
            return reject(new Error(`Download failed (${response.statusCode}) for ${current}`));
          }
          const total = Number(response.headers["content-length"]) || 0;
          let received = 0;
          const file = fs.createWriteStream(dest);
          response.on("data", (chunk) => {
            received += chunk.length;
            if (typeof onBytes === "function") onBytes(received, total);
          });
          response.pipe(file);
          file.on("finish", () => file.close(() => resolve({ received, total })));
          file.on("error", reject);
        })
        .on("error", reject);
    };
    request(url, 5);
  });

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (data) => process.stdout.write(data));
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });

const spawnDetached = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
};

// Windows portable: the payload exe is locked while running, so a detached
// helper waits for this process to exit, swaps the install root, relaunches.
const installWindows = async ({ staging, appPath }, deps) => {
  const zip = await deps.readZip(path.join(staging, "asset.zip"));
  const extracted = path.join(staging, "extracted");
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const target = path.join(extracted, entry.name);
    if (!target.startsWith(extracted + path.sep)) throw new Error(`Unsafe portable entry: ${entry.name}`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, await entry.async("nodebuffer"));
  }
  const installRoot = path.resolve(appPath, "..", "..", "..");
  const helper = path.join(staging, "apply-update.cmd");
  const script = [
    "@echo off",
    ":wait",
    `tasklist /FI "PID eq ${process.pid}" | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
    `robocopy "${extracted}" "${installRoot}" /E /NFL /NDL /NJH /NJS >nul`,
    `start "" "${path.join(installRoot, "Run.cmd")}"`,
    "",
  ].join("\r\n");
  await fs.promises.writeFile(helper, script);
  deps.spawnDetached("cmd", ["/c", helper]);
};

// macOS: a detached helper swaps the .app once this process exits and
// relaunches it, clearing the quarantine flag from the downloaded archive.
const installDarwin = async ({ staging, execPath }, deps) => {
  const extracted = path.join(staging, "extracted");
  await fs.promises.mkdir(extracted, { recursive: true });
  await deps.run("ditto", ["-x", "-k", path.join(staging, "asset.zip"), extracted]);
  const stagedApp = path.join(extracted, "ha.view.app");
  if (!fs.existsSync(stagedApp)) throw new Error("macOS asset does not contain ha.view.app");
  const bundle = path.resolve(execPath, "..", "..", "..");
  if (!bundle.endsWith(".app")) throw new Error(`Unexpected executable location: ${execPath}`);
  const helper = path.join(staging, "apply-update.sh");
  const script = [
    "#!/bin/sh",
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
    `rm -rf "${bundle}"`,
    `cp -R "${stagedApp}" "${bundle}"`,
    `xattr -dr com.apple.quarantine "${bundle}" 2>/dev/null`,
    `open "${bundle}"`,
    "",
  ].join("\n");
  await fs.promises.writeFile(helper, script, { mode: 0o755 });
  deps.spawnDetached("/bin/sh", [helper]);
};

// Linux kiosk: the bundle installer is the platform updater. It elevates
// with sudo itself, stops the running payload, swaps versions atomically
// and the supervisor restarts the app; the previous version is retained.
const installLinux = async ({ staging }, deps) => {
  await deps.run("tar", ["-xzf", path.join(staging, "asset.tar.gz"), "-C", staging]);
  const entries = await fs.promises.readdir(staging, { withFileTypes: true });
  const bundle = entries.find((entry) => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, "install.py")));
  if (!bundle) throw new Error("Linux asset does not contain a kiosk bundle with install.py");
  await deps.run("python3", [path.join(staging, bundle.name, "install.py"), "--force"]);
};

const install = async ({ app, latest, onProgress = () => {}, deps = {} }) => {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const execPath = deps.execPath ?? process.execPath;
  const runtime = {
    downloadToFile,
    sha256File,
    run,
    spawnDetached,
    readZip: async (file) => require("jszip").loadAsync(await fs.promises.readFile(file)),
    ...deps,
  };
  const name = assetName({ platform, arch, version: latest?.version });
  if (!name) throw new Error(`No release asset for platform ${platform}`);
  const { asset, sidecar } = selectAssets(latest, name);
  // Stage on disk (the app cache directory), not /tmp: kiosk /tmp is often a
  // small tmpfs that a 100+ MB archive plus its extraction would exhaust.
  const stagingParent = deps.stagingParent ?? app?.cache ?? os.tmpdir();
  await fs.promises.mkdir(stagingParent, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(stagingParent, "ha-view-update-"));
  try {
    const archive = path.join(staging, platform === "linux" ? "asset.tar.gz" : "asset.zip");
    onProgress(10);
    await runtime.downloadToFile(asset.url, archive, (received, total) => {
      if (total > 0) onProgress(10 + Math.round((received / total) * 35));
    });
    onProgress(50);
    const sidecarPath = path.join(staging, "asset.sha256");
    await runtime.downloadToFile(sidecar.url, sidecarPath);
    const digest = await runtime.sha256File(archive);
    if (!verifySidecar(await fs.promises.readFile(sidecarPath, "utf8"), name, digest)) {
      throw new Error(`SHA-256 mismatch for ${name}; refusing to install`);
    }
    onProgress(65);
    if (platform === "linux") await installLinux({ staging }, runtime);
    else if (platform === "win32") await installWindows({ staging, appPath: app.path }, runtime);
    else if (platform === "darwin") await installDarwin({ staging, execPath }, runtime);
    onProgress(100);
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

module.exports = { assetName, isPackaged, canInstall, selectAssets, verifySidecar, downloadToFile, install };
