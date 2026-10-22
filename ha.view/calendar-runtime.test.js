/** HA.View focused contract/regression tests; real authenticated rendering is a separate probe. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { mountScript, mountPage, CalendarRuntime } = require('./calendar-runtime');
const modes = require('./face-modes');
const store = require('./face-changer-store');
const schedule = require('./day-schedule');
const data = require('./calendar-data');
test('native-only serialized runtime has bounded validated entities and no executable interpolation', () => {
  assert.throws(() => mountScript('clock1', []));
  const code = mountScript('calendar', ['calendar.good', 'calendar.good', 'calendar.bad<script>', ...Array.from({ length: 20 }, (_, n) => 'calendar.item_' + n)]);
  new vm.Script(code);
  const args = JSON.parse(code.slice(code.lastIndexOf(')(') + 2, -1));
  assert.equal(args.entityIds.length, 8); assert.equal(args.entityIds[0], 'calendar.good');
  assert.ok(!args.entityIds.includes('calendar.bad<script>'));
  const source = mountPage.toString();
  assert.match(source, /loadCardHelpers/); assert.match(source, /ha-full-calendar/);
  assert.ok(source.indexOf('document.body.append(host)') < source.indexOf('await bounded(component.updateComplete'));
  assert.ok(source.indexOf('ready = true') > source.indexOf("querySelector('.fc-'"));
  assert.match(source, /ready && !busy/); assert.match(source, /component.events = events.slice/);
  assert.doesNotMatch(source, /callService|callApi\(['"](?:POST|PUT|DELETE)|innerHTML|new Calendar\(/);
  assert.match(source, /inFlight \|\| busy/); assert.match(source, /finally\(\(\) => \{ inFlight--/);
  assert.match(source, /const stale = \(\) => \{ dispose\(\)/);
  assert.match(source, /setOption\('visibleRange'/);
  assert.match(source, /options.entityIds.length \? options.entityIds : rows/);
  assert.match(source, /serial\+\+/); assert.match(source, /49 \* 86400000/); assert.match(source, /240/);
  assert.match(source, /agendaObserver\?\.disconnect/); assert.match(source, /host.remove/);
});
test('runtime cleans the previous authenticated host before changing mode or disconnecting', async () => {
  const calls = [], contents = { isDestroyed: () => false, executeJavaScript: async code => { calls.push(code); return { status: 'mounted' }; } };
  const runtime = new CalendarRuntime();
  await runtime.start(contents, 'calendar', ['calendar.family']);
  await runtime.start(contents, 'upcoming', ['calendar.family']);
  runtime.stop(); runtime.stop();
  assert.equal(calls.length, 4);
  assert.match(calls[0], /"mode":"calendar"/); assert.match(calls[1], /dispose/);
  assert.match(calls[2], /"mode":"upcoming"/); assert.match(calls[3], /dispose/);
  assert.equal(runtime.contents, null);
});
test('stable face IDs preserve legacy clock selection and round-trip both new faces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-view-calendar-'));
  try {
    const file = path.join(dir, 'face.json');
    fs.writeFileSync(file, '{"face":2}'); assert.equal(store.readMode(file), 'clock2');
    for (const mode of modes.FACE_IDS) { store.writeMode(file, mode); assert.equal(store.readMode(file), mode); assert.equal(modes.fromIndex(modes.indexOf(mode)), mode); }
    const config = schedule.validate({ enabled: true, rules: [{ time:'00:00', mode:'calendar' }, { time:'12:00', mode:'upcoming' }], calendarEntities: ['calendar.family', 'calendar.family'] });
    assert.deepEqual(config.calendarEntities, ['calendar.family']);
    assert.throws(() => schedule.validate({ ...config, calendarEntities: Array.from({ length:9 }, (_, n) => 'calendar.c' + n) }));
    assert.throws(() => schedule.validate({ ...config, calendarEntities: ['sensor.not_calendar'] }));
  } finally { fs.rmSync(dir, { recursive:true }); }
});
test('read-only catalog sanitizes external entity metadata and event reader rejects wrong face', async () => {
  const catalog = data.cleanCatalog([{ entity_id:'calendar.family', name:'Family' }, { entity_id:'calendar.x;alert(1)', name:'Bad' }, { entity_id:'sensor.fake' }]);
  assert.deepEqual(catalog, [{ entity_id:'calendar.family', name:'Family' }]);
  await assert.rejects(data.loadEvents(null, { mode:'clock1', entityIds:[] }));
  assert.equal((await data.listCalendars(null)).status, 'disconnected');
});

// Execute the serialized renderer with a deterministic clock, not source-only assertions.
function readinessHarness(connected = true, hasRoot = true) {
  let now = 0, next = 0, root, observer;
  const timeouts = new Map(), intervals = new Map(), nodes = [];
  const element = name => {
    const node = { localName:name, style:{}, isConnected:false, textContent:'', children:[],
      setAttribute() {}, append(...children) { this.children.push(...children); for (const child of children) child.isConnected = true; },
      attachShadow() { return element('shadow'); }, remove() { this.isConnected = false; }, replaceChildren() { this.children = []; } };
    nodes.push(node); return node;
  };
  root = hasRoot ? { hass:{ connected } } : null;
  const window = {};
  const context = vm.createContext({ window, customElements: { get: () => undefined }, document:{ body:element('body'), createElement:element, querySelector:() => root },
    Date:class extends Date { static now() { return now; } }, Intl,
    setTimeout:(fn, ms) => { const id = ++next; timeouts.set(id, { fn, at:now + ms }); return id; },
    clearTimeout:id => timeouts.delete(id), setInterval:fn => { const id = ++next; intervals.set(id, fn); return id; }, clearInterval:id => intervals.delete(id),
    MutationObserver:class { constructor(fn) { observer = this; this.fn = fn; } observe() {} disconnect() { this.disconnected = true; } }
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  return { window, nodes, timeouts, intervals, get root() { return root; }, set root(value) { root = value; },
    mount:() => vm.runInContext(mountScript('calendar', ['calendar.family']), context),
    status:() => nodes.find(n => n.className === 'status').textContent,
    mutate:() => observer.fn(), flush,
    async tick(ms) { now += ms; for (const [id, timer] of [...timeouts]) if (timer.at <= now) { timeouts.delete(id); timer.fn(); } await flush(); }
  };
}
test('one mount waits for connected hass AND delayed helpers before native bootstrap', async () => {
  const h = readinessHarness(false); let calls = 0;
  const result = h.mount(); await h.flush();
  assert.match(h.status(), /Waiting/);
  h.window.loadCardHelpers = () => { calls++; return new Promise(() => {}); };
  await h.tick(100); assert.equal(calls, 0);
  h.root.hass.connected = true;
  await h.tick(100); assert.equal(calls, 1); assert.match(h.status(), /Loading/);
  h.window.__haViewCalendarFace.dispose();
  assert.equal((await result).status, 'stale'); assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
});
test('connected Overview invokes the native route without waiting for helpers', async () => {
  const h = readinessHarness(); let calls = 0;
  h.root.children = [{localName:'partial-panel-resolver',routerOptions:{routes:{calendar:{tag:'ha-panel-calendar',load:()=>{calls++;return new Promise(()=>{});}}}}}];
  const result = h.mount(); await h.flush(); assert.equal(calls,1);
  h.window.__haViewCalendarFace.dispose(); assert.equal((await result).status,'stale');
  assert.equal(h.timeouts.size,0); assert.equal(h.intervals.size,0);
});
test('native import failure uses HA Lovelace route loader and cancellation clears its deadline', async () => {
  const h = readinessHarness(); let native = 0, fallback = 0, helpers = 0;
  h.root.children = [{localName:'partial-panel-resolver',routerOptions:{routes:{
    calendar:{tag:'ha-panel-calendar',load:()=>{native++;return Promise.reject(Error('import failed'));}},
    map:{tag:'ha-panel-lovelace',load:()=>{fallback++;h.window.loadCardHelpers=()=>{helpers++;return new Promise(()=>{});};return Promise.resolve();}}
  }}}];
  const result = h.mount(); await h.flush(); await h.flush();
  assert.equal(native,1); assert.equal(fallback,1); assert.equal(helpers,1);
  h.window.__haViewCalendarFace.dispose(); assert.equal((await result).status,'stale');
  assert.equal(h.timeouts.size,0); assert.equal(h.intervals.size,0);
});
test('missing native route and helpers fails closed without a readiness delay', async () => {
  const h = readinessHarness(); const result = h.mount(); await h.flush();
  assert.equal((await result).status,'error'); assert.match(h.status(),/native calendar loader is unavailable/);
  assert.equal(h.timeouts.size,0); assert.equal(h.intervals.size,0);
  h.window.__haViewCalendarFace.dispose();
});
test('authentication timeout is distinct from unavailable helpers', async () => {
  const h = readinessHarness(false); const result = h.mount(); await h.flush();
  await h.tick(12000); assert.equal((await result).status, 'error'); assert.match(h.status(), /connection timed out/);
  h.window.__haViewCalendarFace.dispose();
});
test('readiness cancellation and root replacement settle stale and clear timers', async () => {
  for (const replace of [false, true]) {
    const h = readinessHarness(false); const result = h.mount(); await h.flush();
    if (replace) { h.root = { hass:{ connected:true } }; h.mutate(); }
    else h.window.__haViewCalendarFace.dispose();
    assert.equal((await result).status, 'stale'); assert.equal(h.timeouts.size, 0); assert.equal(h.intervals.size, 0);
    assert.equal(h.window.__haViewCalendarFace, undefined);
  }
});
test('home-assistant root may appear during initial readiness', async () => {
  const h = readinessHarness(true, false); const result = h.mount(); await h.flush();
  h.root = { hass:{ connected:true } }; h.mutate(); let calls = 0;
  h.window.loadCardHelpers = () => { calls++; return new Promise(() => {}); };
  await h.tick(100); assert.equal(calls, 1);
  h.window.__haViewCalendarFace.dispose(); assert.equal((await result).status, 'stale');
});

test('native presentation overrides HA selectors without a global theme', () => {
  const source = mountPage.toString();
  assert.match(source, /\.fc a\.fc-daygrid-day-number\{color:#245d91!important;font-size:[^}]+!important/);
  assert.match(source, /\.fc td\.fc-day-today \.fc-daygrid-day-number\{background:#154d80!important;color:#fff!important/);
  assert.match(source, /\.fc th\.fc-col-header-cell\.fc-day/);
  assert.match(source, /setOption\('fixedWeekCount', true\)/);
  assert.match(source, /ha-view-all-day \.fc-list-event-title\{grid-column:2;grid-row:1/);
  assert.match(source, /ha-view-all-day \.fc-list-event-time\{grid-column:3;grid-row:1/);
  assert.doesNotMatch(source, /!\/\\d\//);
});
test('native mount hook chains HA with its receiver and classifies EventApi allDay', () => {
  const source = mountPage.toString();
  const start = source.indexOf('      const originalEventDidMount');
  const end = source.indexOf('\n    }', start);
  const hookSource = source.slice(start, end);
  const receiver = {}, seen = []; let hook;
  const component = { calendar: {
    getOption(name) { assert.equal(name, 'eventDidMount'); return function(info) { assert.equal(this, receiver); seen.push(info); }; },
    setOption(name, fn) { assert.equal(name, 'eventDidMount'); hook = fn; },
  } };
  vm.runInNewContext(hookSource, { component });
  for (const allDay of [true, false]) {
    const classes = [];
    const info = { event: { allDay }, el: { classList: { toggle: (...args) => classes.push(args) } } };
    hook.call(receiver, info);
    assert.equal(seen.at(-1), info);
    assert.deepEqual(classes, [['ha-view-all-day', allDay]]);
  }
  component.calendar.getOption = () => undefined;
  vm.runInNewContext(hookSource, { component });
  assert.doesNotThrow(() => hook({ event: { allDay: true }, el: { classList: { toggle() {} } } }));
  component.calendar.getOption = () => [];
  assert.throws(() => vm.runInNewContext(hookSource, { component }), /native-event-hook-unavailable/);
});

test('upcoming configures effective native visibleRange with HA civil dates and exclusive end', () => {
  const source = mountPage.toString();
  const start = source.indexOf('      // HA owns FullCalendar;');
  const end = source.indexOf('\n    }', start);
  const configuration = source.slice(start, end);
  for (const [instant, zone, today, endDay] of [
    ['2026-10-15T02:00:00Z', 'America/New_York', '2026-10-14', '2026-11-13'],
    ['2026-10-15T23:00:00Z', 'Asia/Tokyo', '2026-10-16', '2026-11-15'],
    ['2026-03-01T12:00:00Z', 'America/New_York', '2026-03-01', '2026-03-31'],
    ['2026-12-20T12:00:00Z', 'UTC', '2026-12-20', '2027-01-19'],
    ['2028-02-01T12:00:00Z', 'UTC', '2028-02-01', '2028-03-02'],
    ['2026-10-15T12:00:00Z', 'local', null, null],
  ]) {
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } }
    const effective = { timeZone: zone }, navigation = [];
    const calendar = {
      // Model the observed precedence: listWeek keeps seven days; the
      // native base list honors visibleRange and the explicit changeView range.
      view: { activeStart: new Date('2026-10-15'), activeEnd: new Date('2026-10-22') },
      setOption(name, value) { if (name !== 'views') effective[name] = value; },
      changeView(view, dates) {
        navigation.push([view, dates]);
        assert.equal(view, 'list');
        assert.equal(JSON.stringify(dates), JSON.stringify(effective.visibleRange));
        if (view === 'list' && effective.duration?.days === 30 && effective.visibleRange) {
          this.view = { type: view, activeStart: new Date(dates.start), activeEnd: new Date(dates.end) };
        }
      },
    };
    const context = { component: { calendar }, root: { hass: { locale: { time_zone: zone }, config: { time_zone: zone } } }, Date: FixedDate, Intl, range: null };
    vm.runInNewContext(configuration, context);
    const expectedToday = today || new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(instant));
    assert.equal(effective.visibleRange.start, expectedToday);
    if (endDay) assert.equal(effective.visibleRange.end, endDay);
    assert.equal((context.range.end - context.range.start) / 86400000, 30);
    assert.equal(effective.timeZone, zone, 'native timezone is not overwritten');
    assert.equal(JSON.stringify(navigation), JSON.stringify([['list', effective.visibleRange]]));
    assert.equal(calendar.view.type, 'list');
    assert.equal(effective.duration.days, 30);
    assert.equal(effective.views, undefined);
  }
  assert.throws(() => vm.runInNewContext(configuration, { component: { calendar: {} } }), /native-list-range-unavailable/);
});

test('native grid time cells override table width for timed and all-day labels', () => {
  const source = mountPage.toString();
  assert.match(source, /\.fc-list-event-time\{grid-row:2;width:auto!important;min-width:0!important;justify-self:stretch;line-height:1\.4/);
  assert.match(source, /grid-template-columns:24px minmax\(0,1fr\) max-content/);
  assert.match(source, /\.fc-list-event-time\{grid-column:3;grid-row:1;width:max-content!important;min-width:max-content!important;white-space:nowrap!important/);
  assert.match(source, /\.fc-list-event-title\{grid-row:1;width:auto!important;min-width:0!important/);
});

test('real-engine readability check rejects collapsed cells even when alignment passes', () => {
  const { readableListRow: readable } = require('./verify-calendar-faces.cjs');
  const view = { x:0, right:420 };
  const make = allDay => ({ allDayClass:allDay, time:'all-day', row:{rect:{x:10,right:410}},
    timeBox:{rect:{x:300,right:380,width:80,height:20}}, titleBox:{rect:{x:50,right:280,width:230}},
    timeMetrics:{clientWidth:80,scrollWidth:80,clientHeight:20,scrollHeight:20,intrinsicTextWidth:50,visibility:'visible',opacity:'1',lineHeight:20,whiteSpace:allDay?'nowrap':'normal'},
    titleMetrics:{clientWidth:230,scrollWidth:230} });
  for (const allDay of [true,false]) {
    assert.equal(readable(make(allDay),view),true);
    for (const mutate of [
      r => { r.timeBox.rect.width=1; r.timeMetrics.clientWidth=1; },
      r => { r.timeBox.rect.height=112; },
      r => { r.timeMetrics.scrollWidth=200; },
      r => { r.timeBox.rect.right=421.5; },
      r => { r.titleMetrics.scrollWidth=300; },
      r => { r.timeMetrics.visibility='hidden'; },
    ]) { const row=make(allDay); mutate(row); assert.equal(readable(row,view),false); }
  }
});

test('real catalog script rejects a replaced connected hass snapshot then reads the fresh one', async () => {
  let resolve;
  const root = { hass: { connected: true, config: { components: ['calendar'], time_zone: 'UTC' },
    callApi: () => new Promise(r => { resolve = r; }) } };
  const context = vm.createContext({ document: { querySelector: () => root } });
  const first = vm.runInContext(data.getCalendarListScript(), context);
  await Promise.resolve();
  root.hass = { ...root.hass, callApi: async () => [{ entity_id: 'calendar.real', name: 'Real' }] };
  resolve([{ entity_id: 'calendar.real', name: 'Real' }]);
  assert.equal((await first).status, 'disconnected');
  const fresh = await vm.runInContext(data.getCalendarListScript(), context);
  assert.equal(fresh.status, 'ok'); assert.equal(fresh.calendars[0].entity_id, 'calendar.real');
});
