/** HA.View read-only bridge to the authenticated embedded Home Assistant calendar API. */
'use strict';
const MAX_CALENDARS = 20;
const MAX_EVENTS = 240;
const READ_TIMEOUT_MS = 8000;
const MAX_RANGE_MS = 62 * 24 * 60 * 60 * 1000;
const ENTITY_ID = /^calendar\.[a-z0-9_]+$/;

function safeError(error) {
  const status = Number(error?.status_code ?? error?.statusCode ?? error?.status ?? error?.code);
  if (status === 401 || status === 403) return { status: 'permission-error', message: 'Home Assistant denied calendar access for this user.' };
  if (status === 404) return { status: 'setup-needed', message: 'Home Assistant has no readable calendar integration. Add a calendar integration and calendar entity first.' };
  return { status: 'error', message: 'Home Assistant calendar data could not be loaded.' };
}
function responseError(response) {
  if (!response || typeof response !== 'object') return { status: 'disconnected', message: 'The embedded Home Assistant session is unavailable.' };
  if (response.status === 'ok') return null;
  if (['setup-needed', 'permission-error', 'disconnected', 'timeout', 'error', 'partial', 'empty-selection'].includes(response.status)) return response;
  return { status: 'error', message: 'Home Assistant returned an invalid calendar response.' };
}
function cleanCatalog(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(item => {
    const entity_id = typeof item?.entity_id === 'string' ? item.entity_id : '';
    if (!ENTITY_ID.test(entity_id) || entity_id.length > 255) return [];
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 120) : entity_id;
    return [{ entity_id, name }];
  });
}
function getCalendarListScript() {
  return `(() => { const root=document.querySelector('home-assistant'),hass=root&&root.hass;
    if(!hass||hass.connected!==true)return {status:'disconnected',message:'Connect to Home Assistant to load calendars.'};
    if(!Array.isArray(hass.config?.components))return {status:'disconnected',message:'Home Assistant calendar capabilities are not ready.'};
    if(!hass.config.components.includes('calendar'))return {status:'setup-needed',message:'No calendar integration is configured in Home Assistant.'};
    return Promise.resolve().then(()=>hass.callApi('GET','calendars')).then(items=>{
      if(document.querySelector('home-assistant')!==root||root.hass!==hass||hass.connected!==true)return {status:'disconnected'};
      if(!Array.isArray(items))return {status:'error',message:'Home Assistant returned an invalid calendar catalog.'};
      const calendars=Array.isArray(items)?items.slice(0,100).flatMap(item=>{const id=typeof item?.entity_id==='string'?item.entity_id:'';if(!/^calendar\.[a-z0-9_]+$/.test(id)||id.length>255)return [];const name=typeof item.name==='string'&&item.name.trim()?item.name.trim().slice(0,120):id;return [{entity_id:id,name}]}):[];
      return {status:'ok',calendars,timeZone:typeof hass.config.time_zone==='string'?hass.config.time_zone:'UTC'};
    }).catch(error=>{
      if(document.querySelector('home-assistant')!==root||root.hass!==hass||hass.connected!==true)return {status:'disconnected'};
      const status=Number(error?.status_code??error?.statusCode??error?.status??error?.code);
      if(status===404)return {status:'setup-needed',message:'Home Assistant has no readable calendar integration.'};
      if(status===401||status===403)return {status:'permission-error',message:'Home Assistant denied calendar access for this user.'};
      return {status:'error',message:'Home Assistant calendar list request failed.'};
    }); })()`;
}
function getEventsScript(entityIds, start, end) {
  const args = JSON.stringify({ entityIds, start: start.toISOString(), end: end.toISOString() });
  return `(() => { const root=document.querySelector('home-assistant'),hass=root&&root.hass,a=${args};
    if(!hass||hass.connected!==true)return {status:'disconnected',message:'Connect to Home Assistant to load calendar events.'};
    if(!Array.isArray(hass.config?.components)||!hass.config.components.includes('calendar'))return {status:'setup-needed',message:'No calendar integration is configured in Home Assistant.'};
    if(!a.entityIds.length)return {status:'empty-selection',message:'Select one or more calendar entities in Face Settings.'};
    const requests=a.entityIds.map(async entity_id=>{const q=new URLSearchParams({start:a.start,end:a.end});
      try{const raw=await hass.callApi('GET','calendars/'+encodeURIComponent(entity_id)+'?'+q.toString());
        const events=Array.isArray(raw)?raw.slice(0,240).map(e=>({uid:typeof e?.uid==='string'?e.uid.slice(0,180):'',summary:typeof e?.summary==='string'?e.summary.slice(0,240):'',start:e?.start,end:e?.end,location:typeof e?.location==='string'?e.location.slice(0,180):''})):[];
        return {entity_id,events};}
      catch(error){const status=Number(error?.status_code??error?.statusCode??error?.status??error?.code);return {entity_id,error:{status}};}});
    return Promise.all(requests).then(results=>{if(document.querySelector('home-assistant')!==root||root.hass!==hass||hass.connected!==true)return {status:'disconnected'};
      let remaining=240;for(const result of results){if(result.events){result.events=result.events.slice(0,remaining);remaining-=result.events.length;}}
      return {status:'ok',results,timeZone:typeof hass.config.time_zone==='string'?hass.config.time_zone:'UTC',now:new Date().toISOString()};}); })()`;
}
function zonedParts(date, timeZone) {
  const values = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(values.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
function zonedDateTime(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let instant = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(instant), timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    instant += target - represented;
  }
  return new Date(instant);
}
function monthRange(month, timeZone = 'UTC') {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Calendar month must use YYYY-MM.');
  const [year, m] = month.split('-').map(Number);
  if (year < 2000 || year > 2100) throw new Error('Calendar month is outside the supported range.');
  return { start: zonedDateTime(year, m, 1, timeZone), end: zonedDateTime(m === 12 ? year + 1 : year, m === 12 ? 1 : m + 1, 1, timeZone) };
}
function upcomingRange(now = new Date()) { return { start: new Date(now), end: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) }; }
function parseDateValue(value) {
  if (typeof value === 'string') value = { dateTime: value };
  if (!value || typeof value !== 'object') return null;
  if (typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) return { allDay: true, value: value.date };
  if (typeof value.dateTime === 'string') {
    const time = Date.parse(value.dateTime);
    return Number.isFinite(time) ? { allDay: false, value: new Date(time).toISOString() } : null;
  }
  return null;
}
function normalizeEvent(raw, entityId) {
  if (!raw || typeof raw !== 'object') return null;
  const start = parseDateValue(raw.start), end = parseDateValue(raw.end);
  if (!start || !end || start.allDay !== end.allDay) return null;
  const allDay = start.allDay;
  const startMs = allDay ? Date.parse(`${start.value}T00:00:00Z`) : Date.parse(start.value);
  const endMs = allDay ? Date.parse(`${end.value}T00:00:00Z`) : Date.parse(end.value);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const summary = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim().slice(0, 240) : 'Untitled event';
  const eventId = typeof raw.uid === 'string' ? raw.uid.slice(0, 180) : `${entityId}:${start.value}:${summary}`;
  return { id: eventId, calendarEntity: entityId, summary, start: start.value, end: end.value, allDay, location: typeof raw.location === 'string' ? raw.location.slice(0, 180) : '' };
}
function dateKeyAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function normalizeEvents(response, selectedIds, start, end, now = new Date()) {
  const failure = responseError(response);
  if (failure) return { ...failure, events: [], timeZone: 'UTC', now: now.toISOString() };
  const timeZone = typeof response.timeZone === 'string' && response.timeZone.length <= 80 ? response.timeZone : 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { return { status: 'error', message: 'Home Assistant supplied an invalid time zone.', events: [], timeZone: 'UTC', now: now.toISOString() }; }
  if (end <= start || end - start > MAX_RANGE_MS) return { status: 'error', message: 'Calendar request range exceeded the safe limit.', events: [], timeZone, now: now.toISOString() };
  if (response.status !== 'ok' || !Array.isArray(response.results)) return { status: 'error', message: 'Home Assistant returned an invalid calendar response.', events: [], timeZone, now: now.toISOString() };
  const events = [];
  const errors = [];
  for (const result of response.results.slice(0, MAX_CALENDARS)) {
    if (!selectedIds.includes(result?.entity_id)) continue;
    if (result.error) { errors.push(safeError(result.error)); continue; }
    if (!Array.isArray(result.events)) { errors.push({ status: 'error', message: 'A selected calendar returned invalid event data.' }); continue; }
    for (const raw of result.events) {
      const event = normalizeEvent(raw, result.entity_id);
      if (!event) continue;
      const startAt = event.allDay ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start);
      const endAt = event.allDay ? Date.parse(`${event.end}T00:00:00Z`) : Date.parse(event.end);
      if (event.allDay) {
        const rangeStart = dateKeyAt(start, timeZone), rangeEnd = dateKeyAt(end, timeZone);
        if (event.end <= rangeStart || event.start >= rangeEnd) continue;
      } else if (endAt <= start || startAt >= end) continue;
      events.push(event);
      if (events.length >= MAX_EVENTS) break;
    }
    if (events.length >= MAX_EVENTS) break;
  }
  events.sort((a, b) => Date.parse(a.start.length === 10 ? `${a.start}T00:00:00Z` : a.start) - Date.parse(b.start.length === 10 ? `${b.start}T00:00:00Z` : b.start) || a.summary.localeCompare(b.summary));
  return { status: errors.length ? (events.length ? 'partial' : errors[0].status) : 'ok', message: errors.length && !events.length ? errors[0].message : '', events: events.slice(0, MAX_EVENTS), timeZone, now: response.now && Number.isFinite(Date.parse(response.now)) ? new Date(response.now).toISOString() : now.toISOString(), truncated: events.length >= MAX_EVENTS };
}
async function execute(contents, source, setTimer = setTimeout, clearTimer = clearTimeout) {
  if (!contents || contents.isDestroyed?.()) return { status: 'disconnected', message: 'The embedded Home Assistant view is unavailable.' };
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => contents.executeJavaScript(source)),
      new Promise(resolve => { timer = setTimer(() => resolve({ status: 'timeout', message: 'Home Assistant calendar request timed out.' }), READ_TIMEOUT_MS); }),
    ]);
    return result;
  } catch (error) { return safeError(error); }
  finally { if (timer) clearTimer(timer); }
}
async function listCalendars(contents, timers) {
  const response = await execute(contents, getCalendarListScript(), ...(timers || []));
  if (response?.status !== 'ok') return responseError(response) || { status: 'error', message: 'Calendar discovery failed.' };
  if (!Array.isArray(response.calendars)) return { status: 'error', message: 'Home Assistant returned an invalid calendar catalog.' };
  return { status: 'ok', calendars: cleanCatalog(response.calendars), timeZone: response.timeZone || 'UTC' };
}
async function loadEvents(contents, { entityIds, mode, month, now = new Date() }, timers) {
  if (!['calendar', 'upcoming'].includes(mode)) throw new Error('Calendar reader requires an HA calendar face.');
  const selected = [...new Set((Array.isArray(entityIds) ? entityIds : []).filter(id => typeof id === 'string' && ENTITY_ID.test(id)))].slice(0, MAX_CALENDARS);
  const catalog = await listCalendars(contents, timers);
  if (catalog.status !== 'ok') return { ...catalog, events: [], timeZone: catalog.timeZone || 'UTC', now: now.toISOString() };
  if (!selected.length) return { status: 'empty-selection', message: 'Select one or more calendar entities in Face Settings.', events: [], timeZone: catalog.timeZone, now: now.toISOString() };
  const range = mode === 'calendar' ? monthRange(month || new Intl.DateTimeFormat('en-CA', { timeZone: catalog.timeZone, year: 'numeric', month: '2-digit' }).format(now), catalog.timeZone) : upcomingRange(now);
  if (range.end - range.start > MAX_RANGE_MS) throw new Error('Calendar request range exceeded the safe limit.');
  const known = new Set(catalog.calendars.map(item => item.entity_id));
  const readableSelection = selected.filter(id => known.has(id));
  if (!readableSelection.length) return { status: 'setup-needed', message: 'None of the selected calendar entities are currently readable. Check the integration and user permissions in Home Assistant.', events: [], timeZone: catalog.timeZone, now: now.toISOString() };
  const response = await execute(contents, getEventsScript(readableSelection, range.start, range.end), ...(timers || []));
  const normalized = normalizeEvents(response, readableSelection, range.start, range.end, now);
  const displayMonth = mode === 'calendar' ? (month || new Intl.DateTimeFormat('en-CA', { timeZone: catalog.timeZone, year: 'numeric', month: '2-digit' }).format(now)) : undefined;
  return { ...normalized, calendars: catalog.calendars, month: displayMonth, range: { start: range.start.toISOString(), end: range.end.toISOString() } };
}
module.exports = { MAX_CALENDARS, MAX_EVENTS, READ_TIMEOUT_MS, MAX_RANGE_MS, ENTITY_ID, safeError, cleanCatalog, getCalendarListScript, getEventsScript, zonedDateTime, monthRange, upcomingRange, parseDateValue, normalizeEvent, normalizeEvents, dateKeyAt, execute, listCalendars, loadEvents };
