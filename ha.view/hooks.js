/**
 * HA.View idle clock face.
 *
 * The upstream webview remains responsible for display power and waking a
 * sleeping display. This module replaces idle presentation, using the upstream view idle deadline.
 */
const path = require("path");
const { WebContentsView, app, ipcMain } = require("electron");
const { chooserDescriptors, presentationFaces } = require('./face-registry');
const chooserIndex = mode => Math.max(1, chooserFaces.findIndex(face => face.id === mode) + 1);
const chooserMode = index => chooserFaces[index - 1]?.id || 'clock2';
const { FaceChanger } = require("./face-changer");
const store = require("./face-changer-store");
const faceModes = require("./face-modes");
const chooserFaces = presentationFaces(faceModes.FACES);
const calendarRuntime = new (require("./calendar-runtime").CalendarRuntime)();
const calendarMode = () => ["calendar", "upcoming"].includes(presentationMode());
const layoutStore = require("./layout-store");
const layoutRuntime = new (require("./layout-runtime").LayoutRuntime)();
let layoutFile, disposeLayoutEditor;
const dayStore = require("./day-schedule");
const contextStore = require('./context-policy');
let contextPolicy, contextBridge, disposeContextSettings, disposeSystemSettings;
const openSettings = new Set();
const presentationMode = () => contextPolicy?.mode(daySchedule?.mode()) || daySchedule?.mode() || faceModes.fromIndex(selectedFace);
let daySchedule, disposeDaySettings, settingsOpen = false, dashboardPress = false, activityListeners = [];
let calendarAvailability, weatherAvailability, weatherProbeTimer;
const { WeatherAvailability, TOAST: WEATHER_TOAST } = require('./weather-availability');
const weatherRuntime = new (require('./weather-runtime').WeatherRuntime)({ onUnavailable: () => weatherAvailability?.setAvailable(false) });
const weatherToast = () => {
  const target = changer?.picking ? clockView?.webContents : state()?.views[state()?.viewActive]?.webContents;
  if (!target || target.isDestroyed?.()) return;
  target.executeJavaScript(`(() => { if (window.showToast) { window.showToast(${JSON.stringify(WEATHER_TOAST)}); return; } const old=document.getElementById('ha-view-weather-toast');old?.remove();const t=document.createElement('div');t.id='ha-view-weather-toast';t.textContent=${JSON.stringify(WEATHER_TOAST)};t.setAttribute('role','status');t.style.cssText='position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#202631;color:white;padding:14px 22px;border-radius:14px;font:16px system-ui;z-index:2147483647';document.body.append(t);setTimeout(()=>t.remove(),3500); })()`).catch(() => {});
};
let disposeBrowser, browserOpen = false;
const effectiveHidden = () => weatherAvailability?.hidden(calendarAvailability?.hidden(hiddenFaces) || hiddenFaces) || hiddenFaces;
const availableMode = mode => calendarAvailability?.blocked(mode) || weatherAvailability?.blocked(mode) ? "dashboard" : mode;
const syncCalendarAvailability = () => {
  daySchedule?.setHidden(effectiveHidden());
  // Daily/manual choices do not change when availability changes. Reapply only
  // at the existing idle boundary, using the same interaction/power guards.
  if (initialized && daySchedule && ['calendar', 'upcoming', 'weather'].includes(presentationMode())) applyDayPresentation();
  const contents = clockView?.webContents, token = transition;
  if (changer?.picking && contents?.getURL?.().endsWith('/face-changer.html')) {
    // Only this picker generation may receive asynchronous availability updates.
    Promise.resolve().then(() => {
      if (token !== transition || !changer?.picking || contents !== clockView?.webContents) return;
      return contents.executeJavaScript(`window.setHiddenFaces?.(${JSON.stringify(effectiveHidden())})`);
    }).catch(() => {});
  }
};
let pickerRects = null, pickerLayout = 0, hiddenFaces = [], presentedMode = null, pickerMode = null;
let windowBlur, changer, selectedFace = 2, selectionFile, touchListener, touchUntil = 0;

const DEFAULT_IDLE_MS = dayStore.DEFAULT.idleMs;

let frontendAuth = null;
const authenticated = () => frontendAuth?.ready === true;
let lifecycle = null;
let clockView = null;
let initialized = false;
let faceVisible = false;
let clockIdle = false;
let loading = null;
let transition = 0;
let wakeRelease = false;
let lastActivity = Date.now();

const state = () => global.WEBVIEW;

const displayIsOff = (webview = state()) =>
  Boolean(webview && webview.tracker.display.off > webview.tracker.display.on);

