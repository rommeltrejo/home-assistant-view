'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chooserDescriptors, createRegistry, presentationFaces } = require('./face-registry');
const { FACES } = require('./face-modes');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.textContent = ''; }
  append(node) { this.children.push(node); }
  replaceChildren() { this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
}
function fixture() {
  const elements = Object.fromEntries(['track', 'label', 'dots', 'hide', 'toast'].map(id => [id, new Element(id)]));
  const created = [], window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('./face-changer-renderer.js'), 'utf8'), {
    window, document: { getElementById: id => elements[id], createElement: tag => { const node = new Element(tag); created.push(node); return node; } },
    setTimeout, clearTimeout,
  });
  return { window, elements, created };
}
test('production snapshot preserves exact accepted preview paths, titles and order', () => {
  const f = fixture();
  assert.equal(f.window.initializeChooser(chooserDescriptors(presentationFaces(FACES))), true);
  assert.deepEqual(f.elements.track.children.map(article => article.children[0].attributes), [
    { src: 'faces/clock-2.html', title: 'Clock 1 preview', tabindex: '-1' },
    { src: 'faces/weather-preview.html', title: 'Weather preview', tabindex: '-1' },
    { src: 'faces/clock.html', title: 'Clock 2 preview', tabindex: '-1' },
    { src: 'faces/calendar-preview.html', title: 'Calendar preview', tabindex: '-1' },
    { src: 'faces/upcoming-preview.html', title: 'Upcoming Events preview', tabindex: '-1' },
    { src: 'faces/layout.html', title: 'Layout preview', tabindex: '-1' },
  ]);
  assert.deepEqual(f.elements.track.children.map(card => card.getAttribute('data-id')), ['clock2', 'weather', 'clock1', 'calendar', 'upcoming', 'layout']);
  assert.equal(f.elements.dots.textContent, '● ○ ○ ○ ○ ○');
  const updates = [], layout = f.elements.track.children[5].children[0];
  layout.contentWindow = { layoutFace: { update: data => updates.push(data) } };
  f.window.setLayoutPreview({ mode: 'split' }); layout.onload();
  assert.equal(updates.length, 2);
  assert.equal(updates[0].data.calendar.message, 'Live calendar data on face');
});
test('independently authored sixth descriptor drives labels, hide state and dots without five-count assumptions', () => {
  const registry = createRegistry(FACES.map((face, i) => ({ ...face, index: i + 1 })), [
    { id: 'fixture-extra', label: '<Extra & independent>', file: 'fixture-extra.html' },
  ]);
  const f = fixture(), descriptors = JSON.parse(JSON.stringify(chooserDescriptors(registry.FACES)));
  f.window.initializeChooser(descriptors);
  descriptors[6] = { id: 'wrong', label: 'wrong', previewFile: 'wrong.html' };
  f.window.setHiddenFaces(['fixture-extra']); f.window.previewFace(7);
  assert.equal(f.elements.track.children.length, 7);
  assert.equal(f.elements.label.textContent, '<Extra & independent>');
  assert.equal(f.elements.hide.getAttribute('aria-label'), 'Unhide <Extra & independent>');
  assert.equal(f.elements.hide.getAttribute('aria-pressed'), 'true');
  assert.equal(f.elements.dots.textContent, '○ ○ ○ ○ ○ ○ ●');
  assert.equal(f.elements.track.style.transform, 'translateX(-600%)');
  f.window.setHiddenFaces([]);
  assert.equal(f.elements.hide.title, 'Hide <Extra & independent>');
  for (const index of [0, 8, NaN, 1.5, '2']) f.window.previewFace(index);
  assert.equal(f.elements.label.textContent, '<Extra & independent>');
});
test('malformed snapshots fail closed before any iframe creation, including unsafe paths', () => {
  const valid = { id: 'fixture', label: 'Fixture', previewFile: 'fixture.html' };
  const bad = [null, [], {}, [null], [{ ...valid, label: '' }], [{ ...valid, id: 'bad/id' }],
    [valid, valid], [{ ...valid, unexpected: true }],
    ...['../clock.html', '/clock.html', 'https://example.com/a.html', 'javascript:alert(1)',
      'file:///a.html', 'a.html?x', 'a.html#x', 'a\\b.html', 'a%2fb.html', 'a.html" onload="x'].map(previewFile => [valid, { ...valid, id: 'other', previewFile }])];
  for (const payload of bad) {
    const f = fixture();
    assert.equal(f.window.initializeChooser(payload), false);
    assert.equal(f.created.length, 0);
    assert.equal(f.elements.track.children.length, 0);
    f.window.previewFace(1); f.window.setLayoutPreview({});
    assert.equal(f.elements.label.textContent, '');
  }
  const f = fixture(); f.window.initializeChooser([valid]);
  assert.equal(f.window.initializeChooser(null), false);
  assert.equal(f.elements.track.children.length, 0);
  for (const file of ['../a.html', 'https://example.com/a.html']) assert.throws(() => chooserDescriptors([{ ...valid, file }]), TypeError);
});
test('production hooks initialize before hidden/index/layout and retain gesture guards; assets included', () => {
  const hooks = fs.readFileSync(require.resolve('./hooks'), 'utf8');
  assert.match(hooks, /initializeChooser\(\$\{JSON.stringify\(chooserDescriptors\(chooserFaces\)\)\}\).*window.setHiddenFaces.*window.previewFace.*window.setLayoutPreview/);
  assert.match(hooks, /if \(changer.picking && !pickerRects\)/);
  const html = fs.readFileSync(require.resolve('./face-changer.html'), 'utf8');
  assert.ok(!html.includes('<iframe'));
  assert.ok(html.includes('src="face-changer-renderer.js"'));
  const { assets } = require('./build/files');
  for (const file of ['face-changer-renderer.js', 'faces/calendar-preview.html', 'faces/upcoming-preview.html']) assert.ok(assets.has(`ha.view/${file}`));
});

