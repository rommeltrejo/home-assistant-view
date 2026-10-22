'use strict';
const $ = id => document.getElementById(id);
const command = async (action, value) => {
  try { return await window.browserUI.command(action, value); }
  catch { const status = $('settings-status') || $('status'); if (status) status.textContent = 'Unable to perform this browser action.'; return { ok: false }; }
};
if ($('open')) $('open').onclick = () => command('open');
else {
  document.addEventListener('keydown', event => {
    const target = event.target;
    if (!['address', 'homepage', 'provider-name', 'provider-template'].includes(target?.id) || !(target instanceof HTMLInputElement) || target.disabled || target.readOnly || !['text', 'url', 'search'].includes(target.type) || event.altKey || event.shiftKey || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
    const action = ({ a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' })[event.key.toLowerCase()];
    if (!action) return;
    event.preventDefault();
    command('edit', action);
  });
  for (const action of ['back', 'forward', 'reload', 'close']) $(action).onclick = () => command(action);
  $('address-form').onsubmit = event => { event.preventDefault(); command('navigate', $('address').value); };
  $('close-settings').onclick = () => command('settings', false);
  $('settings').onclick = () => command('settings', $('browser-settings').hidden);
  document.addEventListener('pointerdown', event => {
    if (!$('browser-settings').hidden && !$('browser-settings').contains(event.target) && !$('settings').contains(event.target)) command('settings', false);
  }, true);
  $('homepage-form').onsubmit = event => { event.preventDefault(); command('homepage', $('homepage').value.trim()); };
  $('clear-data').onclick = () => { $('clear-confirm').hidden = false; $('confirm-clear').focus(); };
  $('cancel-clear').onclick = () => { $('clear-confirm').hidden = true; $('clear-data').focus(); };
  $('confirm-clear').onclick = () => { $('clear-confirm').hidden = true; command('clear', true); };
  let pendingDelete = null;
  const closeProviderPopups = () => { $('provider-popup').hidden = true; $('delete-provider-popup').hidden = true; pendingDelete = null; };
  $('show-browser-icon').onchange = async () => {
    const toggle = $('show-browser-icon');
    toggle.disabled = true;
    const result = await command('show-icon', toggle.checked);
    if (!result?.ok) toggle.checked = !toggle.checked;
    toggle.disabled = false;
  };
  $('search-enabled').onchange = () => command('search-enabled', $('search-enabled').checked);
  $('search-provider').onchange = () => command('search-provider', $('search-provider').value);
  $('add-provider').onclick = () => { closeProviderPopups(); $('provider-popup').hidden = false; $('provider-name').focus(); };
  $('cancel-provider').onclick = () => { closeProviderPopups(); $('provider-popup').reset(); $('add-provider').focus(); };
  $('provider-popup').onsubmit = async event => {
    event.preventDefault();
    const result = await command('search-add', { name: $('provider-name').value.trim(), template: $('provider-template').value.trim() });
    if (result?.ok) { closeProviderPopups(); $('provider-popup').reset(); $('add-provider').focus(); }
    else if (result?.error) $('settings-status').textContent = result.error;
  };
  $('cancel-provider-delete').onclick = () => { closeProviderPopups(); $('search-provider').focus(); };
  $('confirm-provider-delete').onclick = async () => { const id = pendingDelete; closeProviderPopups(); await command('search-remove', id); $('search-provider').focus(); };
  window.browserUI.onState(state => {
    const changed = $('browser-settings').hidden === state.settingsOpen;
    $('browser-settings').hidden = !state.settingsOpen;
    $('settings').setAttribute('aria-expanded', String(state.settingsOpen));
    if (changed) { closeProviderPopups(); $('clear-confirm').hidden = true; if (state.settingsOpen) $('homepage').focus(); else $('settings').focus(); }
    if (document.activeElement !== $('homepage') || changed) $('homepage').value = state.homepage;
    for (const id of ['clear-data', 'confirm-clear', 'save-homepage', 'homepage']) $(id).disabled = state.clearing;
    $('show-browser-icon').checked = state.showIcon !== false;
    $('show-browser-icon').disabled = state.clearing;
    const search = state.search;
    $('search-enabled').checked = search.enabled;
    $('search-providers').hidden = !search.enabled;
    if (!search.enabled) closeProviderPopups();
    $('search-provider').replaceChildren();
    for (const provider of [...state.builtins, ...search.customProviders]) {
      const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name;
      $('search-provider').append(option);
    }
    $('search-provider').value = search.provider;
    $('custom-providers').replaceChildren();
    for (const provider of search.customProviders) {
      const row = document.createElement('div'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = provider.name; remove.textContent = '−'; remove.setAttribute('aria-label', `Remove ${provider.name}`); remove.disabled = state.clearing;
      remove.onclick = () => { closeProviderPopups(); pendingDelete = provider.id; $('delete-provider-question').textContent = `Are you sure you want to delete "${provider.name}"?`; $('delete-provider-popup').hidden = false; $('cancel-provider-delete').focus(); };
      row.append(name, remove); $('custom-providers').append(row);
    }
    for (const id of ['search-enabled', 'search-provider', 'add-provider', 'provider-name', 'provider-template', 'confirm-provider-delete']) $(id).disabled = state.clearing;
    $('settings-status').textContent = state.clearing ? 'Clearing browser data…' : state.error || '';

    if (document.activeElement !== $('address')) $('address').value = state.url;
    $('back').disabled = !state.back; $('forward').disabled = !state.forward; $('reload').disabled = !state.url;
    $('status').textContent = state.error || (state.loading ? 'Loading…' : state.url ? 'Ready' : 'Enter a website address to begin.');
  });
  $('address').focus();
}