const idleOverride = () => {
  const configured = Number(global.ARGS?.ha_view_idle_ms);
  return Number.isFinite(configured) && configured >= 10 ? configured : null;
};
const idleDelay = () => idleOverride() ?? daySchedule?.config.idleMs ?? DEFAULT_IDLE_MS;

const clockFaceFile = () =>
  faceModes.definition(presentationMode()).file;

const faceBounds = () => {
  const webview = state();
  if (!webview) return null;
  const { width, height } = webview.window.getBounds();
  const header = webview.tracker.header.enabled ? webview.header.getBounds().height : 0;
  const navigation = webview.tracker.navigation.enabled ? webview.navigation.getBounds().height : 0;
  return { x: 0, y: header, width, height: Math.max(0, height - header - navigation) };
};

const clearIdleTimer = () => {
  const tracker = state()?.tracker.view;
  if (tracker?.timer) clearTimeout(tracker.timer);
  if (tracker) tracker.timer = null;
};

const focusDashboard = () => {
  const webview = state();
  if (!webview) return;
  webview.views[webview.viewActive]?.webContents.focus();
};

const showDashboard = () => {
  const webview = state();
  if (!webview || !clockView) return;
  daySchedule?.setActive(false);
  calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop();
  if (changer?.picking) calendarAvailability?.invalidate();
  changer?.reset();
  if (changer) changer.picking = false;
  transition += 1;
  faceVisible = false;
  clockIdle = false;
  clockView.setVisible(false);
  clockView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  disposeBrowser?.sync();
  webview.tracker.view.idle = false;
  webview.views.forEach((view, index) => view.setVisible(!displayIsOff(webview) && index > 0 && index === webview.viewActive));
};

const scheduleIdle = () => {
  clearIdleTimer();
  const webview = state();
  if (!authenticated() || !initialized || !webview || faceVisible || settingsOpen || dashboardPress || displayIsOff(webview)) return;
  lifecycle?.idleView(true, Math.max(0, idleDelay() - (Date.now() - lastActivity)));
};

// The upstream timer owns the deadline; policy may inhibit it during interaction.
const idleDeadline = () => {
  if (!initialized) return true;
  if (!authenticated() || settingsOpen || dashboardPress || changer?.picking || changer?.press || displayIsOff()) return false;
  if (Date.now() - lastActivity < idleDelay()) { scheduleIdle(); return false; }
  calendarAvailability?.refresh();
  clockIdle = true;
  contextBridge?.refresh();
  return true;
};

// Called on boundaries and the existing idle deadline, never forced navigation.
const applyDayPresentation = () => {
  if (!authenticated() || !initialized || settingsOpen || dashboardPress || changer?.picking || changer?.press || displayIsOff() || Date.now() - lastActivity < idleDelay()) return false;
  const webview = state();
  if (!webview) return false;
  const mode = availableMode(presentationMode());
  if (clockIdle && ((mode === 'dashboard' && !faceVisible) || (mode !== 'dashboard' && faceVisible && clockView.webContents.getURL?.().endsWith('/' + clockFaceFile())))) { daySchedule?.setActive(mode !== 'dashboard'); return true; }
  if (mode === 'dashboard') {
    showDashboard();
    clockIdle = true; // Idle policy remains live even though dashboard is visible.
    webview.tracker.view.idle = true;
  } else {
    clockIdle = true;
    webview.tracker.view.idle = true;
    showClock();
  }
  return true;
};

