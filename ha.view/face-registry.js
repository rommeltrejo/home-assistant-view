/** HA.View build-time face composition; not a runtime plugin registration surface. */
'use strict';
// Promote previously shipped additions to the pinned base before evolving the set.
// Implicit indices are input-order deterministic, not release-to-release stable.
function createRegistry(base, additions = []) {
  if (!Array.isArray(base) || !base.length || !Array.isArray(additions)) throw new TypeError('Face arrays required');
  const ids = new Set(), files = new Set(), indices = new Set();
  function copy(face, pinned) {
    if (!face || typeof face !== 'object' || Array.isArray(face) ||
        Object.keys(face).some(key => !['id', 'label', 'file', 'index'].includes(key)) ||
        typeof face.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(face.id) || face.id === 'dashboard' ||
        typeof face.label !== 'string' || !face.label.trim() ||
        typeof face.file !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(face.file) ||
        (pinned && face.index === undefined) ||
        (face.index !== undefined && (!Number.isSafeInteger(face.index) || face.index < 1))) {
      throw new TypeError('Invalid face descriptor');
    }
    if (ids.has(face.id) || files.has(face.file) || (face.index !== undefined && indices.has(face.index))) {
      throw new TypeError('Duplicate face ID, file or index');
    }
    ids.add(face.id); files.add(face.file);
    if (face.index !== undefined) indices.add(face.index);
    return { id: face.id, label: face.label, file: face.file, index: face.index };
  }
  const pinned = base.map(face => copy(face, true));
  if (!pinned.some(face => face.id === 'clock1' && face.index === 1) ||
      !pinned.some(face => face.id === 'clock2' && face.index === 2) ||
      pinned.some(face => face.index > pinned.length)) throw new TypeError('Invalid compatibility indices');
  const appended = additions.map(face => copy(face, false)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let next = pinned.length + 1;
  for (const face of appended) {
    if (face.index === undefined) {
      while (indices.has(next)) next++;
      face.index = next; indices.add(next++);
    }
  }
  const ordered = [...pinned, ...appended].sort((a, b) => a.index - b.index);
  // Dense compatibility indices retain the existing chooser's clamp semantics.
  if (ordered.some((face, i) => face.index !== i + 1)) throw new TypeError('Compatibility indices must be contiguous');
  const FACES = Object.freeze(ordered.map(({ id, label, file }) => Object.freeze({ id, label, file })));
  const FACE_IDS = Object.freeze(FACES.map(face => face.id));
  const SCHEDULE_MODES = Object.freeze(['dashboard', ...FACE_IDS]);
  const byId = new Map(FACES.map(face => [face.id, face]));
  function fromLegacyFace(value, fallback = 'clock2') {
    if (FACE_IDS.includes(value)) return value;
    if (value === 1 || value === 2) return `clock${value}`;
    return FACE_IDS.includes(fallback) ? fallback : 'clock2';
  }
  function indexOf(mode) { const index = FACE_IDS.indexOf(mode); return index < 0 ? 2 : index + 1; }
  function fromIndex(index) { return FACE_IDS[Math.max(0, Math.min(FACE_IDS.length - 1, Math.trunc(Number(index) || 2) - 1))]; }
  function definition(mode) { return byId.get(fromLegacyFace(mode)); }
  return Object.freeze({ FACES, FACE_IDS, SCHEDULE_MODES, fromLegacyFace, indexOf, fromIndex, definition });
}
// Presentation positions are never persisted compatibility indices.
const PRESENTATION_IDS = Object.freeze(['clock2', 'weather', 'clock1', 'calendar', 'upcoming', 'layout']);
function presentationFaces(faces) {
  return Object.freeze([...faces].sort((a, b) => {
    const rank = id => { const index = PRESENTATION_IDS.indexOf(id); return index < 0 ? PRESENTATION_IDS.length : index; };
    return rank(a.id) - rank(b.id);
  }));
}
// Owned chooser composition: calendars intentionally use non-live previews.
function chooserDescriptors(faces) {
  const previews = { 'calendar.html': 'calendar-preview.html', 'upcoming-events.html': 'upcoming-preview.html', 'weather.html': 'weather-preview.html' };
  if (!Array.isArray(faces) || !faces.length) throw new TypeError('Face snapshot required');
  const ids = new Set();
  // Reject holes (including inherited entries) before mapping the snapshot.
  for (let index = 0; index < faces.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(faces, index)) throw new TypeError('Dense face snapshot required');
  }
  for (const face of faces) {
    if (!face || typeof face.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(face.id) ||
        ids.has(face.id) || typeof face.label !== 'string' || !face.label.trim() ||
        typeof face.file !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(face.file)) {
      throw new TypeError('Invalid chooser face');
    }
    ids.add(face.id);
  }
  return Object.freeze(faces.map(face => Object.freeze({
    id: face.id, label: face.label, previewFile: previews[face.file] || face.file,
  })));
}
module.exports = { createRegistry, chooserDescriptors, presentationFaces };
