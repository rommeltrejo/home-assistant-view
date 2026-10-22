/** HA.View native camera dashboard access; uses the existing HA view/session only. */
'use strict';
const path = require('node:path');
const config = require('./camera-config');
const messages = Object.freeze({
  unconfigured: 'No camera dashboard configured. Enter the path of an existing Home Assistant camera dashboard. HA View opens only the dashboard you configure.',
  configured: 'Ready to open your configured dashboard. Camera entities and live feeds have not been verified.',
  loading: 'Loading the configured camera dashboard…',
  login: 'Sign in using the native Home Assistant page in the dashboard. HA View does not collect credentials.',
  unavailable: 'Camera dashboard unavailable. Check the backend connection and that this dashboard path exists in Home Assistant.',
  hidden: 'Return to the visible Home Assistant dashboard first, then open Cameras again. HA View will not navigate a hidden dashboard.',
  error: 'Camera dashboard could not be opened. Check the saved path and backend, then retry.',
  opened: 'Native dashboard route loaded. This does not verify camera entities, cards or live feeds.',
  away: 'The native view is on another route. Open the camera dashboard when ready.'
});
function install({ electron, file, getWebview, interaction = () => {}, dashboardVisible = () => getWebview()?.viewActive > 0 }) {
  const { BrowserWindow, Menu, MenuItem, ipcMain } = electron;
  let generation = 0, disposed = false;
  let window, monitor, state = 'unconfigured', active, target, timer;
  const disposers = [];
  const guards = [];
  const backend = () => { const w = getWebview(); return w?.viewUrls?.[w.viewActive > 0 ? w.viewActive : 1]; };
  const snapshot = () => {
    const data = config.read(file);
    try { const saved = config.configured(data, backend()); if (!saved) state = 'unconfigured'; else if (state === 'unconfigured') state = 'configured'; }
    catch (_) { state = 'error'; }
    return { path: data.path, state, message: messages[state] };
  };
  const publish = next => { state = next; if (window && !window.isDestroyed()) window.webContents.send('ha.view:camera:status', snapshot()); };
  const releaseGuard = () => { for (const dispose of guards.splice(0)) dispose(); };
  const stop = () => { generation++; clearTimeout(timer); clearInterval(monitor); releaseGuard(); for (const dispose of disposers.splice(0)) dispose(); active = null; target = null; };
  function listen(wc, name, handler) { wc.on(name, handler); disposers.push(() => wc.removeListener(name, handler)); }
  function route(url, code) {
    if (!target) return;
    let current;
    try { current = new URL(url); } catch (_) { publish('error'); return; }
    if (current.origin !== target.origin) { publish('away'); stop(); return; }
    if (code === 401 || code === 403 || /^\/(auth|login)(\/|$)/.test(current.pathname)) publish('login');
    else if (code >= 400) publish('unavailable');
    else if (current.pathname + current.hash === target.path) publish('opened');
    else { publish('away'); stop(); }
  }
  async function openDashboard() {
    const w = getWebview();
    stop();
    try {
      target = config.configured(config.read(file), backend());
      if (!target) { publish('unconfigured'); return snapshot(); }
      // Never force a switch out of an ambient face or manufacture another HA view.
      if (!dashboardVisible()) { publish('hidden'); stop(); return snapshot(); }
      active = w?.viewActive > 0 ? w.views[w.viewActive]?.webContents : null;
      if (!active || active.isDestroyed()) { publish('error'); return snapshot(); }
      const wc = active;
      const epoch = generation;
      listen(wc, 'did-start-loading', () => publish('loading'));
      listen(wc, 'did-navigate', (_e, url, code) => { releaseGuard(); route(url, code); });
      listen(wc, 'did-navigate-in-page', (_e, url, main) => { if (main) route(url); });
      listen(wc, 'did-finish-load', async () => {
        clearTimeout(timer); releaseGuard();
        if (!['unavailable', 'error'].includes(state)) route(wc.getURL());
        // Observe only native public UI gate/error elements, never form values, HA objects or storage.
        if (state !== 'opened') return;
        try {
          const category = await wc.executeJavaScript(`(() => {
            let result = ''; function visit(root) {
              for (const el of root.querySelectorAll('*')) {
                if (['ha-auth-flow', 'ha-login-form'].includes(el.localName)) result = 'login';
                if (['ha-panel-not-found', 'ha-card-error'].includes(el.localName) ||
                    (['h1', 'h2', 'p', 'ha-alert'].includes(el.localName) && /^(dashboard|view) not found[.!]?$/i.test(el.textContent.trim()))) {
                  if (result !== 'login') result = 'unavailable';
                }
                if (el.shadowRoot) visit(el.shadowRoot);
              }
            } visit(document); return result;
          })()`);
          if (generation === epoch && active === wc && ['login', 'unavailable'].includes(category)) publish(category);
        } catch (_) { /* No secrets or page diagnostics are logged. */ }
      });
      listen(wc, 'did-fail-load', (_e, code, _text, _url, main) => { if (main && code !== -3) { clearTimeout(timer); releaseGuard(); publish('unavailable'); } });
      // Restrict only this explicitly opened route's navigation; no global backend interception.
      const guard = (event, url) => {
        const value = typeof url === 'string' ? url : url?.url;
        try { const next = new URL(value); if (next.origin === target.origin && !next.username && !next.password) return; } catch (_) {}
        event.preventDefault(); publish('unavailable');
      };
      // Guard only the initial requested load/redirect chain, not later user auth or navigation.
      for (const name of ['will-navigate', 'will-redirect']) {
        wc.on(name, guard); guards.push(() => wc.removeListener(name, guard));
      }
      monitor = setInterval(() => {
        const current = getWebview();
        if (wc.isDestroyed() || current?.views[current.viewActive]?.webContents !== wc) { publish('away'); stop(); }
      }, 100);
      listen(wc, 'destroyed', () => { publish('away'); stop(); });
      publish('loading');
      timer = setTimeout(() => { publish('unavailable'); stop(); }, 30000);
      await wc.loadURL(target.url);
    } catch (_) { stop(); if (state !== 'unavailable') publish('error'); }
    return snapshot();
  }
  const trusted = event => { if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted camera settings sender'); };
  ipcMain.handle('ha.view:camera:get', event => { trusted(event); return snapshot(); });
  ipcMain.handle('ha.view:camera:save', (event, input) => {
    trusted(event);
    try { config.write(file, input, backend()); stop(); publish(config.read(file).path ? 'configured' : 'unconfigured'); return snapshot(); }
    catch (error) { return { ...snapshot(), validationError: error.message }; }
  });
  ipcMain.handle('ha.view:camera:open', event => { trusted(event); return openDashboard(); });
  const close = () => window?.close();
  const owner = getWebview()?.window; owner?.on?.('closed', close);
  ipcMain.handle('ha.view:camera:close', event => { trusted(event); close(); });
  function show() {
    if (disposed || require('./hooks').settingsAvailable?.() === false) return;
    if (window && !window.isDestroyed()) { window.focus(); return; }
    interaction(true);
    window = new BrowserWindow({ title: 'HA View — Cameras', width: 640, height: 510, parent: getWebview()?.window, modal: true, fullscreenable: false, minimizable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'camera-preload.js') } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.setMenuBarVisibility?.(false);
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close(); } });
    window.on('closed', () => { window = null; interaction(false); });
    const created = window;
    created.loadFile(path.join(__dirname, 'camera-settings.html')).catch(() => { if (window === created) close(); });
  }
  const click = (event, button) => { if (button?.id === 'camera-dashboard' && event.sender === getWebview()?.navigation?.webContents) show(); };
  ipcMain.on('button-click', click);
  const removeMenu = require('./menu').register(electron, 'cameras', [{ advanced: true, order: 30, label: 'Camera Dashboard…', accelerator: 'CmdOrCtrl+Shift+K', click: show }]);
  return { close, snapshot, openDashboard, show, dispose() {
    if (disposed) return; disposed = true; owner?.removeListener?.('closed', close); stop(); window?.close(); ipcMain.removeListener('button-click', click);
    for (const name of ['get', 'save', 'open', 'close']) ipcMain.removeHandler(`ha.view:camera:${name}`);
    removeMenu();
  } };
}
let controller;
function init() {
  if (controller) return;
  const electron = require('electron');
  controller = install({ electron, file: path.join(electron.app.getPath('userData'), 'camera-dashboard.json'), getWebview: () => global.WEBVIEW,
    interaction: require('./hooks').settingsInteraction('camera'), dashboardVisible: require('./hooks').cameraDashboardVisible });
  electron.app.once('will-quit', () => { controller?.dispose(); controller = null; });
}
module.exports = { close: () => controller?.close(), install, init, messages };