const showClock = async (restoreMode = null) => {
  const webview = state();
  if (!authenticated() || !initialized || !webview || !clockView || (!faceVisible && !webview.tracker.view.idle)) return;
  const admission = transition, auth = frontendAuth;
  daySchedule?.setActive(false);
  if (!await auth.refresh() || admission !== transition || auth !== frontendAuth || !authenticated()) return;
  calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop();
  const mode = availableMode(restoreMode || presentationMode());
  if (mode === 'dashboard') { showDashboard(); clockIdle = true; webview.tracker.view.idle = true; return; }
  faceVisible = true;
  disposeBrowser?.sync(); // Hide the launcher before asynchronous face loading.
  const isLayoutCalendar = mode === 'layout' && layoutFile && layoutStore.read(layoutFile).cards.some(card => ['calendar', 'upcoming'].includes(card.type));
  const isCalendar = ['calendar', 'upcoming'].includes(mode);
  const currentTransition = ++transition;
  const requestedFile = path.join(global.APP.path, "ha.view", "faces", faceModes.definition(mode).file);
  try {
    if (!loading) {
      loading = clockView.webContents.loadFile(
        requestedFile,
      ).finally(() => { loading = null; });
    }
    await loading;
    if (currentTransition === transition && clockView.webContents.getURL && clockView.webContents.getURL() !== require("node:url").pathToFileURL(requestedFile).href) await clockView.webContents.loadFile(requestedFile);
  } catch (error) {
    console.error("HA.View clock face load failed:", error.message);
    if (currentTransition === transition) showDashboard();
    return;
  }
  if (!authenticated() || settingsOpen || currentTransition !== transition || (!webview.tracker.view.idle && !faceVisible) || displayIsOff(webview)) return;
  if (isCalendar) {
    const nativeView = webview.views[webview.viewActive];
    if (nativeView) {
      calendarRuntime.start(nativeView.webContents, mode, daySchedule?.config.calendarEntities || []);
      webview.views.forEach(view => view.setVisible(view === nativeView));
    }
  } else webview.views.forEach((view, index) => view.setVisible(Boolean(isLayoutCalendar) && index === webview.viewActive));
  if (mode === 'weather') weatherRuntime.start(webview.views[webview.viewActive]?.webContents, clockView.webContents).catch(() => weatherAvailability?.setAvailable(false));
  if (mode === 'layout' && layoutFile) layoutRuntime.start(clockView.webContents, layoutStore.read(layoutFile), () => state()?.views[state()?.viewActive]?.webContents, daySchedule?.config.calendarEntities || []).catch(error => console.error('HA.View layout render:', error.message));
  const bounds = faceBounds();
  if (bounds) clockView.setBounds(bounds);
  clockView.setBackgroundColor((isCalendar || isLayoutCalendar) ? "#00000000" : "#000000");
  clockView.setVisible(true);
  faceVisible = true;
  presentedMode = mode;
  daySchedule?.setActive(true);
  clockView.webContents.focus();
  disposeBrowser?.sync();
};

const dismissClock = (event) => {
  event?.preventDefault?.();
  lastActivity = Date.now();
  showDashboard();
  focusDashboard();
  scheduleIdle();
};

const renderPicker = async (snapshot = true) => {
  if (!authenticated()) return;
  const admission = transition, auth = frontendAuth;
  if (!await auth.refresh() || admission !== transition || auth !== frontendAuth || !authenticated()) return;
  disposeBrowser?.sync(); // Chooser admission immediately hides the dashboard launcher.
  daySchedule?.setActive(false);
  clockView.setBackgroundColor("#000000");
  calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop();
  state()?.views.forEach(view => view.setVisible(false));
  // Snapshot the completed renderer, not the persisted preference or a newer policy.
  const rendered = faceModes.FACES.find(face => clockView.webContents.getURL?.().endsWith('/' + face.file));
  if (snapshot && rendered) pickerMode = rendered.id;
  pickerMode ||= presentedMode || presentationMode();
  changer.index = chooserIndex(pickerMode);
  pickerRects = null;
  const token = ++transition;
  const catalog = Promise.all([calendarAvailability.refresh(), weatherAvailability.refresh()]);
  try {
    await clockView.webContents.loadFile(path.join(global.APP.path, 'ha.view', 'face-changer.html'));
    if (!authenticated() || settingsOpen || token !== transition || !changer.picking || !faceVisible) return;
    await clockView.webContents.executeJavaScript(`if (!window.initializeChooser(${JSON.stringify(chooserDescriptors(chooserFaces))})) throw new Error("Invalid chooser snapshot");window.setHiddenFaces(${JSON.stringify(effectiveHidden())});window.previewFace(${changer.index});window.setLayoutPreview?.(${JSON.stringify(layoutFile ? layoutStore.read(layoutFile) : layoutStore.DEFAULT)})`);
    await catalog;
    if (!authenticated() || settingsOpen || token !== transition || !changer?.picking || !faceVisible) return;
    await clockView.webContents.executeJavaScript(`window.setHiddenFaces(${JSON.stringify(effectiveHidden())});window.previewFace(${changer.index});window.setLayoutPreview?.(${JSON.stringify(layoutFile ? layoutStore.read(layoutFile) : layoutStore.DEFAULT)})`);
    await updatePickerRects();
  } catch (error) { console.error('HA.View picker load failed:', error.message); if (token === transition) changer.abort(); }
};
// Query each stable control independently; stale loads/resizes cannot restore old hit areas.
const updatePickerRects = async () => {
  const revision = ++pickerLayout, token = transition, contents = clockView?.webContents;
  pickerRects = null;
  const rects = await contents.executeJavaScript(`(()=>{const rects={};for(const id of ['cancel','system','hide']){const r=document.getElementById(id).getBoundingClientRect();rects[id]={x:r.x,y:r.y,width:r.width,height:r.height}}return rects})()`);
  if (revision === pickerLayout && token === transition && changer?.picking && contents === clockView?.webContents) pickerRects = rects;
};
// Read-only native-input readiness; DOM/frame loading alone does not install hit areas.
const pickerReady = () => Boolean(authenticated() && initialized && faceVisible && !settingsOpen &&
  !displayIsOff() && changer?.picking && pickerRects &&
  clockView?.webContents?.getURL?.().endsWith('/face-changer.html'));
