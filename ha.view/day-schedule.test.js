'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DEFAULT, validate, read, write, period, DaySchedule } = require('./day-schedule');
const config = { idleMs: 120000, enabled: true, rules: [{ time: '06:00', mode: 'dashboard' }, { time: '18:00', mode: 'clock2' }, { time: '23:00', mode: 'clock1' }] };
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m);
test('local boundaries, midnight and restart use preceding civil-day rule', () => {
  assert.equal(period(config, at(14, 5, 59)).mode, 'clock1');
  assert.equal(period(config, at(14, 6)).mode, 'dashboard');
  assert.equal(period(config, at(14, 18)).mode, 'clock2');
  assert.equal(period(config, at(15, 0)).mode, 'clock1');
  assert.equal(period(config, at(15, 0)).at, at(14, 23).getTime());
  assert.equal(new DaySchedule({ config, now: () => at(15, 0) }).mode(), 'clock1');
});
test('reject invalid entries, duplicates, enabled empty and normalize ordering', () => {
  for (const rules of [[{ time: '24:00', mode: 'clock1' }], [{ time: '9:00', mode: 'clock1' }], [{ time: '09:00', mode: 'photos' }], [{ time: '09:00', mode: 'dashboard' }, { time: '09:00', mode: 'clock1' }], []]) assert.throws(() => validate({ enabled: true, rules }));
  assert.equal(validate({ enabled: true, rules: [...config.rules].reverse() }).rules[0].time, '06:00');
});
test('manual choice expires at boundary including rollover; wall-clock resume reconciles', () => {
  let date = at(14, 18); const s = new DaySchedule({ config, now: () => date });
  s.choose(1); assert.equal(s.mode(), 'clock1');
  date = at(15, 6); assert.equal(s.mode(), 'dashboard');
  s.choose(2); date = at(16, 6); assert.equal(s.mode(), 'dashboard');
});
test('bounded wakeups, disabled no timer and stop cancels', () => {
  let delay, callback, clears = 0, changes = 0, date = at(14, 17, 59);
  const s = new DaySchedule({ config, now: () => date, setTimer: (fn, ms) => { callback = fn; delay = ms; return 42; }, clearTimer: () => clears++, changed: () => changes++ });
  s.refresh(); assert.equal(delay, 60000); date = at(15, 0); callback(); assert.equal(s.mode(), 'clock1'); assert.equal(clears, 1);
  s.update({ enabled: false, rules: [] }); assert.equal(s.timer, null); assert.equal(s.mode(), null); assert.equal(changes, 3);
});
test('atomic persistence contains only normalized config; invalid read fails disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-day-test-')), file = path.join(dir, 'config.json');
  try {
    assert.equal(read(file).config.enabled, true); write(file, { ...config, secret: 'discard' }); assert.deepEqual(read(file).config, { ...DEFAULT, ...config, strategy: 'daily', calendarEntities: [] });
    assert.throws(() => write(file, { enabled: true, rules: [] })); assert.deepEqual(read(file).config, { ...DEFAULT, ...config, strategy: 'daily', calendarEntities: [] });
    fs.writeFileSync(file, '{bad'); assert.equal(read(file).config.enabled, false); assert.ok(read(file).error);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('deferred period retries until accepted, then unchanged ticks do not reload', () => {
  let callback, calls = 0, blocked = true;
  const s = new DaySchedule({ config, now: () => at(14, 18), setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {}, changed: () => { calls++; return !blocked; } });
  s.refresh(); callback(); assert.equal(calls, 2);
  blocked = false; callback(); callback(); assert.equal(calls, 3);
  s.stop();
});
test('same-mode next boundary still expires a manual choice', () => {
  let date = at(14, 8);
  const s = new DaySchedule({ config: { enabled: true, rules: [{ time: '00:00', mode: 'dashboard' }, { time: '09:00', mode: 'dashboard' }] }, now: () => date });
  s.choose(2); assert.equal(s.mode(), 'clock2'); date = at(14, 9); assert.equal(s.mode(), 'dashboard');
});

test('legacy schedules default to two minutes; validated duration persists and invalid writes preserve entire file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-idle-')), file = path.join(dir, 'settings.json');
  try {
    const legacy = { enabled: true, rules: config.rules };
    fs.writeFileSync(file, JSON.stringify(legacy));
    assert.equal(read(file).config.idleMs, 120000);
    write(file, { ...legacy, idleMs: 6000 });
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(new DaySchedule({ config: read(file).config }).config.idleMs, 6000);
    for (const idleMs of [null, '6000', NaN, Infinity, 0, 5999, 86400001]) {
      assert.throws(() => write(file, { ...legacy, idleMs }));
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    assert.equal(validate({ ...legacy, idleMs: 86400000 }).idleMs, 86400000);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

function rotationHarness(faces = ['clock1', 'clock2', 'calendar', 'upcoming']) {
  let callback, delay, changes = [], blocked = false;
  const schedule = new DaySchedule({ config: { enabled: true, strategy: 'rotation', rules: config.rules, rotationFaces: faces },
    setTimer: (fn, ms) => { callback = fn; delay = ms; return 1; }, clearTimer: () => { callback = null; },
    changed: mode => { changes.push(mode); return !blocked; } });
  return { schedule, tick: () => { assert.ok(callback); callback(); }, delay: () => delay, changes,
    blocked: value => { blocked = value; } };
}
test('rotation defaults, validation, legacy migration and strategy round trip retain daily rules', () => {
  assert.equal(validate(config).strategy, 'daily');
  assert.equal(validate(config).rotationMs, 300000);
  assert.deepEqual(validate(config).rotationFaces, ['clock1', 'clock2', 'calendar', 'upcoming', 'layout']);
  for (const patch of [{ strategy: 'bad' }, { rotationFaces: [] }, { rotationFaces: ['dashboard'] }, { rotationFaces: ['clock1', 'clock1'] }, { rotationMs: 5999 }, { rotationMs: Infinity }]) assert.throws(() => validate({ ...config, ...patch }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-rotation-')), file = path.join(dir, 'config.json');
  try {
    write(file, { ...config, strategy: 'rotation', rotationFaces: ['upcoming', 'clock2'], rotationMs: 6000 });
    const saved = read(file).config;
    assert.deepEqual(new DaySchedule({ config: saved }).config, saved);
    assert.deepEqual(write(file, { ...saved, strategy: 'daily' }).rules, config.rules);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('rotation advances one ordered face per full interval only while active, no catch-up', () => {
  const h = rotationHarness(); h.schedule.refresh(); assert.equal(h.schedule.timer, null);
  h.schedule.setActive(true); assert.equal(h.delay(), 300000); assert.equal(h.schedule.mode(), 'clock1');
  h.tick(); assert.equal(h.schedule.mode(), 'clock2'); h.tick(); assert.equal(h.schedule.mode(), 'calendar');
  h.schedule.setActive(false); assert.equal(h.schedule.timer, null);
  h.schedule.setActive(true); assert.equal(h.delay(), 300000); assert.equal(h.schedule.mode(), 'calendar');
  h.tick(); assert.equal(h.schedule.mode(), 'upcoming'); h.tick(); assert.equal(h.schedule.mode(), 'clock1');
  h.schedule.stop();
});
test('manual selection lasts to next interval and excluded selection returns to ordered sequence; inhibited change does not advance', () => {
  const h = rotationHarness(['clock1', 'clock2']); h.schedule.setActive(true);
  h.schedule.choose('clock2'); assert.equal(h.schedule.mode(), 'clock2'); h.tick(); assert.equal(h.schedule.mode(), 'clock1');
  h.schedule.choose('upcoming'); h.blocked(true); h.tick(); assert.equal(h.schedule.mode(), 'upcoming');
  h.blocked(false); h.tick(); assert.equal(h.schedule.mode(), 'clock2');
  h.schedule.update({ ...h.schedule.config, enabled: false }); assert.equal(h.schedule.timer, null); assert.equal(h.schedule.mode(), null);
});

test('live rotation update requests presentation immediately and restarts interval safely', () => {
  let callback = null, changes = [];
  let s;
  s = new DaySchedule({ config, setTimer: fn => { callback = fn; return 1; }, clearTimer: () => { callback = null; }, changed: mode => { changes.push(mode); s.setActive(false); return true; } });
  s.setActive(true);
  s.update({ ...config, strategy: 'rotation', rotationFaces: ['calendar', 'clock2'] });
  assert.deepEqual(changes, ['calendar']); assert.equal(callback, null, 'waits for renderer to become visible');
  s.setActive(true); assert.ok(callback); s.stop();
});
test('hidden rotation filtering retains configured order and interval, all hidden has no timer, unhide resumes', () => {
  const h = rotationHarness(['clock2','clock1']); const s = h.schedule;
  s.setHidden(['clock2']); s.setActive(true); assert.equal(s.mode(), 'clock1');
  assert.deepEqual(s.config.rotationFaces, ['clock2','clock1']); const interval=s.config.rotationMs;
  h.tick(); assert.equal(s.mode(), 'clock1');
  s.setHidden(['clock1','clock2']); assert.equal(s.mode(), 'dashboard'); assert.equal(s.timer,null);
  s.choose('clock2'); assert.equal(s.mode(),'dashboard');
  s.setHidden(['clock1']); assert.equal(s.mode(),'clock2'); assert.notEqual(s.timer,null);
  assert.equal(s.config.rotationMs,interval); s.stop();
});
test('hidden daily faces still schedule and current daily choice is not cleared by hiding', () => {
  const s = new DaySchedule({config, now:()=>at(14,18), hidden:['clock2']});
  assert.equal(s.mode(),'clock2'); s.choose('clock1'); s.setHidden(['clock1','clock2']);
  assert.equal(s.mode(),'clock1'); s.stop();
});

test('fresh rotation runs every five minutes while saved explicit preferences remain unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-fresh-rotation-')), file = path.join(dir, 'settings.json');
  try {
    const fresh = read(file);
    assert.equal(fresh.error, null);
    assert.equal(fresh.config.enabled, true);
    assert.equal(fresh.config.strategy, 'rotation');
    assert.equal(fresh.config.rotationMs, 300000);
    assert.equal(fs.existsSync(file), false);
    let delay;
    const schedule = new DaySchedule({ config: fresh.config, hidden: ['layout'], setTimer: (_, ms) => { delay = ms; return 1; }, clearTimer: () => {} });
    schedule.setActive(true);
    assert.equal(delay, 300000);
    assert.equal(schedule.rotationFaces().includes('layout'), false);
    schedule.stop();
    for (const saved of [{ enabled: false, rules: [] }, config, { enabled: true, strategy: 'rotation', rules: [], rotationMs: 6000, rotationFaces: ['layout', 'clock1'] }]) {
      fs.writeFileSync(file, JSON.stringify(saved));
      const before = fs.readFileSync(file, 'utf8');
      assert.equal(read(file).config.enabled, saved.enabled);
      assert.equal(read(file).config.strategy, saved.strategy || 'daily');
      assert.equal(read(file).config.rotationMs, saved.rotationMs || 300000);
      if (saved.rotationFaces) assert.deepEqual(read(file).config.rotationFaces, saved.rotationFaces);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