for (const hole of ['all', 'leading', 'middle', 'trailing', 'inherited']) {
  test(`sparse ${hole} chooser snapshots reject before any element or URL creation`, () => {
    const raw = { id: 'fixture', label: 'Fixture', file: 'fixture.html' };
    const preview = { id: 'fixture', label: 'Fixture', previewFile: 'fixture.html' };
    const sparse = face => {
      const array = hole === 'all' ? new Array(2) : hole === 'leading' ? [, face] :
        hole === 'middle' ? [face, , { ...face, id: 'other' }] : [face, ,];
      if (hole === 'inherited') Object.setPrototypeOf(array, Object.assign(Object.create(Array.prototype), { 1: { ...face, id: 'other' } }));
      return array;
    };
    assert.throws(() => chooserDescriptors(sparse(raw)), TypeError);
    const f = fixture();
    assert.equal(f.window.initializeChooser(sparse(preview)), false);
    assert.equal(f.created.length, 0);
    assert.equal(f.elements.track.children.length, 0);
    f.window.previewFace(1);
    assert.equal(f.elements.label.textContent, '');
    assert.equal(f.window.initializeChooser(chooserDescriptors(FACES)), true);
    const created = f.created.length;
    assert.equal(f.window.initializeChooser(sparse(preview)), false);
    assert.equal(f.created.length, created, 'rejection creates no further elements or URL assignments');
    assert.equal(f.elements.track.children.length, 0);
  });
}

test('hidden presentation updates every card without removing previews or changing the current index', () => {
  const f = fixture();
  f.window.initializeChooser(chooserDescriptors(FACES));
  const cards = [...f.elements.track.children];
  const hiddenState = () => cards.map(card => card.getAttribute('data-hidden'));
  assert.deepEqual(hiddenState(), FACES.map(() => 'false'));
  f.window.previewFace(2);
  f.window.setHiddenFaces([FACES[0].id, FACES[2].id, 'unknown']);
  assert.deepEqual(hiddenState(), ['true', 'false', 'true', 'false', 'false', 'false']);
  assert.equal(f.elements.track.style.transform, 'translateX(-100%)');
  assert.equal(f.elements.hide.getAttribute('aria-label'), `Hide ${FACES[1].label}`);
  f.window.previewFace(3);
  assert.equal(f.elements.hide.getAttribute('aria-pressed'), 'true');
  assert.equal(f.elements.hide.title, `Unhide ${FACES[2].label}`);
  f.window.setHiddenFaces([FACES[0].id]);
  assert.equal(cards[2].getAttribute('data-hidden'), 'false');
  assert.equal(f.elements.hide.getAttribute('aria-label'), `Hide ${FACES[2].label}`);
  assert.equal(f.elements.track.style.transform, 'translateX(-200%)');
  assert.deepEqual(f.elements.track.children, cards, 'hidden previews remain in the swipe track');
  f.window.setHiddenFaces(null);
  assert.deepEqual(hiddenState(), FACES.map(() => 'false'));
  f.window.initializeChooser(chooserDescriptors(FACES));
  assert.ok(f.elements.track.children.every(card => card.getAttribute('data-hidden') === 'false'));
});

test('single native-intercepted eye overlay is anchored inside preview, outside the sliding track', () => {
  const html = fs.readFileSync(require.resolve('./face-changer.html'), 'utf8');
  assert.equal((html.match(/id="hide"/g) || []).length, 1);
  assert.ok(!html.match(/<header>[\s\S]*?<\/header>/)[0].includes('id="hide"'));
  assert.match(html, /<div id="preview"><div id="track"><\/div><button id="hide"/);
  assert.match(html, /#preview\{min-height:0;position:relative\}/);
  assert.match(html, /#track\{height:100%;/);
  assert.match(html, /#hide\{position:absolute;top:12px;right:calc\(10% \+ 12px\);width:44px;height:44px;[^}]*pointer-events:none/);
  assert.match(html, /article\{[^}]*padding:0 10%;/);
  assert.match(html, /#hide\[aria-pressed="false"\] \.slash\{display:none\}/);
  assert.ok(!html.includes('#hide[aria-pressed="true"] .slash{display:none}'));
  assert.match(html, /article\[data-hidden="true"\] iframe\{filter:grayscale\(1\);opacity:\.45;/);
  assert.match(html, /button\{[^}]*pointer-events:none/);
});
