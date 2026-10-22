'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('./face-registry');
const modes = require('./face-modes');
const base = () => modes.FACES.map((face, i) => ({ ...face, index: i + 1 }));
const extra = (id, index) => ({ id, label: id, file: `${id}.html`, ...(index === undefined ? {} : { index }) });
test('default export keys, IDs, definitions and indices remain compatible', () => {
  assert.deepEqual(Object.keys(modes), ['FACES', 'FACE_IDS', 'SCHEDULE_MODES', 'fromLegacyFace', 'indexOf', 'fromIndex', 'definition']);
  assert.deepEqual(modes.FACE_IDS, ['clock1', 'clock2', 'calendar', 'upcoming', 'layout', 'weather']);
  assert.deepEqual(modes.SCHEDULE_MODES, ['dashboard', ...modes.FACE_IDS]);
  modes.FACES.forEach((face, i) => {
    assert.deepEqual(Object.keys(face), ['id', 'label', 'file']);
    assert.equal(modes.indexOf(face.id), i + 1); assert.equal(modes.fromIndex(i + 1), face.id);
    assert.equal(modes.definition(face.id), face);
  });
  assert.deepEqual(modes.FACES.map(f => f.file), ['clock.html', 'clock-2.html', 'calendar.html', 'upcoming-events.html', 'layout.html', 'weather.html']);
});
test('all legacy numeric and fallback/clamping semantics retained', () => {
  for (const value of [undefined, null, false, '', '1', '2', 0, -1, 3, {}, NaN]) {
    assert.equal(modes.fromLegacyFace(value), 'clock2');
    assert.equal(modes.fromLegacyFace(value, 'layout'), 'layout');
    assert.equal(modes.fromLegacyFace(value, 'invalid'), 'clock2');
  }
  assert.equal(modes.fromLegacyFace(1), 'clock1'); assert.equal(modes.fromLegacyFace(2), 'clock2');
  for (const value of [undefined, null, false, '', 0, NaN]) assert.equal(modes.fromIndex(value), 'clock2');
  for (const value of [-2, -Infinity]) assert.equal(modes.fromIndex(value), 'clock1');
  assert.equal(modes.fromIndex('2.9'), 'clock2');
  assert.equal(modes.fromIndex(Infinity), 'weather'); assert.equal(modes.fromIndex(999), 'weather');
  assert.equal(modes.indexOf('unknown'), 2); assert.equal(modes.definition('unknown'), modes.FACES[1]);
});
test('combined future descriptors get deterministic distinct indices independent of input order', () => {
  const descriptors = ['futureweather', 'timer', 'reminders'].map(id => extra(id));
  const first = createRegistry(base(), descriptors), second = createRegistry(base().reverse(), descriptors.toReversed());
  assert.deepEqual(first.FACES, second.FACES);
  assert.deepEqual(first.FACE_IDS, [...modes.FACE_IDS, 'futureweather', 'reminders', 'timer']);
  for (const registry of [first, second]) registry.FACE_IDS.forEach((id, i) => {
    assert.equal(registry.indexOf(id), i + 1); assert.equal(registry.fromIndex(i + 1), id);
  });
  const pinned = createRegistry(base(), [extra('futureweather', 7), extra('timer', 8), extra('reminders')]);
  assert.equal(pinned.indexOf('futureweather'), 7); assert.equal(pinned.indexOf('timer'), 8); assert.equal(pinned.indexOf('reminders'), 9);
  assert.deepEqual(modes.FACE_IDS, ['clock1', 'clock2', 'calendar', 'upcoming', 'layout', 'weather']);
});
test('registry snapshots are immutable and independent of caller mutation', () => {
  const input = base(), extras = [extra('future')], registry = createRegistry(input, extras);
  input[0].id = 'changed'; extras[0].file = 'changed.html'; extras.push(extra('another'));
  assert.equal(registry.FACES[0].id, 'clock1'); assert.equal(registry.definition('future').file, 'future.html');
  for (const object of [registry, registry.FACES, registry.FACE_IDS, registry.SCHEDULE_MODES, ...registry.FACES]) assert.ok(Object.isFrozen(object));
  assert.throws(() => { registry.FACES[0].file = 'other.html'; }, TypeError);
  assert.throws(() => registry.FACE_IDS.push('other'), TypeError);
});
test('duplicates and malformed descriptors reject without altering defaults', () => {
  const invalid = [null, [], 'future', {}, extra('dashboard'), extra('Bad'), extra('../bad'),
    { ...extra('future'), label: '' }, { ...extra('future'), label: 3 },
    ...['../future.html', '/future.html', 'faces/future.html', 'future\\x.html', 'https://x/future.html', 'future.html?x', 'future.js'].map(file => ({ ...extra('future'), file })),
    ...[0, -1, 1.5, '6', NaN, Infinity].map(index => extra('future', index)),
    { ...extra('future'), unknown: true }, extra('clock1'), { ...extra('future'), file: 'clock.html' }, extra('future', 5), extra('future', 9)];
  for (const descriptor of invalid) assert.throws(() => createRegistry(base(), [descriptor]), TypeError);
  assert.throws(() => createRegistry(base(), [extra('future'), extra('future')]), TypeError);
  assert.throws(() => createRegistry(base(), [extra('future', 6), extra('other', 6)]), TypeError);
  assert.throws(() => createRegistry(base(), [extra('future'), { ...extra('other'), file: 'future.html' }]), TypeError);
  for (const input of [null, [], {}, modes.FACES, base().map(f => ({ ...f, index: f.index + 1 }))]) assert.throws(() => createRegistry(input), TypeError);
  assert.throws(() => createRegistry(base(), null), TypeError);
});
test('promoting persisted additions to pinned base prevents incremental renumbering', () => {
  const previous = createRegistry(base(), [extra('timer'), extra('futureweather')]);
  const promoted = previous.FACES.map(face => ({ ...face, index: previous.indexOf(face.id) }));
  const next = createRegistry(promoted, [extra('earlier')]);
  previous.FACE_IDS.forEach(id => assert.equal(next.indexOf(id), previous.indexOf(id)));
  assert.equal(next.indexOf('earlier'), 9);
  // Unpinned composition intentionally guarantees only input-order determinism.
  assert.notEqual(createRegistry(base(), [extra('earlier'), extra('timer'), extra('futureweather')]).indexOf('timer'), previous.indexOf('timer'));
});

test('presentation order preserves legacy indices, descriptors and default schedule order', () => {
  const { presentationFaces } = require('./face-registry');
  const prior = [...modes.FACES];
  const presented = presentationFaces(modes.FACES);
  assert.deepEqual(presented.map(face => face.label), ['Clock 1', 'Weather', 'Clock 2', 'Calendar', 'Upcoming Events', 'Layout']);
  assert.deepEqual(modes.FACES, prior);
  assert.deepEqual(modes.FACE_IDS, ['clock1', 'clock2', 'calendar', 'upcoming', 'layout', 'weather']);
  for (const face of presented) {
    assert.equal(modes.fromIndex(modes.indexOf(face.id)), face.id);
    assert.equal(modes.definition(face.id), face);
  }
  assert.equal(modes.fromLegacyFace(1), 'clock1');
  assert.equal(modes.fromLegacyFace(2), 'clock2');
});
