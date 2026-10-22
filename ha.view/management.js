/** HA.View Native smart-home management access: observe native pages, never backend commands. */
'use strict';
const path = require('node:path');
const { pages, target } = require('./management-policy');
const { ActivityBridge } = require('./activity-bridge');
const messages = {
  idle: 'Choose an existing native HA page. Route access is not verified device control.',
  loading: 'Loading native HA page…',
  hidden: 'Return to the visible HA dashboard first. HA View will not navigate a hidden ambient dashboard.',
  login: 'Sign in in the native HA frontend. HA View does not collect credentials; page permissions remain unverified.',
  denied: 'HA denied access (403). Check your HA account permissions; no permissions are changed by HA View.',
  unavailable: 'Native page unavailable or navigation failed. Check HA connectivity, installed integrations and frontend version.',
  'route-loaded': 'Native route loaded; page content, permissions and controls are not yet verified.',
  'page-present': 'Native page element observed. Data, permissions, accessory support and controls remain unverified.',
  guidance: 'Use the native HA sidebar Notifications drawer; no invented notification route or commands.',
  away: 'The active native view changed. Reopen the desired page when ready.',
  error: 'Cannot open this page on the active configured HA origin.'
};
function install({ electron, getWebview, interaction = () => {}, dashboardVisible = () => getWebview()?.viewActive > 0 }) {
  const { BrowserWindow, ipcMain, Menu, MenuItem } = electron;
  let window, state = 'idle', selected = null, epoch = 0, timer, monitor, disposed = false;
  const cleanup = [], guards = [];
  let activityContents = null, activityMonitor, activityProbe = null, activityEpoch = 0;
  const activityCleanup = [];
  const activeContents = () => { const w = getWebview(); return w?.viewActive > 0 ? w.views?.[w.viewActive]?.webContents : null; };
  function detachActivity() {
    activityEpoch++;
    for (const remove of activityCleanup.splice(0)) remove();
    activityContents = null;
  }
  function syncActivity() {
    const current = activeContents();
    if (current === activityContents) return;
    detachActivity(); activity.invalidate();
    if (!current || current.isDestroyed()) return;
    activityContents = current;
    const invalidate = () => activity.invalidate();
    for (const name of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page', 'render-process-gone', 'destroyed']) {
      current.on(name, invalidate);
      activityCleanup.push(() => current.removeListener(name, invalidate));
    }
  }
  function stopActivityTracking() {
    clearInterval(activityMonitor); activityMonitor = null;
    detachActivity(); activity.invalidate();
  }
  function trackActivity() {
    syncActivity();
    activityMonitor = setInterval(() => {
      syncActivity();
      if (!dashboardVisible()) { if (activity.snapshot().state !== 'idle') activity.invalidate(); return; }
      const wc = activityContents, token = activityEpoch;
      if (!wc || wc.isDestroyed() || activityProbe) return;
      // Observe only connection readiness; no events, credentials or extra backend calls.
      const probe = Promise.resolve().then(() => wc.executeJavaScript("Boolean(document.querySelector('home-assistant')?.hass?.connected)"));
      activityProbe = probe;
      probe.then(connected => {
        if (token === activityEpoch && wc === activeContents() && !connected && activity.snapshot().state !== 'idle') activity.invalidate();
      }, () => { if (token === activityEpoch && activity.snapshot().state !== 'idle') activity.invalidate(); })
        .finally(() => { if (activityProbe === probe) activityProbe = null; });
    }, 250);
    activityMonitor.unref?.();
  }
  const activity = new ActivityBridge({ contents: () => activityContents, visible: () => dashboardVisible() && !!activityContents && activityContents === activeContents() && !activityContents.isDestroyed(), changed: data => { if(window && !window.isDestroyed()) window.webContents.send('ha.view:management:activity-status', data); } });
  let observation = null;
  const releaseGuard = () => { for (const remove of guards.splice(0)) remove(); };
  const snapshot = () => ({ state, selected, message: messages[state], pages });
  function publish(next) { state = next; if (window && !window.isDestroyed()) window.webContents.send('ha.view:management:status', snapshot()); }
  function stop() { epoch++; clearTimeout(timer); clearInterval(monitor); releaseGuard(); for (const remove of cleanup.splice(0)) remove(); activity.invalidate(); }
  function listen(wc, name, callback) { wc.on(name, callback); cleanup.push(() => wc.removeListener(name, callback)); }
  async function open(id) {
    if (disposed) throw new Error('Management controller disposed');
    stop(); selected = id;
    const w = getWebview();
    if (!pages.some(page => page.id === id)) { publish('error'); return snapshot(); }
    if (!dashboardVisible() || !(w?.viewActive > 0)) { publish('hidden'); return snapshot(); }
    const wc = w.views?.[w.viewActive]?.webContents;
    if (!wc || wc.isDestroyed()) { publish('error'); return snapshot(); }
    let dest;
    try { dest = target(id, w.viewUrls?.[w.viewActive], wc.getURL()); }
    catch (_) { publish('error'); return snapshot(); }
    if (!dest.url) { publish('guidance'); return snapshot(); }
    const token = epoch;
    const valid = () => token === epoch && !wc.isDestroyed();
    function route(url, code) {
      if (!valid()) return;
      let current; try { current = new URL(url); } catch (_) { publish('error'); stop(); return; }
      if (current.origin !== dest.origin) { publish('away'); stop(); }
      else if (code === 403) publish('denied');
      else if (code === 401 || /^\/(auth|login)(\/|$)/.test(current.pathname)) publish('login');
      else if (code >= 400) publish('unavailable');
      else if (current.pathname === dest.page.path) publish('route-loaded');
      else { publish('away'); stop(); }
    }
    async function observe() {
      if (!valid() || ['denied', 'unavailable', 'error'].includes(state)) return;
      route(wc.getURL());
      if (!valid() || observation || !['route-loaded', 'page-present'].includes(state)) return;
      try {
        // Only public DOM element names: no HA objects, storage, forms or entity data.
        const pending = wc.executeJavaScript(`(() => { let gate = '', present = false; function visit(root) { for (const el of root.querySelectorAll('*')) { if (['ha-auth-flow','ha-login-form'].includes(el.localName)) gate = 'login'; else if (['ha-panel-not-found','ha-config-error','ha-card-error'].includes(el.localName) && gate !== 'login') gate = 'unavailable'; if (el.localName === ${JSON.stringify(dest.page.tag)}) present = true; if (el.shadowRoot) visit(el.shadowRoot); } } visit(document); return gate || (present ? 'page-present' : 'route-loaded'); })()`);
        // Keep a single read outstanding even after timeout: a hung renderer must not accumulate reads.
        observation = pending;
        pending.then(() => { if (observation === pending) observation = null; }, () => { if (observation === pending) observation = null; });
        let deadline;
        const timeout = new Promise(resolve => { deadline = setTimeout(() => resolve(null), 1500); });
        let result;
        try { result = await Promise.race([pending, timeout]); } finally { clearTimeout(deadline); }
        if (valid() && wc.getURL() === dest.url) {
          if (result === null) { publish('unavailable'); stop(); }
          else publish(result);
        }
      } catch (_) { if (valid()) publish('unavailable'); }
    }
    const guard = (event, details) => {
      try { const url = new URL(typeof details === 'string' ? details : details.url); if (url.origin === dest.origin && !url.username && !url.password) return; } catch (_) {}
      event.preventDefault(); publish('unavailable'); stop();
    };
    for (const name of ['will-navigate', 'will-redirect']) { wc.on(name, guard); guards.push(() => wc.removeListener(name, guard)); }
    listen(wc, 'did-navigate', (_event, url, code) => { releaseGuard(); activity.invalidate(); route(url, code); });
    listen(wc, 'did-navigate-in-page', (_event, url, main) => { if (main) { activity.invalidate(); route(url); void observe(); } });
    listen(wc, 'did-finish-load', () => { clearTimeout(timer); releaseGuard(); void observe(); });
    listen(wc, 'did-fail-load', (_event, code, _description, _url, main) => { if (main && code !== -3) { publish('unavailable'); stop(); } });
    listen(wc, 'destroyed', () => { publish('away'); stop(); });
    monitor = setInterval(() => {
      const current = getWebview();
      if (!dashboardVisible() || current?.views?.[current.viewActive]?.webContents !== wc || wc.isDestroyed()) { publish('away'); stop(); }
      else if (['route-loaded', 'page-present'].includes(state)) void observe();
    }, 500);
    timer = setTimeout(() => { publish('unavailable'); stop(); }, 30000);
    publish('loading');
    try { await wc.loadURL(dest.url); if (valid()) await observe(); }
    catch (_) { if (valid()) { publish('unavailable'); stop(); } }
    return snapshot();
  }
  const trusted = event => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted management sender');
  };
  ipcMain.handle('ha.view:management:get', event => { trusted(event); return snapshot(); });
  ipcMain.handle('ha.view:management:activity', (event, hours) => { trusted(event); syncActivity(); return activity.read(hours); });
  ipcMain.handle('ha.view:management:open', (event, id) => { trusted(event); return open(id); });
  const close = () => window?.close();
  const owner = getWebview()?.window; owner?.on?.('closed', close);
  ipcMain.handle('ha.view:management:close', event => { trusted(event); close(); });
  function show() {
    if (disposed || require('./hooks').settingsAvailable?.() === false) return;
    if (window && !window.isDestroyed()) { window.focus(); return; }
    activity.invalidate();
    syncActivity();
    interaction(true);
    window = new BrowserWindow({ title: 'HA View — Native smart-home management access', width: 740, height: 710, parent: getWebview()?.window, modal: true, fullscreenable: false, minimizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'management-preload.js') } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.setMenuBarVisibility?.(false);
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close(); } });
    window.on('closed', () => { window = null; stop(); stopActivityTracking(); interaction(false); });
    trackActivity();
    const created = window;
    created.loadFile(path.join(__dirname, 'management.html')).catch(() => { if (window === created) close(); });
  }
  const click = (event, button) => { if (button?.id === 'native-management' && event.sender === getWebview()?.navigation?.webContents) show(); };
  ipcMain.on('button-click', click);
  const removeMenu = require('./menu').register(electron, 'management', [{ advanced: true, order: 20, label: 'Home Assistant management…', click: show }]);
  return { close, snapshot, open, show, dispose() {
    if (disposed) return; disposed = true; owner?.removeListener?.('closed', close); stop(); stopActivityTracking(); window?.close();
    ipcMain.removeListener('button-click', click);
    for (const name of ['get', 'open', 'activity', 'close']) ipcMain.removeHandler(`ha.view:management:${name}`);
    activity.stop();
    removeMenu();
  } };
}
let controller;
function init() {
  if (controller) return;
  const electron = require('electron'), hooks = require('./hooks');
  controller = install({ electron, getWebview: () => global.WEBVIEW, interaction: hooks.settingsInteraction('management'), dashboardVisible: hooks.managementDashboardVisible });
  electron.app.once('will-quit', () => { controller?.dispose(); controller = null; });
}
module.exports = { close: () => controller?.close(), install, init };
