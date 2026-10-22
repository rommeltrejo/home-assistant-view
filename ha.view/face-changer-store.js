/** HA.View local selection only; atomic replacement preserves the last saved choice. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const modes = require('./face-modes');
function read(file, fallback = 2) {
  try { const n = JSON.parse(fs.readFileSync(file, 'utf8')).face; if (n === 1 || n === 2) return n; } catch {}
  return fallback === 1 ? 1 : 2;
}
function readMode(file, fallback = 'clock2') {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.mode === 'string' && modes.FACE_IDS.includes(value.mode)) return value.mode;
    if (value.face === 1 || value.face === 2) return `clock${value.face}`;
  } catch {}
  return modes.fromLegacyFace(fallback);
}
function write(file, face) {
  if (face !== 1 && face !== 2) throw new Error('Invalid clock face');
  return writeMode(file, `clock${face}`);
}
function writeMode(file, mode) {
  if (!modes.FACE_IDS.includes(mode)) throw new Error('Invalid idle face');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hidden = readHidden(file);
  const data = mode === 'clock1' || mode === 'clock2' ? { face: Number(mode.slice(-1)) } : { mode };
  if (hidden.length) data.hidden = hidden;
  fs.writeFileSync(file + '.tmp', JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function readHidden(file) {
  try { const hidden = JSON.parse(fs.readFileSync(file, 'utf8')).hidden;
    return Array.isArray(hidden) ? [...new Set(hidden.filter(id => modes.FACE_IDS.includes(id)))] : [];
  } catch (error) { return error.code === 'ENOENT' ? ['layout'] : []; }
}
function writeHidden(file, hidden) {
  if (!Array.isArray(hidden) || hidden.some(id => !modes.FACE_IDS.includes(id))) throw new Error('Invalid hidden face');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = { face: 2 }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = { face: 2 };
  data.hidden = [...new Set(hidden)];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
module.exports = { read, write, readMode, writeMode, readHidden, writeHidden };