const pickerHit = (x, y) => ['cancel', 'schedule', 'system', 'hide'].find(id => {
  const r = pickerRects?.[id];
  return r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
});
const routeFaceInput = (type, x, y) => {
  if (changer.picking && !pickerRects) { changer.reset(); return; }
  const press = changer.press;
  if (changer.picking && type === 'up' && press?.picker && !press.held && !press.moved && Math.hypot(x - press.x, y - press.y) <= 12) {
    const hit = pickerHit(x, y);
    if (hit && hit === pickerHit(press.x, press.y)) {
      if (hit === 'cancel') changer.abort();
      else if (hit === 'hide') {
        changer.reset();
        const id = chooserMode(changer.index);
        if (weatherAvailability.blocked(id)) { weatherToast(); return; }
        if (calendarAvailability.blocked(id)) {
          clockView.webContents.executeJavaScript(`window.showToast(${JSON.stringify(calendarAvailability.toast())})`).catch(() => {});
          return;
        }
        const next = effectiveHidden().includes(id) ? hiddenFaces.filter(face => face !== id) : [...hiddenFaces, id];
        try {
          if (selectionFile) store.writeHidden(selectionFile, next);
          hiddenFaces = next; daySchedule?.setHidden(effectiveHidden());
          clockView.webContents.executeJavaScript(`window.setHiddenFaces(${JSON.stringify(effectiveHidden())})`).catch(() => {});
        } catch (error) { console.error('HA.View hidden face save failed:', error.message); }
      } else {
        changer.reset(); changer.picking = false;
        if (hit === 'system') disposeSystemSettings?.open?.('chooser');
        else disposeDaySettings?.open?.('chooser');
      }
      return;
    }
  }
  // A press begun on a control never becomes a preview selection or swipe.
  if (press?.control || (changer.picking && type === 'up' && pickerHit(x, y))) {
    if (type === 'up' || type === 'cancel') changer.reset();
    else if (Math.hypot(x - press.x, y - press.y) > 12) press.moved = true;
    return;
  }
  if (type === 'down') daySchedule?.setActive(false);
  changer.input(type, x, y);
  if (type === 'down' && changer.picking && changer.press) changer.press.control = pickerHit(x, y);
  if (!changer.press && !changer.picking && faceVisible && !settingsOpen) daySchedule?.setActive(true);
};
const faceInput = (event, mouse) => {
  if (settingsOpen || !faceVisible || displayIsOff()) return;
  event?.preventDefault?.();
  if (Date.now() < touchUntil) return;
  const type = { mouseDown: 'down', mouseUp: 'up', mouseMove: 'move', mouseLeave: 'cancel' }[mouse.type];
  if (!type || ((type === 'down' || type === 'up') && mouse.button !== 'left')) return;
  routeFaceInput(type, mouse.x, mouse.y);
};
// Saved face preference wins over the startup face; both paths share validation.
const resolveInitialFace = (value, file = null) => {
  let mode = 'clock2';
  if (faceModes.FACE_IDS.includes(value)) mode = value;
  else if (typeof value === 'number' || typeof value === 'string') {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= faceModes.FACE_IDS.length) mode = faceModes.fromIndex(index);
  }
  return faceModes.indexOf(file ? store.readMode(file, mode) : mode);
};
const init = (idleLifecycle, scheduleClock = {}) => {
  const webview = state();
  if (initialized || !webview?.window || !webview.views?.length) return false;
  lifecycle = idleLifecycle;
  selectionFile = app?.getPath ? path.join(app.getPath('userData'), 'ha.view-face.json') : null;
  selectedFace = resolveInitialFace(global.ARGS?.ha_view_clock_face, selectionFile);
  hiddenFaces = selectionFile ? store.readHidden(selectionFile) : [];
  calendarAvailability = new (require('./calendar-availability').CalendarAvailability)({
    contents: () => state()?.views[state()?.viewActive]?.webContents, changed: syncCalendarAvailability,
    selection: () => daySchedule?.config.calendarEntities || [],
  });
  weatherAvailability = new WeatherAvailability({
    contents: () => state()?.views[state()?.viewActive]?.webContents,
    probe: contents => weatherRuntime.check(contents),
    changed: () => {
      const lostActive = faceVisible && !changer?.picking && presentedMode === 'weather' && !weatherAvailability.available;
      if (lostActive) { weatherToast(); showDashboard(); clockIdle = true; state().tracker.view.idle = true; }
      syncCalendarAvailability();
    },
  });
  weatherAvailability.refresh();
  weatherProbeTimer = setInterval(() => {
    if (!settingsOpen && !displayIsOff() && !browserOpen) weatherAvailability?.refresh();
  }, 15000);
  weatherProbeTimer.unref?.();
  presentedMode = null; pickerMode = null;
  changer = new FaceChanger({
    count: faceModes.FACE_IDS.length,
    open: renderPicker, dismiss: () => dismissClock(),
    width: () => faceBounds()?.width || 800,
    preview: n => clockView.webContents.executeJavaScript(`window.previewFace?.(${n})`).catch(() => {}),
    select: n => { if (weatherAvailability?.blocked(chooserMode(n))) { weatherToast(); return false; } if (effectiveHidden().includes(chooserMode(n))) { changer.cancel(); return; } try { if (selectionFile) store.writeMode(selectionFile, chooserMode(n)); selectedFace = faceModes.indexOf(chooserMode(n)); if (contextPolicy?.config.enabled) contextPolicy.choose(chooserMode(n)); else daySchedule?.choose(chooserMode(n)); contextBridge?.refresh(); } catch (error) { console.error('HA.View face save failed:', error.message); } showClock(chooserMode(n)); },
    cancel: () => { calendarAvailability?.invalidate(); changer.index = chooserIndex(pickerMode); const allHiddenRotation = daySchedule?.config.enabled && daySchedule.config.strategy === 'rotation' && !daySchedule.rotationFaces().length; showClock(allHiddenRotation ? 'dashboard' : pickerMode); },
  });
  changer.index = chooserIndex(faceModes.fromIndex(selectedFace));
  clockView = new WebContentsView({
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: path.join(__dirname, "face-changer-preload.js") },
  });
  clockView.setBackgroundColor("#000000");
  clockView.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  clockView.setVisible(false);
  webview.window.contentView.addChildView(clockView);
  clockView.webContents.on("before-mouse-event", faceInput);
  // A hold navigates documents: Chromium can discard its DOM pointerup. Observe
  // the native touch end to disarm only the opening press, never to select.
  clockView.webContents.on('input-event', (_event, input) => {
    if ((input.type === 'touchEnd' || input.type === 'touchCancel') && changer?.press?.held) changer.reset();
    if (input.type === 'touchCancel') changer?.reset();
  });
  clockView.webContents.on('before-input-event', (event, input) => {
    if (!settingsOpen && faceVisible && input.key === 'Escape' && input.type === 'keyDown') { event.preventDefault(); changer.abort(); }
  });
  clockView.webContents.on('blur', () => changer?.reset());
  windowBlur = () => changer?.reset();
  webview.window.on?.('blur', windowBlur);
  touchListener = (event, input) => {
    if (event.sender !== clockView?.webContents || settingsOpen || !faceVisible || displayIsOff()) return;
    if (!['down', 'move', 'up', 'cancel'].includes(input?.type)) return;
    if (input.type !== 'cancel' && (!Number.isFinite(input.x) || !Number.isFinite(input.y))) return;
    touchUntil = Date.now() + 800;
    routeFaceInput(input.type, input.x, input.y);
  };
  ipcMain?.on('ha.view:face-touch', touchListener);
  clockView.webContents.on("will-navigate", (event) => event.preventDefault());
  clockView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  initialized = true;
  wakeRelease = false;
  webview.tracker.view.idle = false;
  lastActivity = Date.now();
  const scheduleFile = process.argv.find(arg => arg.startsWith('--ha-view-day-schedule='))?.split('=').slice(1).join('=') || (app?.getPath ? path.join(app.getPath('userData'), 'ha.view-day-schedule.json') : null);
  const saved = scheduleFile ? dayStore.read(scheduleFile) : { config: dayStore.DEFAULT };
  if (saved.error) console.error('HA.View schedule disabled:', saved.error);
  daySchedule = new dayStore.DaySchedule({ ...scheduleClock, config: saved.config, hidden: effectiveHidden(), changed: applyDayPresentation });
  if (scheduleFile) disposeDaySettings = require('./day-schedule-settings').install({ file: scheduleFile, schedule: daySchedule, showFaceNow: () => {
    if (!authenticated() || settingsOpen || displayIsOff()) return;
    changer.reset(); changer.picking = false;
    faceVisible = true; disposeBrowser?.sync(); webview.tracker.view.idle = true; clockIdle = false;
    const savedMode = faceModes.fromIndex(selectedFace);
    if (weatherAvailability?.blocked(savedMode)) weatherToast();
    const mode = effectiveHidden().includes(savedMode) || calendarAvailability?.blocked(savedMode)
      ? availableMode(presentationMode()) : savedMode;
    showClock(mode === 'dashboard' ? 'clock2' : mode);
  }, idleOverride, changed: () => { calendarAvailability?.invalidate(true); scheduleIdle(); }, calendars: () => require("./calendar-data").listCalendars(state()?.views[state()?.viewActive]?.webContents), parent: webview.window, allowed: () => !displayIsOff() && [...openSettings].every(key => key === 'day'), interaction: settingsInteraction('day'), closed: (origin, reason) => {
    if (reason !== 'back' || displayIsOff() || openSettings.has('system')) return;
    if (origin === 'chooser' && authenticated()) { faceVisible = true; disposeBrowser?.sync(); webview.tracker.view.idle = true; changer.picking = true; clockView.setBounds(faceBounds()); webview.views.forEach(view => view.setVisible(false)); clockView.setVisible(true); clockView.webContents.focus(); renderPicker(false); }
    else { showDashboard(); focusDashboard(); }
  } });
  const contextFile = app?.getPath ? path.join(app.getPath('userData'), 'ha.view-context.json') : null;
  const contextSaved = contextFile ? contextStore.read(contextFile) : { config: contextStore.DEFAULT };
  if (contextSaved.error) console.error('HA.View context disabled:', contextSaved.error);
  contextPolicy = new contextStore.ContextPolicy({ config: contextSaved.config });
  contextBridge = new (require('./context-bridge').ContextBridge)({
    policy: contextPolicy, contents: () => state()?.views[state()?.viewActive]?.webContents,
    needed: () => !settingsOpen && !dashboardPress && !changer?.picking && !changer?.press && !displayIsOff() && Date.now() - lastActivity >= idleDelay(),
    changed: applyDayPresentation,
  });
  const browserSettings = app?.getPath ? require('./browser').createSettings(path.join(app.getPath('userData'), 'browser-settings.json')) : null;
  if (app?.getPath) disposeSystemSettings = require('./system-settings').install({ electron: require('electron'), browserSettings, parent: webview.window, allowed: () => !settingsOpen && !displayIsOff(), interaction: settingsInteraction('system'), toolActive: () => settingsOpen, target: () => state()?.views[state()?.viewActive]?.webContents, closed: origin => {
    if (displayIsOff()) return;
    if (origin === 'chooser' && authenticated()) { faceVisible = true; disposeBrowser?.sync(); webview.tracker.view.idle = true; changer.picking = true; clockView.setBounds(faceBounds()); webview.views.forEach(view => view.setVisible(false)); clockView.setVisible(true); clockView.webContents.focus(); renderPicker(false); }
    else { showDashboard(); focusDashboard(); }
  } });
  if (contextFile) disposeContextSettings = require('./context-settings').install({ file: contextFile, parent: webview.window, allowed: () => !settingsOpen && !displayIsOff(), policy: contextPolicy, changed: () => contextBridge.invalidate(), interaction: settingsInteraction('context') });
  layoutFile = app?.getPath ? path.join(app.getPath('userData'), 'ha.view-layout.json') : null;
  if (layoutFile) disposeLayoutEditor = require('./layout-editor').install({ file: layoutFile, parent: webview.window, allowed: () => !settingsOpen && !displayIsOff(), interaction: settingsInteraction('layout') });
  calendarAvailability.refresh();
  contextBridge.refresh();
  for (const view of webview.views) {
    const activity = (_event, input) => {
      if (displayIsOff() || faceVisible) return;
      if (input.type === 'touchStart') dashboardPress = true;
      if (input.type === 'touchEnd' || input.type === 'touchCancel') dashboardPress = false;
      lastActivity = Date.now(); scheduleIdle();
    };
    const release = (event, mouse) => {
      if (mouse.type === 'mouseUp' || mouse.type === 'mouseLeave') pointerEvent(event, mouse);
    };
    view.webContents.on?.('before-mouse-event', release);
    view.webContents.on?.('input-event', activity);
    view.webContents.on?.('before-input-event', activity);
    activityListeners.push([view.webContents, activity, release]);
  }
  disposeBrowser = require('./browser').install({ parent: webview.window, settings: browserSettings,
    allowed: () => dashboardVisible() && !changer?.picking && !changer?.press,
    off: displayIsOff, wakeBlocked: () => wakeRelease,
    interaction: open => {
      browserOpen = open; settingsOpen = open || openSettings.size > 0;
      if (open) { clearIdleTimer(); daySchedule?.setActive(false); changer?.reset(); }
      else { lastActivity = Date.now(); dashboardPress = false;
        if (!displayIsOff()) { daySchedule?.setActive(faceVisible); (faceVisible ? clockView?.webContents : webview.views[webview.viewActive]?.webContents)?.focus(); scheduleIdle(); }
      }
    },
  });
  frontendAuth = new (require('./frontend-auth').FrontendAuth)({
    contents: () => state()?.views[state()?.viewActive]?.webContents,
    changed: ready => {
      if (!initialized) return;
      if (!ready) { showDashboard(); clearIdleTimer(); }
      else { lastActivity = Date.now(); scheduleIdle(); }
    },
  });
  daySchedule.refresh();
  scheduleIdle();
  return true;
};

