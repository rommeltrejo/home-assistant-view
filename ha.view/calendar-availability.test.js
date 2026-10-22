'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { CalendarAvailability } = require('./calendar-availability');
const { DaySchedule, DEFAULT } = require('./day-schedule');
const data = require('./calendar-data');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const valid = { status: 'ok', calendars: [{ entity_id: 'calendar.family', name: 'Family' }], events: [] };
test('absent integration and empty catalog block both faces, with exact rejection toast', async () => {
  for (const result of [{ status: 'setup-needed' }, { status: 'ok', calendars: [] }]) {
    const policy = new CalendarAvailability({ contents: () => null, probe: async () => result });
    await policy.refresh();
    assert.deepEqual(policy.hidden([]), ['calendar', 'upcoming']);
    assert.equal(policy.blocked('calendar'), true); assert.equal(policy.blocked('upcoming'), true);
    assert.equal(policy.toast(), 'No calendar to show');
  }
});
test('readable entity with zero events is available; recovery preserves manual hidden choices', async () => {
  let result = { status: 'ok', calendars: [] };
  const manual = ['clock2', 'calendar'];
  const policy = new CalendarAvailability({ contents: () => null, probe: async () => result });
  await policy.refresh(); assert.deepEqual(policy.hidden(manual), ['clock2','calendar','upcoming']);
  result = valid; await policy.refresh();
  assert.equal(policy.blocked('upcoming'), false); assert.equal(policy.blocked('calendar'), false);
  assert.deepEqual(policy.hidden(manual), manual); assert.deepEqual(manual, ['clock2','calendar']);
});
test('transient failures and malformed catalog never confirm absence or alter preferences', async () => {
  for (const result of [{ status:'disconnected' }, { status:'timeout' }, { status:'permission-error' }, { status:'error' }, { status:'ok' }]) {
    const policy = new CalendarAvailability({ contents: () => null, probe: async () => result });
    const manual = ['clock1']; await policy.refresh();
    assert.equal(policy.status, 'unverified'); assert.notEqual(policy.toast(), 'No calendar to show');
    assert.deepEqual(manual, ['clock1']);
  }
});
test('close, navigation, replaced contents, reinit and superseded reads reject stale results', async () => {
  for (const kind of ['close','navigation','contents','reinit','new-read']) {
    let url = 'one', wc = { getURL: () => url }, current = wc;
    const pending = deferred(); let call = 0;
    const policy = new CalendarAvailability({ contents: () => current, probe: () => ++call === 1 ? pending.promise : Promise.resolve({ status:'ok', calendars:[] }) });
    const read = policy.refresh();
    if (kind === 'navigation') url = 'two';
    else if (kind === 'contents') current = {};
    else if (kind === 'new-read') await policy.refresh();
    else policy.invalidate();
    pending.resolve(valid); assert.equal(await read, false); assert.notEqual(policy.status, 'available');
  }
});
test('calendar-only rotation startup recovers even when loading policy presents dashboard', async () => {
  let policy, presentations = [];
  const schedule = new DaySchedule({ config: { ...DEFAULT, enabled:true, strategy:'rotation', rotationFaces:['calendar','upcoming'] }, changed: mode => { presentations.push(mode); } });
  policy = new CalendarAvailability({ contents: () => null, probe: async () => valid, changed: () => schedule.setHidden(policy.hidden([])) });
  await policy.refresh();
  assert.ok(presentations.includes('dashboard')); assert.deepEqual(schedule.rotationFaces(), ['calendar','upcoming']);
  assert.equal(schedule.mode(), 'calendar'); schedule.stop();
});
test('bounded existing catalog bridge rejects malformed successful responses', async () => {
  assert.equal((await data.listCalendars({ executeJavaScript: async () => ({status:'ok'}) })).status, 'error');
  const result = await data.listCalendars({ executeJavaScript: () => new Promise(() => {}) }, [fn => setTimeout(fn, 1), clearTimeout]);
  assert.equal(result.status, 'timeout');
});
test('explicit missing selection blocks both faces; empty means all and recovery preserves saved IDs/hidden', async () => {
  let selected = ['calendar.missing'];
  const hidden = ['calendar', 'clock2'];
  const policy = new CalendarAvailability({ contents: () => null, selection: () => selected, probe: async () => valid });
  await policy.refresh();
  assert.equal(policy.blocked('calendar'), true);
  assert.equal(policy.blocked('upcoming'), true);
  assert.deepEqual(selected, ['calendar.missing']);
  selected = []; await policy.refresh(); assert.equal(policy.status, 'available');
  selected = ['calendar.missing', 'calendar.family']; await policy.refresh();
  assert.equal(policy.status, 'available'); assert.deepEqual(policy.hidden(hidden), hidden);
  assert.deepEqual(selected, ['calendar.missing', 'calendar.family']);
});
test('a reply for an old selection cannot enable either calendar face', async () => {
  let selected = ['calendar.family']; const pending = deferred();
  const policy = new CalendarAvailability({ contents: () => null, selection: () => selected, probe: () => pending.promise });
  const read = policy.refresh(); selected = ['calendar.missing']; pending.resolve(valid);
  assert.equal(await read, false); assert.equal(policy.blocked('calendar'), true);
  assert.equal(policy.status, 'loading');
  await policy.refresh(); assert.equal(policy.status, 'absent');
  selected = ['calendar.family']; await policy.refresh();
  assert.equal(policy.status, 'available'); assert.equal(policy.blocked('upcoming'), false);
});
