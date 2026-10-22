/** HA.View build policy tests; no downloads or real packaging. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArguments, assertTarget } = require('./targets');
const { createConfig, appPath } = require('./config');
const { assets, ignore } = require('./files');
const { run } = require('./launcher');
const root = path.resolve(__dirname, '../..');
test('native Mac architecture, cross-platform defaults, and explicit architectures', () => {
  assert.deepEqual(parseArguments(['darwin'], { platform: 'darwin', arch: 'arm64' }), { platform: 'darwin', arch: 'arm64' });
  assert.equal(parseArguments(['darwin'], { platform: 'darwin', arch: 'x64' }).arch, 'x64');
  assert.equal(parseArguments(['darwin'], { platform: 'win32', arch: 'x64' }).arch, 'arm64');
  assert.equal(parseArguments(['win32'], { platform: 'darwin', arch: 'arm64' }).arch, 'x64');
  for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
    assert.deepEqual(parseArguments([platform, '--arch', arch]), { platform, arch });
    assert.deepEqual(parseArguments([platform, `--arch=${arch}`]), { platform, arch });
  }
});
test('invalid arguments fail closed before Forge loads', async () => {
  for (const args of [[], ['linux'], ['mas'], ['darwin', '--arch', 'universal'], ['win32', '--arch=ia32'], ['win32', '--publish'], ['darwin', '--arch'], ['darwin', '--targets', 'deb'], ['win32', '--arch=x64', '--sign']]) {
    assert.throws(() => parseArguments(args));
    await assert.rejects(run(args, { forge: { make() { assert.fail('builder called'); } } }));
  }
  assert.throws(() => assertTarget('linux', 'x64'));
});
test('dedicated config has Mac ZIP / Windows portable, no signing/publishing, and exact-target guards', () => {
  for (const platform of ['darwin', 'win32']) for (const arch of ['arm64', 'x64']) {
    const config = createConfig({ platform, arch });
    if (platform === 'darwin') {
      assert.equal(config.makers[0].name, '@electron-forge/maker-zip');
      assert.deepEqual(config.makers[0].platforms, [platform]);
      assert.deepEqual(config.makers[0].config, {});
    } else assert.deepEqual(config.makers, []);
    assert.deepEqual(config.publishers, []);
    assert.equal(config.packagerConfig.osxSign, false);
    assert.equal(config.packagerConfig.osxNotarize, false);
    assert.equal(config.packagerConfig.asar, false);
    assert.equal(config.packagerConfig.prune, true);
    assert.equal(config.packagerConfig.executableName, 'ha.view');
    for (const hook of ['generateAssets', 'prePackage']) {
      config.hooks[hook](config, platform, arch);
      assert.throws(() => config.hooks[hook](config, 'linux', arch));
      assert.throws(() => config.hooks[hook](config, platform, arch === 'x64' ? 'arm64' : 'x64'));
    }
    assert.throws(() => config.hooks.prePublish(), /publishing is disabled/);
  }
  assert.throws(() => createConfig({ platform: 'linux', arch: 'x64' }));
});
test('allowlist includes runtime assets but not local profiles, credentials, experiments or tooling', async () => {
  for (const asset of assets) {
    assert.equal(ignore('/' + asset), false, asset);
    assert.equal(ignore('\\' + asset.replace(/\//g, '\\')), false, asset);
    await fs.access(path.join(root, asset));
  }
  for (const name of ['', '/ha.view', '/ha.view/faces', '/node_modules', '/node_modules/axios/index.js']) assert.equal(ignore(name), false, name);
  for (const name of ['.git/config', 'out/a.zip', 'tools/probe.js', '.env', 'profile.json', 'credentials.json', 'install.sh', 'forge.config.js', 'os/macos/build.sh', 'ha.view/build/config.js', 'ha.view/context.test.js', 'ha.view/verify-electron.cjs', 'ha.view/mockup/home-view.html', 'ha.view/faces/photos.html', 'ha.view/private.js', 'node_modules/.cache/token', 'node_modules/axios/.env', 'node_modules/axios/credentials.json']) assert.equal(ignore('/' + name), true, name);
});
// Inspect source, never execute Electron/runtime modules or touch user profiles.
async function assertLocalDependencyClosure(included) {
  const { createRequire } = require('node:module');
  for (const asset of included) {
    if (!/\.(?:js|cjs|html)$/.test(asset)) continue;
    const source = await fs.readFile(path.join(root, asset), 'utf8');
    const requests = [...source.matchAll(/\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g)].map(match => match[2]);
    if (asset.endsWith('.html')) {
      requests.push(...[...source.matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi)]
        .map(match => match[2]).filter(request => !/^(?:[a-z]+:|\/\/)/i.test(request)));
      for (const [tag] of source.matchAll(/<link\b[^>]*>/gi)) {
        const rel = /\brel\s*=\s*(['"])([^'"]+)\1/i.exec(tag);
        const href = /\bhref\s*=\s*(['"])([^'"]+)\1/i.exec(tag);
        if (rel && /(?:^|\s)stylesheet(?:\s|$)/i.test(rel[2]) && href && !/^(?:[a-z]+:|\/\/)/i.test(href[2])) {
          requests.push(href[2].split(/[?#]/)[0]);
        }
      }
    }
    const resolve = createRequire(path.join(root, asset)).resolve;
    for (const request of requests) {
      const dependency = path.relative(root, resolve(request.startsWith('.') ? request : './' + request)).split(path.sep).join('/');
      assert.ok(included.has(dependency), `${asset} -> ${request}: missing packaged dependency ${dependency}`);
      assert.equal(ignore('/' + dependency), false, dependency);
    }
  }
}
test('packaged runtime includes every literal local require and HTML script and local stylesheet dependency transitively', async () => {
  await assertLocalDependencyClosure(assets);
});
test('dependency validation catches the hooks calendar crash and missing transitive face and layout dependencies', async () => {
  for (const missing of ['ha.view/calendar-availability.js', 'ha.view/face-changer-renderer.js', 'ha.view/face-modes.js', 'ha.view/face-registry.js', 'ha.view/layout-store.js', 'ha.view/layout-runtime.js', 'ha.view/layout-face.js']) {
    const incomplete = new Set(assets);
    incomplete.delete(missing);
    await assert.rejects(assertLocalDependencyClosure(incomplete), error =>
      error.code === 'ERR_ASSERTION' && error.message.includes(missing));
  }
});
test('dependency validation rejects missing local HTML stylesheets', async () => {
  for (const missing of ['ha.view/face-settings.css', 'ha.view/layout.css']) {
    const incomplete = new Set(assets);
    incomplete.delete(missing);
    await assert.rejects(assertLocalDependencyClosure(incomplete), error =>
      error.code === 'ERR_ASSERTION' && error.message.includes(missing));
  }
});
test('metadata is written inside the real app before ZIP creation, never into a fabricated ZIP path', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ha-view-build-test-'));
  try {
    for (const platform of ['darwin', 'win32']) {
      const output = path.join(temporary, `ha.view-${platform}-arm64`);
      const app = appPath(output, platform);
      await fs.mkdir(app, { recursive: true });
      const config = createConfig({ platform, arch: 'arm64' });
      await config.hooks.postPackage(config, { platform, arch: 'arm64', outputPaths: [output] });
      const metadata = JSON.parse(await fs.readFile(path.join(app, 'build.json'), 'utf8'));
      assert.equal(metadata.platform, platform);
      assert.equal(metadata.arch, 'arm64');
      assert.equal(metadata.maker, platform === 'darwin' ? 'zip' : 'portable');
      assert.equal(metadata.signed, false);
      assert.equal(metadata.portable, true);
      assert.equal(metadata.installer, platform === 'win32' ? false : undefined);
      assert.match(metadata.id, /^[a-f0-9]{6}$/);
      assert.ok(Number.isFinite(Date.parse(metadata.date)));
      assert.equal(config.hooks.postMake, undefined);
    }
    assert.throws(() => appPath(temporary, 'linux'));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('launcher registers only dedicated config, passes explicit target/ZIP and cleans registration', async () => {
  await fs.mkdir('/tmp/ha-view-portable-fixture/resources/app', { recursive: true });
  for (const fails of [false, true]) {
    let registered;
    let cleaned = false;
    const operation = run(['win32', '--arch=arm64'], {
      host: { platform: 'win32', arch: 'x64' },
      stat: async () => ({ isFile: () => true, size: 100 }),
      registry: {
        registerForgeConfigForDirectory(dir, config) { assert.equal(dir, root); registered = config; },
        unregisterForgeConfigForDirectory(dir) { assert.equal(dir, root); cleaned = true; },
      },
      builder: { Arch: { arm64: 1 }, Platform: { WINDOWS: { createTarget: (name, arch) => { assert.equal(name, 'portable'); assert.equal(arch, 1); return 'fixture-portable'; } } }, async build(options) {
        assert.equal(options.targets, 'fixture-portable');
        assert.equal(options.publish, 'never');
        assert.equal(options.config.directories.output, path.join(root, 'out/make/portable/arm64'));
        assert.deepEqual(options.config.portable, { artifactName: 'ha.view-${version}-${arch}.exe' });
        assert.equal(options.config.nsis, undefined);
        assert.equal(options.config.npmRebuild, false);
        assert.equal(options.prepackaged, '/tmp/ha-view-portable-fixture');
        assert.equal(options.config.win.signAndEditExecutable, false);
        return ['/fixture.exe'];
      } },
      forge: { async package(options) {
        assert.ok(registered);
        assert.deepEqual(options, { dir: root, platform: 'win32', arch: 'arm64', interactive: true });
        if (fails) throw new Error('fixture failure');
        await registered.hooks.postPackage(registered, { platform: 'win32', arch: 'arm64', outputPaths: ['/tmp/ha-view-portable-fixture'] });
        // Avoid filesystem fixture writes while exercising the captured Forge output hook.
        return;
      } },
    });
    if (fails) await assert.rejects(operation, /fixture failure/);
    else assert.deepEqual(await operation, [{ platform: 'win32', arch: 'arm64', artifacts: ['/fixture.exe'] }]);
    assert.equal(cleaned, true);
  }
});
test('installed Forge integration APIs and ZIP host support exist without invoking builds', () => {
  const forge = require('@electron-forge/core').api;
  const registry = require('./forge-config');
  const MakerZIP = require('@electron-forge/maker-zip').default;
  assert.equal(typeof forge.make, 'function');
  assert.equal(typeof registry.registerForgeConfigForDirectory, 'function');
  const maker = new MakerZIP({}, ['darwin', 'win32']);
  assert.equal(maker.isSupportedOnCurrentPlatform(), true);
});

test('absent, wrong-target, missing and empty artifacts fail instead of returning success', async () => {
  const { validateArtifacts } = require('./launcher');
  const target = { platform: 'darwin', arch: 'arm64' };
  const result = artifacts => [{ ...target, artifacts }];
  for (const outputs of [undefined, [], result([]), result(['relative.zip']), result(['/tmp/a.exe']), [{ platform: 'win32', arch: 'arm64', artifacts: ['/tmp/a.zip'] }]]) await assert.rejects(validateArtifacts(outputs, target));
  await assert.rejects(validateArtifacts(result(['/tmp/a.zip']), target, async () => ({ isFile: () => true, size: 0 })), /empty/);
  await assert.rejects(validateArtifacts(result(['/tmp/a.zip']), target, async () => { throw new Error('ENOENT'); }), /ENOENT/);
});
test('unresolved Forge promise cannot silently exit zero', () => {
  const { spawnSync } = require('node:child_process');
  const script = `require(${JSON.stringify(path.join(__dirname, 'launcher.js'))}).run(['darwin'], {
    forge: { make: () => new Promise(() => {}) },
    registry: { registerForgeConfigForDirectory() {}, unregisterForgeConfigForDirectory() {} }
  });`;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /ended before Forge completed/);
});
test('invalid Node override and child failure preserve nonzero CLI status', () => {
  const { spawnSync } = require('node:child_process');
  const launcher = path.join(__dirname, 'launcher.js');
  const missing = spawnSync(process.execPath, [launcher, 'win32'], {
    encoding: 'utf8', env: { ...process.env, HA_VIEW_BUILD_NODE: path.join(os.tmpdir(), 'ha-view-no-such-node-executable') },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
});
