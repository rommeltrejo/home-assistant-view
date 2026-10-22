'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./day-schedule-renderer.js'), 'utf8');
const productionFaces = require('./face-modes').FACES.map(({ id, label }) => ({ id, label }));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.textContent = ''; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute(name, value) { this[name] = value; }
  checkValidity() { return this.valid !== false; }
  focus() { this.focused = true; }
  querySelectorAll(selector) {
    const nodes = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
    return nodes.filter(node => selector === 'input:checked' ? node.tag === 'input' && node.checked : node.tag === selector);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  get previousElementSibling() { return this.parent.children[this.parent.children.indexOf(this) - 1]; }
  get nextElementSibling() { return this.parent.children[this.parent.children.indexOf(this) + 1]; }
  insertBefore(node, other) { node.remove(); node.parent = this; this.children.splice(this.children.indexOf(other), 0, node); }
}
function fixture(response, get = () => Promise.resolve(response), calendars = () => Promise.resolve({ status: 'disconnected', calendars: [] })) {
  const elements = new Map(), saves = [], closes = [];
  const document = { querySelector(id) { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); }, createElement: tag => new Element(tag), createTextNode(text) { const node = new Element('text'); node.textContent = text; return node; } };
  vm.runInNewContext(source, { document, window: { daySchedule: { get, calendars, save: async value => saves.push(value), close: async () => { closes.push(true); } } } });
  return { elements, saves, closes, node: id => document.querySelector(id) };
}
const response = faces => ({ config: { ...require('./day-schedule').DEFAULT, rules: [{ time: '09:00', mode: 'layout' }], calendarEntities: ['calendar.saved'] }, idleOverrideMs: null, error: null, faces });
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('production descriptor fixture preserves five daily labels, rotation order and saved config', async () => {
  const f = fixture(response(productionFaces)); await settle();
  const select = f.node('#rules').children[0].querySelector('select');
  assert.deepEqual(select.children.map(option => [option.value, option.textContent]), [['dashboard', 'Dashboard'], ...productionFaces.map(face => [face.id, face.label])]);
  assert.deepEqual(f.node('#rotation-faces').querySelectorAll('input').map(input => input.value), productionFaces.map(face => face.id));
  assert.equal(select.value, 'layout');
  await f.node('#save').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.saves[0])), response(productionFaces).config);
  assert.match(f.node('#calendar-status').textContent, /Connect to Home Assistant/);
  assert.equal(f.node('#calendar-entities').querySelector('input').value, 'calendar.saved');
});
test('independent extra descriptor supplies labels and order without renderer registration or hardcoding', async () => {
  const extra = { id: 'independent-fixture', label: 'Independent fixture label' };
  const faces = [extra, ...productionFaces];
  const data = response(faces); data.config.rotationFaces = ['layout', extra.id]; data.config.rules[0].mode = extra.id;
  const f = fixture(data); await settle();
  const select = f.node('#rules').children[0].querySelector('select');
  assert.equal(select.children[1].textContent, extra.label); assert.equal(select.value, extra.id);
  const rotation = f.node('#rotation-faces');
  assert.deepEqual(rotation.querySelectorAll('input').map(input => input.value), ['layout', extra.id, ...productionFaces.filter(face => face.id !== 'layout').map(face => face.id)]);
  assert.equal(rotation.children[1].children[1]['aria-label'], `Move ${extra.label} up`);
  rotation.children[1].children[1].onclick(); await f.node('#save').onclick();
  assert.deepEqual(Array.from(f.saves[0].rotationFaces), [extra.id, 'layout']);
  assert.equal(f.saves[0].rules[0].mode, extra.id);
  assert.ok(!source.includes(extra.label));
});
for (const faces of [undefined, [], [{ id: 'dashboard', label: 'Bad' }], [{ id: 'extra', label: ' ' }], [...productionFaces, productionFaces[0]], [{ ...productionFaces[0], file: 'clock.html' }]]) {
  test(`invalid descriptor fixture blocks save: ${JSON.stringify(faces)}`, async () => {
    const f = fixture(response(faces)); await settle();
    assert.equal(f.node('#save').disabled, true); assert.equal(f.node('#add').disabled, true);
    assert.match(f.node('#status').textContent, /Not loaded:/);
    await f.node('#save').onclick(); assert.equal(f.saves.length, 0);
  });
}
test('pending/rejected get and mismatched configured faces cannot silently save', async () => {
  for (const data of [null, response(productionFaces)]) {
    if (data) data.config.rotationFaces = ['unknown'];
    const f = fixture(data, data ? undefined : () => Promise.reject(new Error('get failed')));
    await f.node('#save').onclick(); assert.equal(f.saves.length, 0);
    await settle(); assert.equal(f.node('#save').disabled, true);
    await f.node('#save').onclick(); assert.equal(f.saves.length, 0);
  }
  const data = response(productionFaces); data.config.rules[0].mode = 'unknown';
  const f = fixture(data); await settle(); await f.node('#save').onclick(); assert.equal(f.saves.length, 0);
});
test('calendar backend error preserves selections and still permits a valid save', async () => {
  const f = fixture(response(productionFaces), undefined, () => Promise.reject(new Error('offline'))); await settle();
  assert.match(f.node('#calendar-status').textContent, /Saved selections are preserved/);
  await f.node('#save').onclick(); assert.deepEqual(Array.from(f.saves[0].calendarEntities), ['calendar.saved']);
});

