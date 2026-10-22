'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('sandbox renderer uses text nodes, preserves probability and omits missing metrics', () => {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.textContent = ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute() {}
    get lastChild() { return this.children.at(-1); }
  }
  const elements = {}, window = { addEventListener() {} };
  const context = vm.createContext({ window, document: { getElementById: id => elements[id] ||= new Element(), createElement: () => new Element() }, Intl, Date, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'faces/weather-renderer.js'), 'utf8'), context);
  window.weatherFace.update({ name: '<script>bad</script>', temperature: 20, condition: 'sunny', timezone: 'UTC', isDaytime: true, forecastType: 'hourly', forecast: [{ datetime: new Date().toISOString(), temperature: 21, precipitationProbability: 40 }] });
  assert.equal(elements.name.textContent, '<script>bad</script>');
  assert.equal(elements.details.children.length, 0);
  assert.equal(elements.forecast.children[0].lastChild.textContent, '40%');
  assert.equal(elements.range.textContent, '');
});
