// HA.View Clock Face 2 regression tests: run the shipped inline script, not a copy.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, 'clock-2.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

function element(tagName, attributes = {}) {
  return {
    tagName,
    attributes,
    children: [],
    textContent: '',
    style: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    append(child) { this.children.push(child); },
    classList: {
      toggle(name, enabled) {
        const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        attributes.class = [...classes].join(' ');
        return enabled;
      },
      contains(name) { return (attributes.class || '').split(/\s+/).includes(name); },
    },
  };
}

function loadFace(hour, minute, second = 0) {
  assert.equal(scripts.length, 1, 'Execute the single actual inline face script');
  assert.doesNotMatch(scripts[0][1], /\bsrc\s*=/i);
  let now = new Date(2026, 9, 14, hour, minute, second).getTime();
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)]
      .map((attribute) => [attribute[1], attribute[2]]));
    elements.set(`#${match[3]}`, element(match[1], attributes));
  }
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = [];
  const document = {
    hidden: false,
    documentElement: { lang: 'en' },
    querySelector(selector) {
      assert.ok(elements.has(selector), `Missing real HTML element ${selector}`);
      return elements.get(selector);
    },
    createElementNS(namespace, tagName) {
      assert.equal(namespace, 'http://www.w3.org/2000/svg');
      return element(tagName);
    },
    addEventListener(name, callback) { documentListeners.set(name, callback); },
  };
  const window = {
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  vm.runInNewContext(scripts[0][2], { document, window, navigator: { language: 'en-US' }, Date: FakeDate, Intl },
    { filename: 'clock-2.html:inline', timeout: 1000 });
  return {
    elements, document, timers,
    ticks: elements.get('#tick-ring').children,
    setTime(h, m, s = 0) { now = new Date(2026, 9, 14, h, m, s).getTime(); },
    nextSecond() {
      assert.equal(timers.length, 1, 'Only one scheduled clock update');
      const timer = timers.shift();
      assert.ok(timer.delay > 0 && timer.delay <= 1015);
      timer.callback();
    },
    visibility(hidden) {
      document.hidden = hidden;
      assert.ok(documentListeners.has('visibilitychange'));
      documentListeners.get('visibilitychange')();
    },
    pageshow() {
      assert.ok(windowListeners.has('pageshow'));
      windowListeners.get('pageshow')();
    },
  };
}

function elapsed(face) { return face.ticks.filter((tick) => tick.classList.contains('elapsed')).length; }

test('Clock Face 2 creates exactly 60 SVG ticks, with 12 major ticks', () => {
  const face = loadFace(13, 7);
  assert.equal(face.ticks.length, 60);
  face.ticks.forEach((tick, index) => {
    assert.equal(tick.tagName, 'line');
    assert.equal(tick.attributes.class.includes('major'), index % 5 === 0);
    for (const coordinate of ['x1', 'y1', 'x2', 'y2']) {
      assert.ok(Number.isFinite(Number(tick.attributes[coordinate])));
    }
  });
  assert.equal(face.ticks.filter((tick) => tick.attributes.class.includes('major')).length, 12);
});

test('Clock Face 2 displays live zero-padded 24-hour HH:MM, including midnight', () => {
  const face = loadFace(13, 7, 12);
  const time = face.elements.get('#time');
  assert.equal(time.textContent, '13:07');
  assert.equal(time.dateTime, new Date(2026, 9, 14, 13, 7, 12).toISOString());
  for (const [hour, minute, expected] of [[23, 59, '23:59'], [0, 0, '00:00'], [1, 5, '01:05']]) {
    face.setTime(hour, minute);
    face.nextSecond();
    assert.equal(time.textContent, expected);
    assert.match(time.textContent, /^\d{2}:\d{2}$/);
  }
});

test('Clock Face 2 shows 59 elapsed seconds then resets all ticks at the next minute', () => {
  const face = loadFace(13, 7, 58);
  assert.equal(elapsed(face), 58);
  face.setTime(13, 7, 59);
  face.nextSecond();
  assert.equal(elapsed(face), 59);
  face.ticks.forEach((tick, index) => assert.equal(tick.classList.contains('elapsed'), index < 59));
  const offset = Number(face.elements.get('#progress').style.strokeDashoffset);
  assert.ok(offset > 0 && offset < 5, 'Seconds arc is nearly complete at 59 seconds');
  face.setTime(13, 8, 0);
  face.nextSecond();
  assert.equal(face.elements.get('#time').textContent, '13:08');
  assert.equal(elapsed(face), 0);
  assert.ok(Number(face.elements.get('#progress').style.strokeDashoffset) > offset * 59,
    'Seconds arc resets rather than remaining nearly complete');
});

test('Clock Face 2 has no timer label in visible markup or rendered readouts', () => {
  const face = loadFace(13, 7, 59);
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(markup, /\btimer\b/i);
  for (const node of face.elements.values()) {
    assert.doesNotMatch(node.textContent, /\btimer\b/i);
    assert.doesNotMatch(node.attributes['aria-label'] || '', /\btimer\b/i);
  }
});

test('Clock Face 2 refreshes on visibility restoration and pageshow without extra timers', () => {
  const face = loadFace(13, 7, 59);
  face.setTime(14, 8, 0);
  face.visibility(true);
  assert.equal(face.elements.get('#time').textContent, '13:07', 'Hidden event does not refresh');
  face.visibility(false);
  assert.equal(face.elements.get('#time').textContent, '14:08');
  assert.equal(elapsed(face), 0);
  face.setTime(15, 9, 10);
  face.pageshow();
  assert.equal(face.elements.get('#time').textContent, '15:09');
  assert.equal(elapsed(face), 10);
  assert.equal(face.timers.length, 1);
});
