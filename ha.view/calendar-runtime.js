/** HA.View ephemeral presentation inside the already-authenticated HA renderer.
 * No calendar engine, credentials, services, dashboard edits, or global theme CSS.
 */
'use strict';
const KEY = '__haViewCalendarFace';
function disposePage(key = '__haViewCalendarFace') { window[key]?.dispose(); }
async function mountPage(options) {
  const key = options.key || '__haViewCalendarFace';
  window[key]?.dispose();
  let root = document.querySelector('home-assistant');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:white;';
  if (options.region) { host.style.inset = 'auto'; host.style.left = `${options.region.x*100}%`; host.style.top = '0'; host.style.width = `${options.region.width*100}%`; host.style.height = '100%'; host.style.overflow = 'hidden'; }
  host.setAttribute('aria-label', options.mode === 'calendar' ? 'Calendar' : 'Upcoming Events');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host{font-family:Arial,sans-serif;color:#245d91;background:#fff;--primary-background-color:#fff;--primary-text-color:#245d91;--divider-color:transparent}*{box-sizing:border-box}.surface{height:100%;padding:clamp(16px,3vw,40px);display:flex;flex-direction:column;background:#fff}.heading{display:flex;justify-content:space-between;color:#ca302b;font-size:clamp(24px,4vw,54px);font-weight:700;margin-bottom:18px}.slot{flex:1;min-height:0;overflow:hidden}ha-full-calendar{display:block;height:100%;--calendar-height:100%;--calendar-border-width:0;--calendar-border-radius:0}.status{font-size:clamp(16px,2vw,24px);color:#245d91;min-height:1.4em}.loader{display:none}';
  if (options.region) {
    host.style.containerType = 'inline-size';
    // Region-local sizing; standalone viewport-based presentation remains untouched.
    style.textContent += '.surface{padding:clamp(10px,3cqw,28px)}.heading{font-size:clamp(18px,6cqw,40px);gap:8px;flex-wrap:wrap;margin-bottom:12px}.status{font-size:clamp(13px,4cqw,20px);overflow-wrap:anywhere}';
  }
  const surface = document.createElement('div'); surface.className = 'surface';
  const heading = document.createElement('div'); heading.className = 'heading';
  const title = document.createElement('span'), clock = document.createElement('span'); heading.append(title, clock);
  const slot = document.createElement('div'); slot.className = 'slot';
  const status = document.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status');
  const loader = document.createElement('div'); loader.className = 'loader';
  surface.append(heading, slot, status, loader); shadow.append(style, surface);
  document.body.append(host); // Attach BEFORE awaiting Lit updateComplete.
  let disposed = false, component, refreshTimer, clockTimer, observer, range, serial = 0, busy = false, lastHass, ready = false, agendaObserver, inFlight = 0, initialCatalog;
  const timers = new Set(), pending = new Set();
  let awaitingReadiness = true;
  const current = () => !disposed && host.isConnected && (!root || document.querySelector('home-assistant') === root);
  const alive = () => !disposed && host.isConnected && document.querySelector('home-assistant') === root && root?.hass?.connected === true;
  const wait = ms => new Promise(resolve => {
    const finish = () => { clearTimeout(id); timers.delete(id); pending.delete(finish); resolve(); };
    const id = setTimeout(finish, ms); timers.add(id); pending.add(finish);
  });
  const bounded = async (promise, ms) => {
    let id, cancel;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(Error('cancelled')); pending.add(cancel);
      id = setTimeout(() => reject(Error('timeout')), ms); timers.add(id);
    })]); }
    finally { clearTimeout(id); timers.delete(id); pending.delete(cancel); }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; serial++; clearInterval(refreshTimer); clearInterval(clockTimer); observer?.disconnect(); agendaObserver?.disconnect();
    for (const cancel of [...pending]) cancel(); pending.clear();
    for (const id of timers) clearTimeout(id); timers.clear(); host.remove();
    if (window[key]?.host === host) delete window[key];
  };
  window[key] = { host, dispose };
  const setStatus = text => { if (!disposed) status.textContent = text; };
  const updateClock = () => {
    if (awaitingReadiness) return;
    if (!alive()) { serial++; if (component && component.events.length) component.events = []; setStatus('Connect to Home Assistant to load calendars.'); return; }
    const hass = root.hass;
    const zone = hass.locale?.time_zone === 'local' ? undefined : hass.config?.time_zone;
    const now = new Date();
    title.textContent = options.mode === 'calendar' ? new Intl.DateTimeFormat(hass.language || 'en', { month: 'long', year: 'numeric', timeZone: zone }).format(now) : 'Upcoming Events';
    clock.textContent = new Intl.DateTimeFormat(hass.language || 'en', { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(now);
    if (component && lastHass !== hass) { const old = lastHass; lastHass = hass; component.hass = hass; component.requestUpdate('hass', old); }
  };
  const message = error => [401, 403].includes(Number(error?.status_code || error?.status)) ? 'Home Assistant denied calendar access.' : error?.message === 'native-calendar-loader-unavailable' ? 'Home Assistant native calendar loader is unavailable on this frontend.' : error?.message === 'timeout' ? 'Home Assistant calendar request timed out.' : 'Unable to load calendars from Home Assistant.';
  const cleanText = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, limit) : '';
  const dateValue = value => {
    const text = typeof value === 'string' ? value : value?.dateTime || value?.date;
    return typeof text === 'string' && text.length <= 64 && (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text)) && Number.isFinite(Date.parse(text)) ? text : null;
  };
  const readApi = path => {
    inFlight++;
    return Promise.resolve().then(() => root.hass.callApi('GET', path)).finally(() => { inFlight--; });
  };
  const stale = () => { dispose(); return { status: 'stale' }; };
  const refresh = async () => {
    if (inFlight || busy || !component || !range || !alive()) return;
    busy = true; const revision = ++serial; const hass = root.hass;
    const valid = () => alive() && revision === serial;
    setStatus('Loading calendar events…');
    try {
      const rows = initialCatalog || await bounded(readApi('calendars'), 7000);
      initialCatalog = undefined;
      if (!valid()) return;
      if (!Array.isArray(rows)) throw Error('invalid-calendar-list');
      const ids = (options.entityIds.length ? options.entityIds : rows.slice(0, 100).map(row => row?.entity_id)).filter(id => typeof id === 'string' && /^calendar\.[a-z0-9_]+$/.test(id) && rows.slice(0, 100).some(row => row?.entity_id === id) && hass.states?.[id]).slice(0, 8);
      component.calendars = ids.map(entity_id => ({ entity_id }));
      if (!ids.length) { component.events = []; setStatus(options.entityIds.length ? 'Selected calendars are not readable. Check Home Assistant permissions.' : 'No readable calendars. Configure calendars in Home Assistant.'); return; }
      // Native view-changed supplies the actual HA timezone/week/grid range.
      const start = new Date(range.start), end = new Date(range.end);
      if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start || end - start > 49 * 86400000) throw Error('invalid-range');
      const results = await Promise.all(ids.map(async id => {
        const query = '?start=' + encodeURIComponent(start.toISOString()) + '&end=' + encodeURIComponent(end.toISOString());
        try { const rows = await bounded(readApi('calendars/' + encodeURIComponent(id) + query), 7000); if (!Array.isArray(rows)) throw Error('invalid-events'); return { id, rows: rows.slice(0, 240) }; }
        catch (error) { return { id, error }; }
      }));
      if (!valid()) return;
      const events = [];
      eventLoop: for (const result of results) for (const raw of result.rows || []) {
        const start = dateValue(raw?.start), end = dateValue(raw?.end);
        if (!start || !end || Date.parse(end) <= Date.parse(start)) continue;
        const summary = cleanText(raw.summary, 240) || 'Untitled event';
        events.push({ title: summary, start, end, allDay: start.length === 10, calendar: result.id,
          eventData: { summary, dtstart: start, dtend: end, uid: cleanText(raw.uid, 180), location: cleanText(raw.location, 180) } });
        if (events.length >= 240) break eventLoop;
      }
      // HA _loadCalendar is async and does NOT include preassigned events in its
      // Calendar options. Assign a NEW array only after the view is ready, so
      // Lit willUpdate('events') adds the event source to the native engine.
      component.events = events.slice(0, 240);
      component.requestUpdate();
      await bounded(component.updateComplete, 6000);
      if (!valid()) return;
      const errors = results.filter(row => row.error);
      setStatus(errors.length ? (events.length ? 'Some calendars could not be loaded.' : message(errors[0].error)) : events.length ? '' : 'No events in this period.');
    } catch (error) { if (valid()) { component.events = []; setStatus(message(error)); } }
    finally { busy = false; }
  };
  try {
    updateClock(); setStatus('Loading Home Assistant calendar…');
    clockTimer = setInterval(updateClock, 1000);
    observer = new MutationObserver(() => { if (!current()) dispose(); });
    observer.observe(document.body, { childList: true, subtree: true });
    // Authentication readiness is independent of the active HA panel.
    // Overview does not publish Lovelace card helpers, however long we wait.
    const readinessDeadline = Date.now() + 12000;
    while (current()) {
      if (!root) root = document.querySelector('home-assistant');
      if (alive()) break;
      setStatus(root?.hass?.connected === true ? 'Loading Home Assistant calendar…' : 'Waiting for Home Assistant connection…');
      const remaining = readinessDeadline - Date.now();
      if (remaining <= 0) throw Error('readiness-timeout');
      await wait(Math.min(100, remaining));
    }
    if (!current()) return stale();
    awaitingReadiness = false;
    updateClock(); setStatus('Loading Home Assistant calendar…');
    // Use HA's own versioned lazy route imports: no hard-coded chunk URLs,
    // navigation, mounted panels, synthetic helpers or duplicate calendar engine.
    // routerOptions is a guarded frontend-private surface; fail closed if changed.
    const findRoute = tag => {
      const visit = node => {
        if (node.localName === 'partial-panel-resolver') {
          const route = Object.values(node.routerOptions?.routes || {}).find(row => row?.tag === tag && typeof row.load === 'function');
          if (route) return route;
        }
        if (node.shadowRoot) { const found = visit(node.shadowRoot); if (found) return found; }
        for (const child of node.children || []) { const found = visit(child); if (found) return found; }
      };
      return visit(root);
    };
    if (!customElements.get('ha-full-calendar')) {
      const nativeRoute = findRoute('ha-panel-calendar');
      if (nativeRoute) {
        try { await bounded(Promise.resolve().then(() => nativeRoute.load()), 12000); }
        catch (error) { if (!alive()) return stale(); }
      }
    }
    if (!alive()) return stale();
    let registrationIds = options.entityIds;
    if (!registrationIds.length) {
      initialCatalog = await bounded(readApi('calendars'), 7000);
      if (!alive()) return stale();
      registrationIds = (Array.isArray(initialCatalog) ? initialCatalog : []).slice(0, 100).map(row => row?.entity_id).filter(id => typeof id === 'string' && /^calendar\.[a-z0-9_]+$/.test(id) && root.hass.states?.[id]).slice(0, 8);
    }
    const config = { type: 'calendar', entities: registrationIds, initial_view: options.mode === 'calendar' ? 'dayGridMonth' : 'listWeek' };
    if (!customElements.get('ha-full-calendar')) {
      // Older frontends may register the component only via a calendar card.
      // Import the configured Lovelace route without rendering or changing it.
      if (typeof window.loadCardHelpers !== 'function') {
        const dashboardRoute = findRoute('ha-panel-lovelace');
        if (!dashboardRoute) throw Error('native-calendar-loader-unavailable');
        await bounded(Promise.resolve().then(() => dashboardRoute.load()), 12000);
      }
      if (!alive()) return stale();
      if (typeof window.loadCardHelpers !== 'function') throw Error('native-calendar-loader-unavailable');
      const helpers = await bounded(window.loadCardHelpers(), 12000);
      if (!alive()) return stale();
      let card = await bounded(Promise.resolve(helpers.createCardElement(config)), 10000);
      if (!alive()) return stale();
      card.hass = root.hass; loader.append(card);
      await bounded(customElements.whenDefined('hui-calendar-card'), 10000);
      if (!alive()) return stale();
      if (card.localName === 'hui-error-card') { card.remove(); card = helpers.createCardElement(config); card.hass = root.hass; loader.append(card); }
      if (card.updateComplete) await bounded(card.updateComplete, 6000);
      await bounded(customElements.whenDefined('ha-full-calendar'), 10000);
      loader.replaceChildren();
    }
    if (!alive()) return stale();
    component = document.createElement('ha-full-calendar');
    component.hass = root.hass; lastHass = root.hass; component.addFab = false;
    component.views = [config.initial_view]; component.initialView = config.initial_view;
    // Empty initially: events are added AFTER native async calendar creation.
    component.events = []; component.calendars = []; component.eventDisplay = 'auto';
    component.addEventListener('view-changed', event => { range = event.detail; serial++; if (ready && !busy) refresh(); });
    slot.append(component);
    await bounded(component.updateComplete, 6000);
    const deadline = Date.now() + 12000;
    while (alive() && !component.shadowRoot?.querySelector('.fc-' + config.initial_view + '-view') && Date.now() < deadline) await wait(100);
    if (!alive()) return stale();
    if (!component.shadowRoot?.querySelector('.fc-' + config.initial_view + '-view')) throw Error('timeout');
    const nativeStyle = document.createElement('style');
    // These rules live only in this ephemeral native component's shadow root.
    // Match HA's qualified selectors and override its important today color.
    nativeStyle.textContent = `
      .header{display:none!important}#calendar{height:100%!important}
      .fc{height:100%;background:#fff!important;--fc-border-color:transparent;--fc-neutral-bg-color:#fff;--fc-page-bg-color:#fff;--fc-today-bg-color:transparent;--fc-list-event-hover-bg-color:#fff;color:#245d91;font-family:Arial,sans-serif}
      .fc .fc-scrollgrid,.fc .fc-scrollgrid td,.fc .fc-scrollgrid th{border:0!important;background:#fff!important}
      .fc th.fc-col-header-cell.fc-day,.fc .fc-col-header-cell-cushion{background:#fff!important;color:#245d91!important;font-weight:700!important;font-size:clamp(16px,2.6vw,32px)!important}
      .fc .fc-daygrid-day-top{justify-content:center!important;flex-direction:row!important}
      .fc a.fc-daygrid-day-number{color:#245d91!important;font-size:clamp(20px,3vw,42px)!important;padding:8px!important;min-width:1.8em;text-align:center;line-height:1.2}
      .fc td.fc-day-other .fc-daygrid-day-number{opacity:.35!important}
      .fc td.fc-day-today .fc-daygrid-day-number{background:#154d80!important;color:#fff!important;border-radius:50%!important;width:1.8em!important;height:1.8em!important;min-width:1.8em!important;display:flex!important;align-items:center;justify-content:center;opacity:1!important}
      .fc-event{font-size:clamp(12px,1.3vw,18px)}
      .fc .fc-list{border:0!important;background:#fff!important}
    `;
    if (options.mode === 'upcoming') {
      heading.style.cssText = 'color:#181818;font-size:clamp(20px,2.5vw,34px);font-weight:500';
      clock.hidden = true;
      // HA/FullCalendar gives native time td a 1px table width. These cells
      // are grid items here: reset that width for both event classifications.
      nativeStyle.textContent += `
        .fc .fc-list-table{border-collapse:separate!important;border-spacing:0 10px;width:100%}
        .fc .fc-list-day.fc-day th{border:0!important;background:#fff!important}
        .fc .fc-list-day-cushion,.fc .fc-list-day-text,.fc .fc-list-day-side-text{background:#fff!important;color:#181818!important;font-size:clamp(18px,2vw,28px)!important;font-weight:700!important}
        .fc .fc-list-event.fc-event{display:grid;grid-template-columns:minmax(0,1fr);background:#e8f3fc!important;color:#161616!important;border-left:5px solid #398cc8;border-radius:14px;padding:12px 16px;gap:6px}
        .fc .fc-list-event.fc-event td{padding:0!important;border:0!important;background:transparent!important;min-width:0!important;max-width:100%!important}
        .fc .fc-list-event.fc-event .fc-list-event-title{grid-row:1;width:auto!important;min-width:0!important;font-size:clamp(18px,2.4vw,30px)!important;color:#161616!important;overflow-wrap:anywhere}
        .fc .fc-list-event.fc-event .fc-list-event-title a{color:inherit!important}
        .fc .fc-list-event.fc-event .fc-list-event-time{grid-row:2;width:auto!important;min-width:0!important;justify-self:stretch;line-height:1.4;color:#687480!important;font-size:clamp(14px,1.6vw,20px)!important;white-space:normal}
        .fc .fc-list-event.fc-event .fc-list-event-time:before{content:"◷";margin-right:8px}
        .fc .fc-list-event.fc-event .fc-list-event-graphic{display:none!important}
        .fc .fc-list-event.fc-event.ha-view-all-day{background:#fff0df!important;border-left:0;grid-template-columns:24px minmax(0,1fr) max-content;align-items:center;column-gap:12px}
        .fc .fc-list-event.fc-event.ha-view-all-day:before{content:"▦";color:#ea9139;font-size:22px;grid-column:1;grid-row:1}
        .fc .fc-list-event.fc-event.ha-view-all-day .fc-list-event-title{grid-column:2;grid-row:1}
        .fc .fc-list-event.fc-event.ha-view-all-day .fc-list-event-time{grid-column:3;grid-row:1;width:max-content!important;min-width:max-content!important;white-space:nowrap!important;justify-self:end;text-align:right}
        .fc .fc-list-event.fc-event.ha-view-all-day .fc-list-event-time:before{content:none}
      `;
      // Preserve HA's inline event-color initialization and native localized time
      // text. Classification comes from EventApi, never digits in a translation.
      if (!component.calendar?.getOption || !component.calendar?.setOption) throw Error('native-event-hook-unavailable');
      const originalEventDidMount = component.calendar.getOption('eventDidMount');
      if (originalEventDidMount != null && typeof originalEventDidMount !== 'function') throw Error('native-event-hook-unavailable');
      component.calendar.setOption('eventDidMount', function(info) {
        if (originalEventDidMount) originalEventDidMount.apply(this, arguments);
        info.el.classList.toggle('ha-view-all-day', info.event.allDay === true);
      });
    }
    if (options.region) nativeStyle.textContent += '.fc{font-size:clamp(11px,3cqw,18px)}.fc .fc-toolbar{flex-wrap:wrap;gap:6px}.fc .fc-toolbar-title{font-size:clamp(16px,5cqw,28px)}.fc .fc-list-event-title{overflow-wrap:anywhere;min-width:0}';
    component.shadowRoot.append(nativeStyle);
    if (options.mode === 'calendar') {
      component.calendar?.setOption('fixedWeekCount', true);
      for (const cell of component.shadowRoot.querySelectorAll('.fc-col-header-cell-cushion')) cell.textContent = cell.textContent.trim().slice(0, 1);
    }
    if (options.mode === 'upcoming') {
      // HA owns FullCalendar; configure its native list view, never duplicate it.
      // This guarded private instance hook is version-sensitive and fails closed.
      if (!component.calendar?.setOption || !component.calendar?.changeView) throw Error('native-list-range-unavailable');
      // Use HA's existing native list engine, not listWeek's fixed week
      // duration. Date-only exclusive boundaries use the native HA timezone.
      const zone = root.hass.locale?.time_zone === 'local' ? undefined : root.hass.config?.time_zone;
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const part = type => parts.find(p => p.type === type).value;
      const today = `${part('year')}-${part('month')}-${part('day')}`;
      // UTC is only civil-date arithmetic here, not the engine's timezone:
      // adding milliseconds to native midnights would be wrong across DST.
      const endDay = new Date(today + 'T00:00:00Z');
      endDay.setUTCDate(endDay.getUTCDate() + 30);
      component.calendar.setOption('duration', { days: 30 });
      component.calendar.setOption('visibleRange', { start: today, end: endDay.toISOString().slice(0, 10) });
      component.calendar.changeView('list', { start: today, end: endDay.toISOString().slice(0, 10) });
      range = { start: component.calendar.view.activeStart, end: component.calendar.view.activeEnd };
    }
    ready = true;
    await refresh();
    if (!alive()) return stale();
    refreshTimer = setInterval(() => { if (alive()) refresh(); else { serial++; if (component) component.events = []; setStatus('Connect to Home Assistant to load calendars.'); } }, 60000);
    return { status: 'mounted', view: component.calendar.view.type };
  } catch (error) {
    if (!current() || error?.message === 'cancelled') return stale();
    loader.replaceChildren(); clearInterval(clockTimer);
    for (const cancel of [...pending]) cancel(); pending.clear();
    for (const id of timers) clearTimeout(id); timers.clear();
    setStatus(error?.message === 'readiness-timeout' ? 'Home Assistant connection timed out. Connect to load calendars.' : message(error));
    return { status: 'error' };
  }
}
function mountScript(mode, entityIds, region, key) {
  if (!['calendar', 'upcoming'].includes(mode)) throw Error('Invalid calendar face');
  const ids = [...new Set((Array.isArray(entityIds) ? entityIds : []).filter(id => typeof id === 'string' && /^calendar\.[a-z0-9_]+$/.test(id) && id.length <= 255))].slice(0, 8);
  return `(${mountPage.toString()})(${JSON.stringify({ mode, entityIds: ids, region, key })})`;
}
class CalendarRuntime {
  constructor() { this.contents = null; }
  stop() {
    const contents = this.contents; this.contents = null;
    if (contents && !contents.isDestroyed?.()) contents.executeJavaScript(`(${disposePage.toString()})()`).catch(() => {});
  }
  start(contents, mode, ids) {
    this.stop(); this.contents = contents;
    return contents.executeJavaScript(mountScript(mode, ids)).catch(() => ({ status: 'error' }));
  }
}
module.exports = { KEY, mountPage, mountScript, disposePage, CalendarRuntime };
