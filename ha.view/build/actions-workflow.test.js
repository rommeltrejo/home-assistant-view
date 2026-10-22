/** Offline workflow contract; no GitHub calls or native builds. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const { findTests } = require('./ci-test');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const workflow = yaml.load(source);
const pins = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node': '949feb2413d6458794dcd2491c4babbbce0c15c1',
  'actions/upload-artifact': 'cf430e030ddbb5b0abf93d22962f4752f3646cd9'
};
test('unsigned workflow has bounded native runners and read-only triggers', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  for (const event of ['push', 'pull_request']) assert.deepEqual(workflow.on[event].branches, ['main']);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['linux', 'windows']);
  assert.equal(workflow.jobs.windows['runs-on'], 'windows-2022');
  assert.equal(workflow.jobs.linux['runs-on'], 'ubuntu-24.04');
  assert.doesNotMatch(source, /secrets\.|publish|macos|contents: write|pull_request_target/i);
  for (const job of Object.values(workflow.jobs)) {
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 30);
    for (const step of job.steps.filter(s => s.uses)) {
      const [action, sha] = step.uses.split('@');
      assert.equal(sha, pins[action]);
    }
    assert.equal(job.steps.find(s => s.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
    assert.equal(job.steps.find(s => s.uses?.startsWith('actions/setup-node@')).with['node-version'], '24.x');
    const runs = job.steps.filter(s => s.run).map(s => s.run);
    assert.ok(runs.includes('npm ci'));
    assert.ok(runs.includes('npm run lint'));
    assert.ok(runs.includes('npm run test:all'));
    assert.ok(runs.indexOf('npm run lint') < runs.indexOf('npm run test:all'));
    const upload = job.steps.find(s => s.uses?.startsWith('actions/upload-artifact@')).with;
    assert.equal(upload['if-no-files-found'], 'error');
    assert.ok(upload['retention-days'] > 0 && upload['retention-days'] <= 14);
    assert.equal(upload['compression-level'], 0);
    const paths = upload.path.trim().split('\n');
    assert.equal(paths.length, 2);
    assert.match(paths[0], /(?:\.zip|\.tar\.gz)$/);
    assert.equal(paths[1], paths[0] + '.sha256');
  }
});
test('native host compilation, self-test and packaging remain ordered', () => {
  const steps = workflow.jobs.windows.steps;
  const compileIndex = steps.findIndex(s => s.run?.includes('Framework64'));
  const compile = steps[compileIndex];
  assert.equal(compile.shell, 'pwsh');
  for (const arg of ['/platform:x64', '/r:System.Web.Extensions.dll', '/r:Microsoft.CSharp.dll', '/r:System.Security.dll', 'os/windows/kiosk/native/Kiosk.cs', '& $native self-test', 'HA_VIEW_KIOSK_NATIVE=$native', '$env:GITHUB_ENV']) assert.ok(compile.run.includes(arg), arg);
  assert.equal((compile.run.match(/if \(\$LASTEXITCODE -ne 0\)/g) || []).length, 2);
  assert.ok(compileIndex < steps.findIndex(s => s.run === 'npm run build:windows-portable'));
  const linuxRuns = workflow.jobs.linux.steps.map(s => s.run || '').join('\n');
  assert.match(linuxRuns, /python3 -B -m unittest discover -s os\/linux\/kiosk/);
  assert.match(linuxRuns, /npm run build:linux-kiosk/);
});
test('Node discovery uses filesystem paths rather than shell globs', () => {
  const tests = findTests(path.join(root, 'ha.view'));
  assert.ok(tests.includes(__filename));
  assert.ok(tests.every(file => path.isAbsolute(file) && file.endsWith('.test.js')));
  assert.equal(new Set(tests).size, tests.length);
});

test('checkout keeps source LF and Windows launchers CRLF regardless of autocrlf', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-checkout-'));
  const git = args => execFileSync('git', args, { cwd: temp, encoding: 'utf8' });
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => /\.(?:js|cjs|mjs|json|css|html|yml|yaml|sh|py|ps1|cs|cmd)$/.test(file) && fs.existsSync(path.join(root, file)));
  try {
    git(['init', '--quiet']);
    // Do not inherit runner/user attributes or conversion settings while staging.
    git(['config', 'core.attributesFile', path.join(temp, 'no-global-attributes')]);
    git(['config', 'core.autocrlf', 'false']);
    git(['config', 'core.safecrlf', 'false']);
    fs.copyFileSync(path.join(root, '.gitattributes'), path.join(temp, '.gitattributes'));
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(temp, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(temp, file));
    }
    const binary = Buffer.from([0, 13, 10, 255, 13, 10]);
    fs.writeFileSync(path.join(temp, 'binary.png'), binary);
    git(['add', '.']);
    for (const autocrlf of ['true', 'false']) {
      git(['config', 'core.autocrlf', autocrlf]);
      for (const file of [...files, 'binary.png']) fs.unlinkSync(path.join(temp, file));
      git(['checkout-index', '--all', '--force']);
      for (const file of files) {
        const text = fs.readFileSync(path.join(temp, file), 'utf8');
        if (file.endsWith('.cmd')) {
          assert.match(text, /\r\n/, `${file}: CRLF launcher (autocrlf=${autocrlf})`);
          assert.doesNotMatch(text, /(?<!\r)\n/, `${file}: no bare LF`);
        } else {
          assert.doesNotMatch(text, /\r/, `${file}: LF source (autocrlf=${autocrlf})`);
        }
      }
      assert.deepEqual(fs.readFileSync(path.join(temp, 'binary.png')), binary);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
