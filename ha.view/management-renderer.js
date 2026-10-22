'use strict';
const api = window.nativeManagement;
const status = document.getElementById('status');
const statusMessages = new Map([
  ['Choose an existing native HA page. Route access is not verified device control.', 'Choose a Home Assistant page.'],
  ['Loading native HA page…', 'Loading Home Assistant page…'],
  ['Return to the visible HA dashboard first. HA View will not navigate a hidden ambient dashboard.', 'Return to the visible Home Assistant dashboard first.'],
  ['Sign in in the native HA frontend. HA View does not collect credentials; page permissions remain unverified.', 'Sign in in Home Assistant, then retry.'],
  ['HA denied access (403). Check your HA account permissions; no permissions are changed by HA View.', 'Home Assistant denied access (403). Check your account permissions.'],
  ['Native page unavailable or navigation failed. Check HA connectivity, installed integrations and frontend version.', 'Page unavailable or navigation failed. Check your Home Assistant connection and page access.'],
  ['Native route loaded; page content, permissions and controls are not yet verified.', 'Page navigation finished. Close this window to check the page.'],
  ['Native page element observed. Data, permissions, accessory support and controls remain unverified.', 'Page detected. Close this window to use Home Assistant.'],
  ['Use the native HA sidebar Notifications drawer; no invented notification route or commands.', 'Open Notifications from the Home Assistant sidebar.'],
  ['The active native view changed. Reopen the desired page when ready.', 'The active page changed. Choose a page again.'],
  ['Cannot open this page on the active configured HA origin.', 'Cannot open this page on your configured Home Assistant server.']
]);
const pageHelp = {
  devices: 'Open the Home Assistant device list.',
  entities: 'Open the Home Assistant entity list.',
  automations: 'Open Home Assistant automations.',
  scenes: 'Open Home Assistant scenes.',
  activity: 'Open recorded activity in Home Assistant.',
  history: 'Choose entities and a time range in Home Assistant.',
  notifications: 'Close this window, then open Notifications from the Home Assistant sidebar.'
};
function render(data) { status.textContent = (data.selected ? `${data.selected}: ` : '') + (statusMessages.get(data.message) || data.message); }
const unsubscribe = api.status(render);
const unsubscribeActivity = api.activityStatus(showActivity);
const activityState = document.getElementById('activity-state'), activityOutput = document.getElementById('activity-output');
const activityMessages = { idle:'Choose Read activity for recent records.', loading:'Loading activity from Home Assistant…', ready:'Recent recorded activity (newest first).', empty:'No matching records returned. Retention, filters or permissions may limit results.', login:'Sign in in Home Assistant, then retry.', hidden:'Return to the visible Home Assistant dashboard first.', error:'Activity could not be read. Check your Home Assistant connection, logbook and permissions.' };
function showActivity(data) { activityState.textContent = activityMessages[data.state] || activityMessages.error; activityOutput.textContent = data.state === 'ready' ? `${data.start} to ${data.end} (UTC). ${data.received} records returned; ${data.count} processed; ${data.shown} shown.\n\n${data.output}${data.truncated ? '\n\nShowing a limited subset.' : ''}` : ''; }
window.addEventListener('unload', () => { unsubscribe(); unsubscribeActivity(); }, { once: true });
document.getElementById('read-activity').addEventListener('click', async event => { const button=event.currentTarget; button.disabled=true; showActivity({state:'loading'}); try { showActivity(await api.activity(Number(document.getElementById('activity-hours').value))); } catch (_) { showActivity({state:'error'}); } finally { button.disabled=false; } });
api.get().then(data => {
  render(data);
  for (const page of data.pages) {
    const section = document.createElement('section'), button = document.createElement('button'), guidance = document.createElement('p');
    button.id = `open-${page.id}`; button.textContent = page.path ? `Open ${page.label}` : `${page.label} guidance`;
    guidance.textContent = Object.hasOwn(pageHelp, page.id) ? pageHelp[page.id] : 'Open this page in Home Assistant.';
    button.addEventListener('click', async () => { button.disabled = true; try { render(await api.open(page.id)); } catch (_) { status.textContent = 'Page access failed. Return to the visible Home Assistant dashboard and retry.'; } finally { button.disabled = false; } });
    section.append(button, guidance); document.getElementById('pages').append(section);
  }
}).catch(() => { status.textContent = 'Management access unavailable.'; });

document.getElementById('close').onclick = () => window.nativeManagement.close();