test('header Close is clean after initialization/discovery and normalized equivalent edits', async () => {
  const f = fixture(response(productionFaces)); await settle();
  f.node('#idle-minutes').value = '02.00';
  await f.node('#dismiss').onclick(); assert.equal(f.closes.length, 1);
});
test('every persisted edit needs explicit discard; reverting edits is clean', async () => {
  const edits = [
    f => { f.node('#idle-minutes').value = '4'; },
    f => { f.node('#rotation-minutes').value = '7'; },
    f => { f.node('#enabled').checked = !f.node('#enabled').checked; },
    f => { f.node('#strategy').value = f.node('#strategy').value === 'rotation' ? 'daily' : 'rotation'; },
    f => { f.node('#rules').children[0].querySelector('input').value = '10:00'; },
    f => { f.node('#rules').children[0].querySelector('select').value = 'dashboard'; },
    f => f.node('#add').onclick(),
    f => f.node('#rules').children[0].children[2].onclick(),
    f => f.node('#rotation-faces').children[1].children[1].onclick(),
    f => { const input = f.node('#rotation-faces').querySelector('input'); input.checked = false; },
    f => { const input = f.node('#calendar-entities').querySelector('input'); input.checked = false; input.onchange(); }
  ];
  for (const edit of edits) {
    const f = fixture(response(productionFaces)); await settle(); edit(f);
    f.node('#dismiss').onclick(); assert.equal(f.closes.length,0); assert.equal(f.node('#discard-confirmation').hidden,false);
    f.node('#stay').onclick(); assert.equal(f.node('#discard-confirmation').hidden,true); assert.equal(f.saves.length,0);
    await f.node('#discard').onclick(); assert.equal(f.closes.length,1); assert.equal(f.saves.length,0);
  }
  const f = fixture(response(productionFaces)); await settle();
  f.node('#add').onclick(); f.node('#rules').children.at(-1).children[2].onclick();
  await f.node('#dismiss').onclick(); assert.equal(f.closes.length,1);
});
test('successful Save stays open and resets dirty baseline; failed validation does not', async () => {
  const f = fixture(response(productionFaces)); await settle();
  f.node('#idle-minutes').value = '4'; await f.node('#save').onclick();
  assert.equal(f.closes.length,0); assert.match(f.node('#status').textContent,/Saved/);
  await f.node('#dismiss').onclick(); assert.equal(f.closes.length,1);
  f.node('#idle-minutes').value = '5'; f.node('#idle-minutes').valid = false;
  await f.node('#save').onclick(); assert.equal(f.saves.length,1);
  f.node('#dismiss').onclick(); assert.equal(f.closes.length,1); assert.equal(f.node('#discard-confirmation').hidden,false);
  await f.node('#close').onclick(); assert.equal(f.closes.length,2); assert.equal(f.saves.length,1);
});
