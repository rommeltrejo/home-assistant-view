'use strict';
const field = document.getElementById('path');
const open = document.getElementById('open');
function render(data) {
  document.getElementById('status').textContent = data.message;
  document.getElementById('error').textContent = data.validationError || '';
  open.disabled = !data.path || data.state === 'unconfigured' || data.state === 'loading';
}
window.cameraDashboard.status(render);
window.cameraDashboard.get().then(data => { field.value = data.path; render(data); }).catch(() => render({ state: 'error', message: 'Camera settings unavailable.' }));
document.getElementById('save').addEventListener('click', async () => { try { const data = await window.cameraDashboard.save(field.value); render(data); } catch (_) { render({ state: 'error', message: 'Could not save camera settings.' }); } });
open.addEventListener('click', async () => { try { render(await window.cameraDashboard.open()); } catch (_) { render({ state: 'error', message: 'Could not open camera dashboard.' }); } });

document.getElementById('close').onclick = () => window.cameraDashboard.close();
