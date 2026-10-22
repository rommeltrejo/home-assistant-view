/** HA.View isolated Face Settings modal overlay in the existing Electron window. */
'use strict';
const path = require('node:path');
const { WebContentsView, Menu, MenuItem, ipcMain } = require('electron');
const store = require('./day-schedule');
const { FACES } = require('./face-modes');
const { presentationFaces } = require('./face-registry');
function install({ file, schedule, interaction, showFaceNow, parent = global.WEBVIEW?.window, closed = () => {}, allowed = () => true, idleOverride = () => null, changed = () => {}, calendars = async () => ({ status: 'disconnected', calendars: [] }) }) {
  if (!WebContentsView || !Menu || !ipcMain || !parent) return Object.assign(() => {}, { open: () => {}, close: () => {} });
  let view, disposed = false, shown = false, origin, generation = 0;
  const trusted = event => {
    if (!shown || !view || view.webContents.isDestroyed() || event.sender !== view.webContents ||
        event.senderFrame !== view.webContents.mainFrame) throw new Error('Untrusted settings sender');
  };
  const resize = () => {
    if (!view || disposed) return;
    const { width, height } = parent.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  const close = (reason = 'back') => {
    if (!shown) return;
    shown = false;
    generation++;
    view.setVisible(false);
    // Closed native Settings must not retain a renderer receiving late replies.
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
    view.webContents.removeAllListeners();
    if (!view.webContents.isDestroyed()) view.webContents.close();
    view = null;
    interaction(false);
    closed(origin, reason);
  };
  const escape = (event, input) => {
    if (shown && input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); close(); }
  };
  ipcMain.handle('ha.view:day-schedule:calendars', async event => {
    trusted(event);
    const entry = generation, contents = view.webContents;
    const expired = () => disposed || !shown || entry !== generation ||
      !view || view.webContents !== contents || contents.isDestroyed();
    // Authorization is checked before work. Expiry is cancellation, including
    // backend rejection: never deliver an error/payload or retry an old entry.
    const read = async () => {
      try { return await calendars(); }
      catch (error) { if (expired()) return undefined; throw error; }
    };
    let result = await read();
    if (expired()) return undefined;
    // HA snapshot replacement may disconnect a read. Recover only once while
    // this exact authorized native entry remains alive.
    if (result?.status === 'disconnected') {
      result = await read();
      if (expired()) return undefined;
    }
    return result;
  });
  ipcMain.handle('ha.view:day-schedule:get', event => { trusted(event); return { ...store.read(file), idleOverrideMs: idleOverride(), faces: presentationFaces(FACES).map(({ id, label }) => ({ id, label })) }; });
  ipcMain.handle('ha.view:day-schedule:save', (event, config) => { trusted(event); const result = store.write(file, config); schedule.update(result); changed(); return result; });
  ipcMain.handle('ha.view:day-schedule:close', event => { trusted(event); close(); });
  parent.on('resize', resize);
  const parentClosed = () => dispose();
  parent.on('closed', parentClosed);
  const open = (source = 'menu') => {
    if (disposed || !allowed()) return;
    if (shown) { view.webContents.focus(); return; }
    origin = source;
    if (!view) {
      view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'day-schedule-preload.js') } });
      view.setVisible(false);
      view.setBackgroundColor('#00000000');
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      view.webContents.on('will-navigate', e => e.preventDefault());
      view.webContents.on('will-frame-navigate', e => e.preventDefault());
      view.webContents.on('before-input-event', escape);
      parent.contentView.addChildView(view);

    }
    shown = true;
    generation++;
    // Reload saved settings on every fresh entry; Back discards unsaved edits.
    // Completion never reveals the view, so OFF/Back always wins the load race.
    const loadingView = view, loadingEntry = generation;
    view.webContents.loadFile(path.join(__dirname, 'day-schedule.html')).catch(error => {
      if (!disposed && shown && view === loadingView && generation === loadingEntry && !loadingView.webContents.isDestroyed()) { console.error('HA.View schedule load failed:', error.message); close('error'); }
    });
    interaction(true);
    resize();
    view.setVisible(true);
    view.webContents.focus();
  };
  const entries = [{ order: 20, label: 'Automatic faces…', accelerator: 'CmdOrCtrl+Shift+D', click: () => open('menu') }];
  if (showFaceNow) entries.push({ order: 10, label: 'Show a face now…', click: () => {
    if (disposed || !allowed()) return;
    // Release only our own modal before showing the actual face.
    if (shown) close('show-face-now');
    showFaceNow();
  } });
  const removeMenu = require('./menu').register(require('electron'), 'faces', entries);
  const dispose = () => {
    if (disposed) return;
    close('dispose'); disposed = true;
    parent.removeListener('resize', resize); parent.removeListener('closed', parentClosed);
    if (view) {
      if (!parent.isDestroyed()) parent.contentView.removeChildView(view);
      view.webContents.removeAllListeners();
      if (!view.webContents.isDestroyed()) view.webContents.close();
      view = null;
    }
    for (const name of ['get', 'save', 'close', 'calendars']) ipcMain.removeHandler(`ha.view:day-schedule:${name}`);
    removeMenu();
  };
  return Object.assign(dispose, { open, close });
}
module.exports = { install };