/** Called by the narrowly-scoped upstream before-mouse-event call-out. */
const pointerEvent = (_event, mouse) => {
  const webview = state();
  if (!initialized || !webview || displayIsOff(webview)) return;
  if (wakeRelease) {
    _event?.preventDefault?.();
    if (mouse.type === 'mouseUp' || mouse.type === 'mouseLeave') { wakeRelease = false; disposeBrowser?.sync(); }
    return;
  }
  if (mouse.type === 'mouseUp' && mouse.button === 'left') { dashboardPress = false; lastActivity = Date.now(); scheduleIdle(); return; }
  if (mouse.type === 'mouseLeave') { dashboardPress = false; scheduleIdle(); return; }
  if (mouse.type === 'mouseDown' && mouse.button === 'left' && !faceVisible) dashboardPress = true;
  if (mouse.type !== "mouseMove" && !(mouse.type === "mouseDown" && mouse.button === "left")) return;
  lastActivity = Date.now();
  if (faceVisible) { _event?.preventDefault?.(); return; }
  else if (webview.tracker.view.idle) showDashboard();
  scheduleIdle();
};

// Called before upstream visibility writes. Return true when HA.View owns them.
const upstreamIdleChanged = (idle, forceOff = false) => {
  if (!initialized) return false;
  const webview = state();
  if (forceOff || displayIsOff(webview)) {
    disposeBrowser?.power?.(true);
    calendarAvailability?.invalidate(true);
    daySchedule?.setActive(false);
    calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop();
    disposeSystemSettings?.close?.('off');
    disposeContextSettings?.close?.();
    require('./management').close?.(); require('./camera-dashboard').close?.();
    disposeDaySettings?.close?.('off');
    disposeLayoutEditor?.close?.();
    transition += 1;
    changer?.reset();
    faceVisible = false;
    clockIdle = false;
    clockView.setVisible(false);
    webview.tracker.view.idle = true;
    webview.views.forEach(view => view.setVisible(false));
    return true;
  }
  if (!authenticated()) { showDashboard(); return true; }
  if (settingsOpen) return true;
  disposeBrowser?.sync();
  if (idle) clockIdle = true;
  if (clockIdle) {
    webview.tracker.view.idle = true;
    if (faceVisible) {
      webview.views.forEach((view, index) => view.setVisible((calendarMode() || (presentationMode() === 'layout' && layoutFile && layoutStore.read(layoutFile).cards.some(card => ['calendar', 'upcoming'].includes(card.type)))) && !changer?.picking && index === webview.viewActive));
    } else {
      if (availableMode(presentationMode()) !== 'dashboard') webview.views.forEach(view => view.setVisible(false));
      else webview.views.forEach((view, index) => view.setVisible(index > 0 && index === webview.viewActive));
      applyDayPresentation();
    }
    return true;
  }
  webview.tracker.view.idle = false;
  webview.views.forEach((view, index) => view.setVisible(index > 0 && index === webview.viewActive));
  return true;
};

