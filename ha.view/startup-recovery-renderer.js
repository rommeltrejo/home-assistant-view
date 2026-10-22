'use strict';
const status = document.querySelector('#status');
const wait = document.querySelector('#wait');
const cancel = document.querySelector('#cancel');
function render(state) {
  if (!state) return;
  status.textContent = state.message;
  wait.disabled = state.waiting || state.checking;
  cancel.hidden = !state.waiting;
}
const unsubscribe = window.startupRecovery.subscribe(render);
window.addEventListener('unload', unsubscribe, { once: true });
window.startupRecovery.state().then(render);
for (const button of document.querySelectorAll('button')) button.addEventListener('click', async () => {
  try { await window.startupRecovery.action(button.dataset.action); }
  catch { status.textContent = 'Unable to complete this action. Please try again.'; }
});
