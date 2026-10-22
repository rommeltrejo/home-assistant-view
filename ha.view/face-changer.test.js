const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FaceChanger } = require('./face-changer');
const store = require('./face-changer-store');
function fixture() {
  const calls = [];
  const c = new FaceChanger(Object.fromEntries(['open', 'dismiss', 'preview', 'select', 'cancel'].map(k => [k, n => calls.push([k, n])])));
  return { c, calls };
}
test('short tap is release-only; movement/cancel never dismiss', () => {
  const { c, calls } = fixture(); c.input('down', 10, 10); assert.deepEqual(calls, []); c.input('up', 10, 10);
  assert.equal(calls[0][0], 'dismiss');
  c.input('down', 10, 10); c.input('move', 40, 10); c.input('up', 10, 10);
  c.input('down'); c.input('cancel'); c.input('up'); assert.equal(calls.length, 1);
});
test('600ms hold opens once; opening release cannot select or dismiss; swipe then select', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { c, calls } = fixture(); c.input('down', 200, 200); t.mock.timers.tick(599); assert.equal(calls.length, 0);
  t.mock.timers.tick(1); c.input('up', 200, 200); assert.deepEqual(calls, [['open', undefined]]);
  c.input('down', 400, 200); c.input('move', 100, 205); c.input('up', 100, 205); assert.equal(c.index, 2);
  c.input('down', 200, 200); c.input('up', 200, 200); assert.deepEqual(calls.at(-1), ['select', 2]);
});
test('cancelled holds, vertical drags, bounds and abort', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const { c, calls } = fixture();
  c.input('down'); c.reset(); t.mock.timers.tick(1000); assert.equal(calls.length, 0);
  c.picking = true; c.input('down'); c.input('up', 2, 150); assert.equal(calls.length, 0);
  c.input('down', 300, 100); c.input('up', 100, 100); c.input('down', 300, 100); c.input('up', 100, 100); assert.equal(c.index, 2);
  c.abort(); assert.equal(c.picking, false); assert.equal(calls.at(-1)[0], 'cancel');
});
test('selected face survives a new store read; corrupt/invalid data uses fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-face-test-')); const file = path.join(dir, 'choice.json');
  try { assert.equal(store.read(file), 2); store.write(file, 2); assert.equal(store.read(file, 1), 2);
    assert.throws(() => store.write(file, 3)); assert.equal(store.read(file), 2);
    fs.writeFileSync(file, '{bad'); assert.equal(store.read(file, 2), 2);
    fs.writeFileSync(file, '{"face":9}'); assert.equal(store.read(file), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('hidden IDs migrate defaults, persist across selections, and preserve existing fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-hidden-')), file = path.join(dir, 'face.json');
  try {
    assert.deepEqual(store.readHidden(file), ['layout']);
    fs.writeFileSync(file, JSON.stringify({face:2, unrelated:true}));
    store.writeHidden(file, ['clock2','calendar']);
    assert.equal(store.readMode(file), 'clock2');
    assert.equal(JSON.parse(fs.readFileSync(file)).unrelated, true);
    store.writeMode(file, 'upcoming');
    assert.deepEqual(store.readHidden(file), ['clock2','calendar']);
    store.writeHidden(file, []); assert.deepEqual(store.readHidden(file), []);
    assert.throws(() => store.writeHidden(file, ['dashboard']));
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});

test('new clock default never overwrites explicit preference or hidden-state persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-default-'));
  const file = path.join(dir, 'face.json');
  try {
    assert.equal(store.readMode(file), 'clock2');
    assert.equal(fs.existsSync(file), false);
    store.writeHidden(file, ['calendar']);
    assert.equal(store.readMode(file), 'clock2');
    store.writeMode(file, 'clock1');
    const saved = fs.readFileSync(file, 'utf8');
    assert.equal(store.readMode(file), 'clock1');
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    assert.deepEqual(store.readHidden(file), ['calendar']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fresh Layout default preserves explicit visible, hidden and legacy face preferences', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-layout-default-')), file = path.join(dir, 'face.json');
  try {
    assert.deepEqual(store.readHidden(file), ['layout']);
    assert.equal(fs.existsSync(file), false);
    store.writeMode(file, 'clock1');
    assert.deepEqual(store.readHidden(file), ['layout']);
    for (const data of [{ face: 1 }, { mode: 'layout' }, { face: 2, hidden: [] }, { face: 2, hidden: ['calendar'] }]) {
      fs.writeFileSync(file, JSON.stringify(data));
      const before = fs.readFileSync(file, 'utf8');
      assert.deepEqual(store.readHidden(file), data.hidden || []);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
