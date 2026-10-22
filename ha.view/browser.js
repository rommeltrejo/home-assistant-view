'use strict';
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { externalURL, geometry } = require('./browser-policy');
const { inspect } = require('./initial-settings');
const { atomicWrite } = require('./startup-settings');
const { BUILTINS, defaults, validateSearch, validateProvider, typedURL } = require('./browser-policy');
const DEFAULT_HOMEPAGE = 'https://duckduckgo.com/';
function createSettings(file) {
  let prior = file ? inspect(file) : { kind: 'missing' };
  let homepage = DEFAULT_HOMEPAGE, search = defaults(), showIcon = true;
  const listeners = new Set();
  let invalid = prior.kind === 'error';
  const enabled = () => !invalid && showIcon;
  if (prior.value) {
    try {
      if (Object.keys(prior.value).some(key => !['homepage', 'search', 'showIcon'].includes(key))) throw new Error();
      if (Object.hasOwn(prior.value, 'showIcon')) { if (typeof prior.value.showIcon !== 'boolean') throw new Error(); showIcon = prior.value.showIcon; }
      if (Object.hasOwn(prior.value, 'search')) search = validateSearch(prior.value.search);
      if (Object.hasOwn(prior.value, 'homepage')) homepage = externalURL(prior.value.homepage, true);
    } catch { invalid = true; homepage = DEFAULT_HOMEPAGE; search = defaults(); showIcon = false; }
  }
  return {
    get homepage() { return homepage; },
    get search() { return structuredClone(search); },
    get showIcon() { return enabled(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    saveShowIcon(value) {
      if (typeof value !== 'boolean' || invalid || !file) throw new Error('Browser visibility cannot be saved.');
      atomicWrite(file, { homepage, search, showIcon: value }, prior);
      prior = inspect(file); showIcon = value;
      for (const listener of listeners) { try { listener(value); } catch { /* Persisted value remains authoritative. */ } }
      return value;
    },
    get error() { return invalid ? 'Browser preferences could not be read. Defaults are in use; nothing was overwritten.' : ''; },
    save(value) {
      const next = externalURL(value, true);
      if (invalid || !file) throw new Error('Browser preferences cannot be saved.');
      atomicWrite(file, { homepage: next, search, showIcon }, prior);
      prior = inspect(file); homepage = next;
      return homepage;
    },
    saveSearch(action, value) {
      const next = structuredClone(search);
      if (action === 'search-enabled') { if (typeof value !== 'boolean') throw new Error('Invalid toggle'); next.enabled = value; }
      else if (action === 'search-provider') next.provider = value;
      else if (action === 'search-add') {
        const provider = validateProvider({ ...value, id: `custom-${randomUUID()}` });
        next.customProviders.push(provider);
      } else if (action === 'search-remove') {
        if (!next.customProviders.some(p => p.id === value)) throw new Error('Cannot remove provider');
        next.customProviders = next.customProviders.filter(p => p.id !== value);
        if (next.provider === value) next.provider = 'duckduckgo';
      } else throw new Error('Invalid search action');
      const validated = validateSearch(next);
      if (invalid || !file) throw new Error('Browser preferences cannot be saved.');
      atomicWrite(file, { homepage, search: validated, showIcon }, prior);
      prior = inspect(file); search = validated;
      return this.search;
    }
  };
}
// Runs in an isolated world with DOM access only: no preload, Node or IPC bridge.
// A per-page secret authenticates the console report; page scripts cannot read this world.
function observeGestures(token) {
  if (globalThis.__haViewGestureCleanup) globalThis.__haViewGestureCleanup();
  let touch = null, wheel = null;
  const listeners = [];
  const listen = (name, fn) => { document.addEventListener(name, fn, { passive: true, capture: true }); listeners.push([name, fn]); };
  const eligible = target => {
    for (let el = target instanceof Element ? target : target?.parentElement; el; el = el.parentElement) {
      if (el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"]')) return false;
      if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return false;
    }
    return true;
  };
  const report = dx => console.debug(token + (dx > 0 ? ':back' : ':forward'));
  listen('touchstart', e => { wheel = null; const t = e.touches[0]; touch = e.touches.length === 1 && eligible(e.target) ? { x: t.clientX, y: t.clientY, time: performance.now(), bad: false } : null; });
  listen('touchmove', e => { if (touch && (e.touches.length !== 1 || Math.abs(e.touches[0].clientY - touch.y) > 24)) touch.bad = true; });
  listen('touchcancel', () => { touch = null; });
  listen('touchend', e => {
    const start = touch; touch = null;
    if (!start || start.bad || e.touches.length || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - start.x, dy = e.changedTouches[0].clientY - start.y;
    if (performance.now() - start.time <= 700 && Math.abs(dx) >= 100 && Math.abs(dy) <= 24 && Math.abs(dx) >= Math.abs(dy) * 5) report(dx);
  });
  listen('wheel', e => {
    touch = null;
    const now = performance.now();
    if (!wheel || now - wheel.last > 180) wheel = { x: 0, y: 0, last: now, bad: false, done: false, sign: Math.sign(e.deltaX) };
    wheel.last = now;
    if (e.deltaMode !== 0 || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !eligible(e.target) || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY) || Math.abs(e.deltaY) > 4 || Math.abs(e.deltaX) < Math.abs(e.deltaY) * 5 || (e.deltaX && Math.sign(e.deltaX) !== wheel.sign)) wheel.bad = true;
    wheel.x += e.deltaX; wheel.y += Math.abs(e.deltaY);
    if (!wheel.bad && !wheel.done && Math.abs(wheel.x) >= 160 && wheel.y <= 16) { wheel.done = true; report(-wheel.x); }
  });
  globalThis.__haViewGestureCleanup = () => { for (const [name, fn] of listeners) document.removeEventListener(name, fn, true); touch = wheel = null; };
}

function install({ electron = require('electron'), parent, allowed, interaction, off = () => false, wakeBlocked = () => false, settings }) {
  const { WebContentsView, ipcMain, session } = electron;
  // Older test doubles do not implement native browser IPC/session support.
  if (!session?.fromPartition || !ipcMain?.handle) return Object.assign(() => {}, { open() {}, close() {}, sync() {} });
  let disposed = false, shown = false, shell, page, revision = 0, suspended = false, error = '';
  const preferences = settings || createSettings(electron.app?.getPath ? path.join(electron.app.getPath('userData'), 'browser-settings.json') : null);
  let settingsOpen = false, clearing = false, clearTask = null;
  const enabled = () => preferences.showIcon !== false;
  const browserSession = session.fromPartition(`ha.view-browser-${randomUUID()}`);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on('will-download', event => event.preventDefault());
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    let cancel = false; try { externalURL(details.url); } catch { cancel = true; }
    callback({ cancel });
  });
  const create = (file, isolated = false) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...(isolated ? { session: browserSession } : { preload: path.join(__dirname, 'browser-preload.js') }) } });
    view.setBackgroundColor(isolated ? '#ffffff' : '#00000000');
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('before-input-event', (event, input) => { if (!enabled() || off() || wakeBlocked()) { event.preventDefault(); return; } if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close(); } });
    view.webContents.on('before-mouse-event', event => { if (!enabled() || off() || wakeBlocked()) event.preventDefault(); });
    if (file) {
      view.webContents.on('will-navigate', event => event.preventDefault());
      view.webContents.on('will-frame-navigate', event => event.preventDefault());
      view.webContents.loadFile(path.join(__dirname, file)).catch(() => { if (view === shell) close(); });
    } else {
      const navigation = (event, url) => { try { externalURL(url || event.url); } catch { event.preventDefault(); } };
      for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) view.webContents.on(name, navigation);
    }
    parent.contentView.addChildView(view);
    return view;
  };
  const launcher = create('browser-launcher.html');
  const bounds = () => geometry(parent.getContentBounds().width, parent.getContentBounds().height);
  const sync = () => {
    if (disposed || parent.isDestroyed()) return;
    // Re-adding an existing child raises it without recreating its renderer.
    if (shown) { parent.contentView.addChildView(shell); if (page) parent.contentView.addChildView(page); }
    else parent.contentView.addChildView(launcher);
    launcher.setBounds(bounds().launcher); launcher.setVisible(!shown && enabled() && allowed() && !off() && !suspended && !wakeBlocked());
    if (shown) { shell.setBounds(bounds().shell); if (page) { page.setBounds(bounds().page); page.setVisible(!settingsOpen && !clearing); } }
  };
  const update = () => {
    if (!shown || !shell || shell.webContents.isDestroyed()) return;
    let url = ''; try { url = externalURL(page?.webContents.getURL()); } catch {}
    shell.webContents.send('ha.view:browser-state', { url, back: !clearing && !!page?.webContents.navigationHistory.canGoBack(), forward: !clearing && !!page?.webContents.navigationHistory.canGoForward(), loading: !!page?.webContents.isLoading(), error, homepage: preferences.homepage, search: preferences.search || defaults(), builtins: BUILTINS, showIcon: enabled(), settingsOpen, clearing });
  };
  const destroy = view => { if (!view) return; if (!parent.isDestroyed()) parent.contentView.removeChildView(view); if (!view.webContents.isDestroyed()) view.webContents.close(); };
  const close = () => {
    if (!shown) return;
    shown = false; revision++; destroy(page); destroy(shell); page = shell = null;
    interaction(false); sync();
  };
  let lastGesture = -Infinity;
  const gesture = direction => {
    // allowed() is a launcher admission gate: hooks disables it on interaction(true).
    // Once open, ownership and independent lifecycle gates govern navigation.
    if (disposed || !enabled() || !shown || !shell || shell.webContents.isDestroyed() || settingsOpen || clearing || suspended || off() || wakeBlocked() || !page || page.webContents.isDestroyed()) return;
    const now = performance.now();
    if (now - lastGesture < 900 || page.webContents.isLoading()) return;
    const history = page.webContents.navigationHistory;
    if (direction === 'back' && history.canGoBack()) { lastGesture = now; history.goBack(); }
    else if (direction === 'forward' && history.canGoForward()) { lastGesture = now; history.goForward(); }
  };
  const nativeSwipe = (_event, direction) => {
    if ((electron.platform || process.platform) === 'darwin') gesture(direction === 'right' ? 'back' : direction === 'left' ? 'forward' : '');
  };
  parent.on('swipe', nativeSwipe);
  const createPage = () => {
    const view = create(null, true);
    const token = `ha.view-gesture-${randomUUID()}`;
    view.webContents.on('console-message', details => {
      if (page !== view || details?.frame !== view.webContents.mainFrame) return;
      if (details.message === `${token}:back`) gesture('back');
      else if (details.message === `${token}:forward`) gesture('forward');
    });
    view.webContents.on('did-finish-load', () => {
      if (page !== view || view.webContents.isDestroyed()) return;
      view.webContents.executeJavaScriptInIsolatedWorld?.(1004, [{ code: `(${observeGestures.toString()})(${JSON.stringify(token)})` }]).catch(() => {});
    });
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) view.webContents.on(name, () => { if (page === view) update(); });
    view.webContents.on('did-fail-load', (_event, code) => { if (page === view && code !== -3) { error = 'Website could not be loaded.'; update(); } });
    view.webContents.on('render-process-gone', () => { if (page === view) { error = 'Website stopped responding. Reload or enter another address.'; update(); } });
    return view;
  };
  const loadHomepage = () => {
    const entry = revision, contents = page.webContents;
    contents.loadURL(preferences.homepage).catch(() => { if (shown && entry === revision && page?.webContents === contents) { error = 'Homepage could not be loaded.'; update(); } });
  };
  const open = () => {
    if (disposed || shown || !enabled() || !allowed() || off() || suspended || wakeBlocked()) return;
    shown = true; revision++; error = preferences.error; settingsOpen = false; interaction(true);
    shell = create('browser.html'); page = clearing ? null : createPage();
    if (page) loadHomepage();
    shell.webContents.on('did-finish-load', update);
    sync(); shell.setVisible(true); shell.webContents.focus();
  };
  const handler = async (event, action, value) => {
    const from = view => view && !view.webContents.isDestroyed() && event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame;
    if (disposed || !enabled() || off() || suspended || wakeBlocked()) throw new Error('Browser unavailable');
    if (action === 'open') { if (!from(launcher)) throw new Error('Untrusted browser sender'); open(); return; }
    if (!shown || !from(shell)) throw new Error('Untrusted browser sender');
    if (action === 'edit') {
      if (clearing || !['selectAll', 'copy', 'paste', 'cut', 'undo'].includes(value)) throw new Error('Invalid browser edit');
      shell.webContents[value](); return;
    }
    if (action === 'close') { close(); return; }
    if (action === 'settings') {
      if (typeof value !== 'boolean') throw new Error('Invalid settings action');
      settingsOpen = value; sync(); update(); return;
    }
    if (action === 'show-icon') {
      if (!settingsOpen || clearing || typeof value !== 'boolean') throw new Error('Open browser settings first');
      try { preferences.saveShowIcon(value); error = ''; }
      catch { error = 'Browser visibility was not saved. Check preference file access.'; update(); return { ok: false, error }; }
      return { ok: true };
    }
    if (['search-enabled', 'search-provider', 'search-add', 'search-remove'].includes(action)) {
      if (!settingsOpen || clearing) throw new Error('Open browser settings first');
      try { preferences.saveSearch(action, value); error = ''; }
      catch { error = 'Search settings were not saved. Use a unique name (up to 60 characters) and an HTTP(S) template with one {query} in its path or query; check preference file access.'; }
      update(); return { ok: !error, error };
    }
    if (action === 'homepage') {
      try { preferences.save(value); error = ''; } catch { error = 'Homepage was not saved. Use a valid website address without credentials; check browser preference file access.'; }
      update(); return;
    }
    if (action === 'clear') {
      if (value !== true || !settingsOpen) throw new Error('Confirm clearing in browser settings');
      if (clearTask) return clearTask;
      clearing = true; revision++; destroy(page); page = null; error = ''; update();
      clearTask = (async () => {
        try {
          // The page is gone before clearing, so scripts cannot repopulate data.
          // All operations target only this random, non-persistent partition.
          const results = await Promise.allSettled([browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache()]);
          if (results.some(result => result.status === 'rejected')) throw new Error();
          if (shown && !disposed) error = 'Browser data cleared for this app run. Homepage kept.';
        } catch { if (shown && !disposed) error = 'Some browser data could not be cleared. Try again.'; }
        finally {
          clearing = false; clearTask = null;
          if (shown && !disposed && enabled()) { page = createPage(); loadHomepage(); sync(); update(); }
        }
      })();
      return clearTask;
    }
    if (clearing || !page) throw new Error('Browser data is being cleared');
    if (!['navigate', 'back', 'forward', 'reload'].includes(action)) throw new Error('Unknown browser action');
    error = '';
    if (action === 'navigate') {
      let url; try { url = typedURL(value, preferences.search || defaults()); } catch { error = 'Enter a website address such as duckduckgo.com, or an http:// or https:// URL without credentials.'; update(); return; }
      const entry = revision, contents = page.webContents;
      page.setVisible(!settingsOpen);
      try { await contents.loadURL(url); } catch { if (shown && entry === revision) { error = 'Website could not be loaded.'; update(); } }
    } else {
      const history = page.webContents.navigationHistory;
      if (action === 'back' && history.canGoBack()) history.goBack();
      if (action === 'forward' && history.canGoForward()) history.goForward();
      if (action === 'reload' && /^https?:/.test(page.webContents.getURL())) page.webContents.reload();
    }
  };
  ipcMain.handle('ha.view:browser', handler);
  parent.on('resize', sync);
  const dispose = () => { if (disposed) return; close(); disposed = true; unsubscribe?.(); destroy(launcher); parent.removeListener('resize', sync); parent.removeListener('swipe', nativeSwipe); parent.removeListener('closed', dispose); ipcMain.removeHandler('ha.view:browser'); browserSession.clearStorageData().catch(() => {}); };
  const unsubscribe = preferences.subscribe?.(value => { if (!value) close(); sync(); update(); });
  parent.on('closed', dispose); sync();
  return Object.assign(dispose, { open, close, sync, power: value => { suspended = value; if (value) close(); sync(); } });
}
module.exports = { install, createSettings, DEFAULT_HOMEPAGE, observeGestures };
