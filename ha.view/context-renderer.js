/** HA.View local ordered context rule editor. */
'use strict';
const rows = document.querySelector('#rules'), status = document.querySelector('#status');
function add(rule = { entity_id: '', state: '', mode: 'dashboard' }) {
  const row = document.createElement('div');
  const entity = document.createElement('input'); entity.placeholder = 'binary_sensor.example'; entity.value = rule.entity_id; entity.setAttribute('aria-label', 'Home Assistant entity');
  const state = document.createElement('input'); state.placeholder = 'Exact state, e.g. on'; state.value = rule.state; state.setAttribute('aria-label', 'State to match');
  const mode = document.createElement('select'); mode.setAttribute('aria-label', 'Show');
  for (const value of ['dashboard', 'clock1', 'clock2']) { const option = document.createElement('option'); option.value = value; option.textContent = ({ dashboard: 'Dashboard', clock1: 'Clock 2', clock2: 'Clock 1' })[value]; mode.append(option); } mode.value = rule.mode;
  const up = document.createElement('button'); up.textContent = '↑'; up.setAttribute('aria-label', 'Higher priority'); up.onclick = () => { if (row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling); };
  const down = document.createElement('button'); down.textContent = '↓'; down.setAttribute('aria-label', 'Lower priority'); down.onclick = () => { if (row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row); };
  const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.onclick = () => row.remove(); for (const [text, control] of [['Home Assistant entity', entity], ['State to match', state], ['Show', mode]]) { const label = document.createElement('label'); label.textContent = text; label.append(control); row.append(label); } const actions = document.createElement('div'); actions.className = 'rule-actions'; actions.append(up, down, remove); row.append(actions); rows.append(row);
}
document.querySelector('#close').onclick = () => window.contextDisplay.close();
document.querySelector('#add').onclick = () => add();
document.querySelector('#save').onclick = async () => {
  try { await window.contextDisplay.save({ enabled: document.querySelector('#enabled').checked, rules: [...rows.children].map(row => ({ entity_id: row.querySelectorAll('input')[0].value, state: row.querySelectorAll('input')[1].value, mode: row.querySelector('select').value })) }); status.textContent = 'Saved. Applies only during idle.'; }
  catch (e) { status.textContent = `Not saved: ${e.message}`; }
};
window.contextDisplay.get().then(({ config, error, file }) => { document.querySelector('#enabled').checked = config.enabled; config.rules.forEach(add); document.querySelector('#save').disabled = false; document.querySelector('#file').textContent = `Local config: ${file}`; status.textContent = error ? `Disabled: ${error}` : ''; }).catch(e => { status.textContent = e.message; });
