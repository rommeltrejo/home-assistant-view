/** HA.View fixed one/two existing-face composition, atomic local persistence. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const TYPES = Object.freeze(['clock1', 'clock2', 'calendar', 'upcoming']);
const DEFAULT = { version: 2, cards: [{ type: 'clock2' }] };
function normalize(value) {
  if (!value || !Array.isArray(value.cards) || !value.cards.length || value.cards.length > 2) throw Error('Layout requires one or two faces.');
  return { version: 2, cards: value.cards.map(card => {
    const type = card?.type === 'clock' ? 'clock1' : card?.type;
    if (!TYPES.includes(type)) throw Error('Invalid layout face.');
    return { type };
  }) };
}
function regions(config) { return normalize(config).cards.map((card, i, cards) => ({ ...card, x: cards.length === 1 ? 0 : i / 2, width: 1 / cards.length })); }
function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Migrate superseded freeform drafts; retain only first two face choices, never geometry.
    if (value.version === 1) value.cards = value.cards?.slice(0, 2);
    return normalize(value);
  } catch { return normalize(DEFAULT); }
}
function write(file, value) {
  const config = normalize(value); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(config) + '\n', { mode: 0o600 }); fs.renameSync(file + '.tmp', file); return config;
}
module.exports = { TYPES, DEFAULT, regions, normalize, read, write };
