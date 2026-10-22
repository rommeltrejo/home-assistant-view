'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm');
const { observeGestures } = require('./browser');
function observer() {
  let now = 0; const events = new Map(), reports = [];
  class Element { matches() { return !!this.editable; } }
  const target = new Element();
  const context = { Element, performance: { now: () => now }, console: { debug: value => reports.push(value) }, getComputedStyle: () => ({ overflowX: 'auto' }), document: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name) } };
  vm.runInNewContext(`(${observeGestures.toString()})('secret')`, context);
  const emit = (name, event) => events.get(name)({ target, ...event });
  return { target, reports, emit, advance: ms => now += ms, cleanup: () => context.__haViewGestureCleanup(), events };
}
test('touch direction, thresholds, diagonal/multitouch/cancel/editable rejection and cleanup', () => {
  const f = observer();
  const swipe = (x, y = 0) => { f.emit('touchstart', { touches: [{ clientX: 200, clientY: 100 }] }); f.emit('touchend', { touches: [], changedTouches: [{ clientX: 200 + x, clientY: 100 + y }] }); };
  swipe(120); swipe(-120); assert.deepEqual(f.reports, ['secret:back', 'secret:forward']);
  swipe(99); swipe(120, 30); f.target.editable = true; swipe(120); f.target.editable = false;
  f.emit('touchstart', { touches: [{ clientX: 0, clientY: 0 }] }); f.emit('touchcancel', {}); f.emit('touchend', { touches: [], changedTouches: [{ clientX: 120, clientY: 0 }] });
  assert.equal(f.reports.length, 2); f.cleanup(); assert.equal(f.events.size, 0);
});
test('wheel pure horizontal burst only, one report per burst, ordinary scroll and scrollable targets ignored', () => {
  const f = observer(); const wheel = (deltaX, deltaY = 0, extra = {}) => f.emit('wheel', { deltaX, deltaY, deltaMode: 0, ...extra });
  wheel(-80); wheel(-80); wheel(-200); assert.deepEqual(f.reports, ['secret:back']);
  f.advance(200); wheel(160); assert.equal(f.reports[1], 'secret:forward');
  for (const extra of [{ deltaY: 30 }, { deltaMode: 1 }, { ctrlKey: true }, { shiftKey: true }]) { f.advance(200); wheel(200, 0, extra); }
  f.advance(200); wheel(0, 100); wheel(200); assert.equal(f.reports.length, 2);
  f.target.scrollWidth = 500; f.target.clientWidth = 200; f.advance(200); wheel(200); assert.equal(f.reports.length, 2);
});
test('shell shortcuts are limited to known editable inputs and preserve normal focus/key handling', () => {
  const source = require('node:fs').readFileSync(`${__dirname}/browser-renderer.js`, 'utf8');
  const fragment = source.slice(source.indexOf("  document.addEventListener('keydown'"), source.indexOf("  for (const action"));
  let handler; const calls = []; class HTMLInputElement {}
  vm.runInNewContext(fragment, { HTMLInputElement, document: { addEventListener: (_name, fn) => handler = fn }, command: (...args) => calls.push(args) });
  const target = Object.assign(new HTMLInputElement(), { id: 'address', type: 'text' });
  let prevented = 0;
  const key = (key, extra = {}) => handler({ target, key, ctrlKey: true, preventDefault: () => prevented++, ...extra });
  for (const keyName of ['a', 'c', 'v', 'x', 'z']) key(keyName);
  key('A', { ctrlKey: false, metaKey: true });
  assert.deepEqual(calls.map(call => call[1]), ['selectAll', 'copy', 'paste', 'cut', 'undo', 'selectAll']);
  for (const extra of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { ctrlKey: false }, { target: {} }]) key('a', extra);
  target.disabled = true; key('a'); target.disabled = false; target.readOnly = true; key('v'); target.readOnly = false; target.id = 'unrelated'; key('a');
  key('ArrowLeft'); assert.equal(prevented, 6);
});