const displayChanged = (status, wakeTouch = false) => {
  if (!initialized) return;
  if (status === "OFF") {
    changer?.reset();
    clearIdleTimer();
    upstreamIdleChanged(true, true);
    return;
  }
  wakeRelease = wakeTouch;
  disposeBrowser?.power?.(false);
  showDashboard();
  dashboardPress = false;
  lastActivity = Date.now();
  daySchedule?.refresh();
  scheduleIdle();
};

const activeViewChanged = () => {
  if (!initialized) return;
  frontendAuth?.bind();
  if (settingsOpen) return;
  weatherAvailability?.invalidate();
  calendarAvailability?.invalidate(true);
  showDashboard(); // Navigation ends idle even when policy was showing the dashboard.
  focusDashboard();
  dashboardPress = false;
  wakeRelease = false;
  lastActivity = Date.now();
  contextBridge?.invalidate();
  calendarAvailability?.refresh();
  scheduleIdle();
};

const layoutChanged = () => {
  disposeBrowser?.sync();
  if (!clockView || !faceVisible) return;
  changer?.reset();
  pickerRects = null;
  const bounds = faceBounds();
  if (bounds) clockView.setBounds(bounds);
  if (changer?.picking) updatePickerRects().catch(() => {});
};

// HA.View shared policy inhibition for settings interaction.
const settingsInteraction = key => open => {
  if (open) openSettings.add(key); else openSettings.delete(key);
  settingsOpen = browserOpen || openSettings.size > 0;
  if (settingsOpen) { calendarAvailability?.invalidate(true); daySchedule?.setActive(false); calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop(); changer?.reset(); clearIdleTimer(); }
  disposeBrowser?.sync();
  if (!settingsOpen && initialized) { if (key !== 'system' && disposeSystemSettings?.toolClosed?.()) return; showDashboard(); lastActivity = Date.now(); calendarAvailability?.refresh(); scheduleIdle(); }
};
const dashboardVisible = () => initialized && !settingsOpen && !faceVisible && !displayIsOff() && state()?.viewActive > 0;
// Management may observe the active dashboard beneath its own launcher only.
// Keep settingsOpen intact: even this overlay must continue to inhibit idle.
const managementDashboardVisible = () => initialized && !faceVisible && !displayIsOff() &&
  state()?.viewActive > 0 && !!state()?.views?.[state().viewActive] &&
  [...openSettings].every(key => key === 'management');

