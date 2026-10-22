/** HA.View shared action registry. Desktop chrome keeps native menus and the face shortcut. */
'use strict';
const states = new WeakMap();
function stateFor(electron) {
  let state = states.get(electron.Menu);
  if (!state) {
    state = { registrations: new Map(), native: new Map(), installed: null, next: 0 };
    states.set(electron.Menu, state);
    electron.app?.once?.('ready', () => refresh(electron));
  }
  return state;
}
// Canonical Electron roles and registry IDs are lowercase. Only roles with an
// explicit, target-safe documented API are offered; never dispatch MenuItem.click.
const editMethods = { undo: 'undo', redo: 'redo', cut: 'cut', copy: 'copy', paste: 'paste',
  pasteandmatchstyle: 'pasteAndMatchStyle', delete: 'delete', selectall: 'selectAll' };
const roles = new Set([...Object.keys(editMethods), 'about', 'quit', 'hide', 'reload',
  'forcereload', 'toggledevtools', 'resetzoom', 'zoomin', 'zoomout', 'minimize', 'close', 'front']);
const normalizeRole = role => typeof role === 'string' ? role.toLowerCase() : '';
function discover(state, items, group) {
  for (const item of items || []) {
    if (item.submenu) discover(state, item.submenu.items, item.label || group);
    else {
      const role = normalizeRole(item.role);
      if (roles.has(role)) state.native.set(role, { item, group });
    }
  }
}
function invoke(target, method, ...args) {
  if (!target || target.isDestroyed?.() || typeof target[method] !== 'function') {
    throw Error('Unsupported or unavailable system action target');
  }
  return target[method](...args);
}
function dispatch(electron, role, parent, contents) {
  if (editMethods[role]) return invoke(contents, editMethods[role]);
  switch (role) {
    case 'reload': return invoke(contents, 'reload');
    case 'forcereload': return invoke(contents, 'reloadIgnoringCache');
    case 'resetzoom': return invoke(contents, 'setZoomLevel', 0);
    case 'zoomin': case 'zoomout': {
      const level = invoke(contents, 'getZoomLevel');
      if (!Number.isFinite(level)) throw Error('Unavailable system action zoom level');
      return invoke(contents, 'setZoomLevel', level + (role === 'zoomin' ? 0.5 : -0.5));
    }
    case 'toggledevtools': {
      const opened = invoke(contents, 'isDevToolsOpened');
      return invoke(contents, opened ? 'closeDevTools' : 'openDevTools');
    }
    case 'minimize': case 'close': return invoke(parent, role);
    case 'front': return invoke(parent, 'focus');
    case 'about': return invoke(electron.app, 'showAboutPanel');
    case 'hide': return invoke(electron.app, 'hide');
    case 'quit': return invoke(electron.app, 'quit');
    default: throw Error('Unsupported system action');
  }
}
function refresh(electron) {
  const { Menu, MenuItem } = electron, state = stateFor(electron);
  const current = Menu.getApplicationMenu();
  if (current && current !== state.installed) {
    discover(state, current.items, 'Application');
  }
  const template = [];
  if ((electron.platform || process.platform) === 'darwin') template.push({ role: 'appMenu' });
  template.push({ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' });
  const entries = actions(electron).filter(entry => entry.permanent);
  if (entries.length) template.push({ label: 'HA View', submenu: entries.map(entry => ({ label: entry.label, click: entry.click })) });
  // An empty real Help submenu lets macOS provide its native Help search, without
  // suggesting that HA.View implements any custom help commands.
  template.push({ role: 'help', label: 'Help', submenu: [] });
  const build = items => {
    if (Menu.buildFromTemplate) return Menu.buildFromTemplate(items);
    // Small test doubles and older embedders may only expose Menu/MenuItem.
    const result = new Menu();
    for (const item of items) result.append(new MenuItem({ ...item,
      ...(Array.isArray(item.submenu) ? { submenu: build(item.submenu) } : {}) }));
    return result;
  };
  const menu = build(template);
  if (!state.native.size) discover(state, menu.items, 'Application');
  state.installed = menu;
  Menu.setApplicationMenu(menu);
}
function actions(electron) {
  const state = stateFor(electron);
  return [...state.registrations.values()].flatMap(value => value.entries).sort((a,b) => a.order-b.order || a.label.localeCompare(b.label));
}
function register(electron, key, entries) {
  const state = stateFor(electron), token = {};
  state.registrations.set(key, { token, entries: entries.map(entry => ({ ...entry, id: `${key}:${++state.next}`, permanent: entry.label === 'Show a face now…' })) });
  refresh(electron);
  let disposed = false;
  return () => { if (disposed) return; disposed = true; if (state.registrations.get(key)?.token !== token) return; state.registrations.delete(key); refresh(electron); };
}
function list(electron) {
  refresh(electron);
  return [...actions(electron).filter(entry => !entry.permanent).map(entry => ({ id: entry.id, label: entry.label, group: 'Testing tools' })),
    ...[...stateFor(electron).native].map(([role,{item,group}]) => ({ id: `native:${role}`, label: item.label || role, group, enabled: item.enabled !== false }))];
}
function run(electron, id, parent, contents) {
  const entry = actions(electron).find(entry => entry.id === id && !entry.permanent);
  if (entry) { entry.click(undefined, parent); return 'tool'; }
  const role = typeof id === 'string' && id.startsWith('native:') ? normalizeRole(id.slice(7)) : '';
  const native = stateFor(electron).native.get(role);
  if (!roles.has(role) || !native || native.item.enabled === false) throw Error('Unknown or disabled system action');
  // Preserve canonical close/quit IDs for the settings handoff's no-reopen guard.
  if (id !== `native:${role}`) throw Error('Unknown system action');
  dispatch(electron, role, parent, contents);
  return 'native';
}
module.exports = { register, refresh, list, run };
