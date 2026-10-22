'use strict';
const rows = document.querySelector('#rules');
const status = document.querySelector('#status');
let calendarEntities = [];
let savedSnapshot = null;
const strategy = document.querySelector('#strategy');
const rotationRows = document.querySelector('#rotation-faces');
let faces = [], faceLabels = new Map(), ready = false;
const saveButton = document.querySelector('#save'), addButton = document.querySelector('#add');
saveButton.disabled = addButton.disabled = true;
function descriptors(value) {
  if (!Array.isArray(value) || !value.length) throw new Error('Face descriptors unavailable.');
  const ids = new Set();
  return value.map(face => {
    if (!face || typeof face !== 'object' || Array.isArray(face) ||
        Object.keys(face).length !== 2 || Object.keys(face).some(key => !['id', 'label'].includes(key)) ||
        typeof face.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(face.id) || face.id === 'dashboard' ||
        typeof face.label !== 'string' || !face.label.trim() || ids.has(face.id)) throw new Error('Invalid face descriptors.');
    ids.add(face.id);
    return { id: face.id, label: face.label };
  });
}
function showStrategy() {
  document.querySelector('#daily-controls').hidden = strategy.value !== 'daily';
  document.querySelector('#rotation-controls').hidden = strategy.value !== 'rotation';
}
strategy.onchange = showStrategy;
function rotationFace(face, checked) {
  const row = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
  input.type = 'checkbox'; input.value = face; input.checked = checked;
  label.append(input, document.createTextNode(faceLabels.get(face)));
  const up = document.createElement('button'), down = document.createElement('button');
  up.textContent = 'Up'; down.textContent = 'Down';
  up.setAttribute('aria-label', `Move ${faceLabels.get(face)} up`); down.setAttribute('aria-label', `Move ${faceLabels.get(face)} down`);
  up.onclick = () => { if (row.previousElementSibling) rotationRows.insertBefore(row, row.previousElementSibling); };
  down.onclick = () => { if (row.nextElementSibling) rotationRows.insertBefore(row.nextElementSibling, row); };
  row.append(label, up, down); rotationRows.append(row);
}
const calendarList = document.querySelector('#calendar-entities');
function add(rule = { time: '09:00', mode: 'dashboard' }) {
  if (rule.mode !== 'dashboard' && !faceLabels.has(rule.mode)) throw new Error('Unknown saved daily face.');
  const row = document.createElement('div');
  const time = document.createElement('input'); time.type = 'time'; time.value = rule.time; time.setAttribute('aria-label', 'Local start time');
  const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Idle presentation');
  for (const [value, label] of [['dashboard', 'Dashboard'], ...faces.map(({ id, label }) => [id, label])]) { const option = document.createElement('option'); option.value = value; option.textContent = label; mode.append(option); }
  mode.value = rule.mode;
  const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => row.remove();
  row.append(time, mode, remove); rows.append(row);
}
// Compare the serializable form, not events: restored values and discovery are clean.
function currentForm() {
  const input = document.querySelector('#idle-minutes');
  return { strategy: strategy.value, rotationMs: Number(document.querySelector('#rotation-minutes').value) * 60000,
    rotationFaces: [...rotationRows.querySelectorAll('input:checked')].map(input => input.value),
    calendarEntities: [...new Set(calendarEntities)].sort(),
    idleMs: Number(input.value) * 60000,
    enabled: document.querySelector('#enabled').checked,
    rules: [...rows.children].map(row => ({ time: row.querySelector('input').value, mode: row.querySelector('select').value })) };
}
function serializeForm(form = currentForm()) { return JSON.stringify(form); }
const confirmation = document.querySelector('#discard-confirmation');
const dismiss = document.querySelector('#dismiss');
const closeSettings = () => window.daySchedule.close().catch(error => { status.textContent = error.message; });
document.querySelector('#close').onclick = closeSettings;
dismiss.onclick = () => {
  if (savedSnapshot !== null && serializeForm() !== savedSnapshot) {
    confirmation.hidden = false;
    document.querySelector('#stay').focus();
  } else return closeSettings();
};
document.querySelector('#stay').onclick = () => { confirmation.hidden = true; dismiss.focus(); };
document.querySelector('#discard').onclick = closeSettings;
addButton.onclick = () => { if (ready) add(); };
document.querySelector('#save').onclick = async () => {
  try {
    if (!ready) throw new Error('Settings are not ready. Reopen Settings to retry.');
    const input = document.querySelector('#idle-minutes');
    if (!input.checkValidity()) throw new Error('Inactivity timer must be between 0.1 and 1440 minutes.');
    const rotationInput = document.querySelector('#rotation-minutes');
    if (!rotationInput.checkValidity()) throw new Error('Rotation interval must be between 0.1 and 1440 minutes.');
    const form = currentForm();
    await window.daySchedule.save(form);
    // Capture the submitted form; edits made while IPC is pending remain dirty.
    savedSnapshot = serializeForm(form);
    confirmation.hidden = true;
    status.textContent = 'Saved. Applies after inactivity; never interrupts current interaction.';
  } catch (error) { status.textContent = `Not saved: ${error.message}`; }
};
window.daySchedule.get().then(({ config, error, idleOverrideMs, faces: snapshot }) => {
  faces = descriptors(snapshot);
  faceLabels = new Map(faces.map(({ id, label }) => [id, label]));
  const selectedFaces = config.rotationFaces || faces.map(face => face.id);
  if (!Array.isArray(selectedFaces) || new Set(selectedFaces).size !== selectedFaces.length ||
      selectedFaces.some(face => !faceLabels.has(face)) ||
      !Array.isArray(config.rules) || config.rules.some(rule => !rule || (rule.mode !== 'dashboard' && !faceLabels.has(rule.mode)))) {
    throw new Error('Saved faces do not match face descriptors.');
  }
  calendarEntities = [...(config.calendarEntities || [])];
  window.daySchedule.calendars().then(result => {
    if (result === undefined) return; // Quiet expiry: no DOM/status mutation.
    document.querySelector('#calendar-status').textContent = result.status === 'ok' ? (result.calendars.length ? 'Shared by Calendar and Upcoming Events. None selected uses readable calendars automatically (maximum 8).' : 'No readable calendars. Configure calendars in Home Assistant.') : (result.message || 'Connect to Home Assistant to select calendars.');
    const catalog = result.calendars || [];
    for (const id of calendarEntities) if (!catalog.some(row => row.entity_id === id)) catalog.push({ entity_id: id, name: id + ' (currently unavailable)' });
    for (const item of catalog) {
      const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = calendarEntities.includes(item.entity_id);
      input.onchange = () => { const selected = [...calendarList.querySelectorAll('input:checked')].map(node => node.value); if (selected.length > 8) { input.checked = false; return; } calendarEntities = selected; };
      input.value = item.entity_id; label.append(input, document.createTextNode(item.name)); calendarList.append(label, document.createElement('br'));
    }
  }).catch(() => { document.querySelector('#calendar-status').textContent = 'Calendar discovery unavailable. Saved selections are preserved.'; });
  strategy.value = config.strategy || 'daily'; showStrategy();
  document.querySelector('#rotation-minutes').value = (config.rotationMs || 300000) / 60000;
  for (const face of [...selectedFaces, ...faces.map(face => face.id).filter(face => !selectedFaces.includes(face))]) rotationFace(face, selectedFaces.includes(face));
  document.querySelector('#enabled').checked = config.enabled; config.rules.forEach(add);
  document.querySelector('#idle-minutes').value = config.idleMs / 60000;
  if (idleOverrideMs !== null && idleOverrideMs !== undefined) {
    const notice = document.querySelector('#idle-override'); notice.hidden = false;
    notice.textContent = `Command-line override active (--ha-view-idle-ms): ${idleOverrideMs / 60000} minutes. Saved settings will apply when this override is removed.`;
  }
  savedSnapshot = serializeForm();
  ready = true; saveButton.disabled = addButton.disabled = false;
  status.textContent = error ? `Invalid saved config; schedule disabled: ${error}` : '';
}).catch(error => { ready = false; saveButton.disabled = addButton.disabled = true; status.textContent = `Not loaded: ${error.message}`; });