// Cameras may navigate beneath only their own settings overlay; idle stays inhibited.
const cameraDashboardVisible = () => initialized && !faceVisible && !displayIsOff() &&
  !state()?.tracker?.view?.idle && state()?.viewActive > 0 &&
  !!state()?.views?.[state().viewActive] && [...openSettings].every(key => key === 'camera');

const dispose = () => {
  frontendAuth?.stop(); frontendAuth = null;
  disposeBrowser?.(); disposeBrowser = null; browserOpen = false;
  clearInterval(weatherProbeTimer); weatherAvailability?.invalidate(); weatherAvailability = null;
  calendarAvailability?.invalidate(); calendarAvailability = null;
  calendarRuntime.stop(); layoutRuntime.stop(); weatherRuntime.stop();
  for (const [contents, listener, release] of activityListeners) { contents.removeListener?.('before-mouse-event', release); contents.removeListener?.('input-event', listener); contents.removeListener?.('before-input-event', listener); }
  activityListeners = [];
  contextBridge?.stop(); contextBridge = null; contextPolicy = null;
  daySchedule?.stop(); daySchedule = null;
  disposeLayoutEditor?.(); disposeLayoutEditor = null; layoutFile = null;
  disposeDaySettings?.(); disposeDaySettings = null;
  disposeSystemSettings?.(); disposeSystemSettings = null;
  disposeContextSettings?.(); disposeContextSettings = null;
  openSettings.clear();
  settingsOpen = false; dashboardPress = false;
  changer?.reset();
  state()?.window.removeListener?.('blur', windowBlur);
  ipcMain?.removeListener("ha.view:face-touch", touchListener);
  changer = null;
  touchUntil = 0;
  pickerRects = null; pickerLayout += 1;
  clearIdleTimer();
  if (clockView && !clockView.webContents.isDestroyed()) clockView.webContents.close();
  clockView = null;
  lifecycle = null;
  loading = null;
  initialized = false;
  faceVisible = false;
  clockIdle = false;
  wakeRelease = false;
  transition += 1;
};

module.exports = {
  resolveInitialFace,
  init,
  idleDelay,
  idleDeadline,
  settingsAvailable: () => initialized && !settingsOpen && !displayIsOff(),
  settingsInteraction,
  dashboardVisible,
  managementDashboardVisible,
  cameraDashboardVisible,
  pointerEvent,
  pickerReady,
  displayChanged,
  activeViewChanged,
  upstreamIdleChanged,
  layoutChanged,
  dispose,
};
