'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, 'day-schedule.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'face-settings.css'), 'utf8');
test('separate accessible header Close and explicit footer Cancel preserve pinned touch actions', () => {
  for (const id of ['dismiss','close','save','discard-confirmation','stay','discard']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1);
  assert.match(html, /<header[\s\S]*id="dismiss" aria-label="Close Face Settings">Close/);
  assert.match(html, /id="close" aria-describedby="cancel-help">Cancel/);
  assert.match(html, /Cancel discards unsaved changes and closes/);
  assert.match(html, /id="discard-confirmation" hidden/);
  assert.match(html, /id="stay">Stay[\s\S]*id="discard">Discard changes/);
  assert.match(css, /#dismiss\{[^}]*min-width:44px;min-height:44px/);
  assert.match(css, /\.settings-actions\{flex:none/);
  assert.match(css, /\.settings-content\{[^}]*overflow:auto/);
});
