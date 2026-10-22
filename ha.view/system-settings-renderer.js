'use strict';
const settingsActions = [
  { key: 'faces', source: 'Automatic faces…', label: 'Face Settings', help: 'Choose what appears when the screen is idle.' },
  { key: 'layout', source: 'Edit split layout…', label: 'Split Layout', help: 'Choose the two faces shown together.' },
  { key: 'context', source: 'State-based face rules…', label: 'State-based Faces', help: 'Change the idle face when a Home Assistant entity changes.', advanced: true },
  { key: 'management', source: 'Home Assistant management…', label: 'Home Assistant', help: 'Open devices, entities, automations, or activity.', advanced: true },
  { key: 'cameras', source: 'Camera Dashboard…', label: 'Camera Dashboard', help: 'Choose an existing Home Assistant camera dashboard.', advanced: true }
];
document.getElementById('close').onclick = () => window.systemSettings.close();
window.systemSettings.get().then(({ actions: entries, showBrowserIcon, browserError }) => {
  const root = document.getElementById('actions');
  const core = document.createElement('section');
  core.className = 'settings-group';
  const advanced = document.createElement('details');
  advanced.className = 'settings-group advanced-settings';
  const summary = document.createElement('summary');
  summary.textContent = 'Advanced — Experimental';
  advanced.append(summary);
  for (const action of settingsActions) {
    const entry = entries.find(entry => typeof entry.id === 'string' &&
      new RegExp(`^${action.key}:\\d+$`).test(entry.id) && entry.label === action.source);
    if (!entry) continue;
    const button = document.createElement('button');
    button.className = 'setting-action';
    const label = document.createElement('span'), help = document.createElement('span');
    label.textContent = action.advanced ? `${action.label} — Experimental` : action.label;
    help.textContent = action.help;
    help.className = 'action-help';
    button.append(label, help);
    button.disabled = entry.enabled === false;
    button.onclick = () => {
      button.disabled = true;
      window.systemSettings.run(entry.id).catch(() => {
        button.disabled = entry.enabled === false;
        document.getElementById('status').textContent = 'Settings unavailable. Close and try again.';
      });
    };
    (action.advanced ? advanced : core).append(button);
  }
  const browserRow = document.createElement('label');
  browserRow.className = 'browser-setting';
  const browserLabel = document.createElement('span');
  browserLabel.textContent = 'Show browser icon';
  const browserToggle = document.createElement('input');
  browserToggle.type = 'checkbox'; browserToggle.setAttribute('role', 'switch');
  browserToggle.checked = showBrowserIcon; browserToggle.disabled = !!browserError;
  browserRow.append(browserLabel, browserToggle);
  browserToggle.onchange = async () => {
    browserToggle.disabled = true;
    try { browserToggle.checked = await window.systemSettings.setBrowserIcon(browserToggle.checked); document.getElementById('status').textContent = ''; }
    catch { browserToggle.checked = !browserToggle.checked; document.getElementById('status').textContent = 'Browser visibility was not saved. Check preference file access.'; }
    finally { browserToggle.disabled = !!browserError; }
  };
  root.append(browserRow);
  if (browserError) document.getElementById('status').textContent = browserError;
  if (core.children.length) root.append(core);
  if (advanced.children.length > 1) root.append(advanced);
  // Browser visibility remains available even when no other settings actions are registered.
}).catch(() => { document.getElementById('status').textContent = 'Settings unavailable.'; });
