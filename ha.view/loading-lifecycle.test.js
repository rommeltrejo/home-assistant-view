const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const base = process.env.AUDIT_SOURCE || path.join(__dirname, "..");
const { CalendarRuntime } = require(path.join(base, 'ha.view/calendar-runtime'));
const { LayoutRuntime } = require(path.join(base, 'ha.view/layout-runtime'));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
const flush = async () => { for(let i=0;i<80;i++) await Promise.resolve(); };
function harness({ delayHelpers = false, delayEvents = false } = {}) {
 const read = deferred(), helpers = deferred(), intervals = new Map(), timers = new Map(), nodes = []; let next=0, reads=0;
 const element = name => {
  const n = {localName:name,style:{},isConnected:false,children:[],setAttribute(){},append(...children){this.children.push(...children);children.forEach(c=>c.isConnected=true);},attachShadow(){return element('shadow');},remove(){this.isConnected=false;},replaceChildren(){this.children=[];},addEventListener(name,fn){if(name==='view-changed')fn({detail:{start:new Date('2026-10-01'),end:new Date('2026-11-01')}});},requestUpdate(){},updateComplete:Promise.resolve()};
  if(name==='ha-full-calendar') { n.shadowRoot={querySelector:()=>({}),querySelectorAll:()=>[],append(){}}; n.calendar={setOption(){},view:{activeStart:new Date('2026-10-01'),activeEnd:new Date('2026-11-01'),type:'dayGridMonth'}}; }
  nodes.push(n);return n;
 };
 const root={hass:{connected:true,language:'en',config:{time_zone:'UTC'},states:{'calendar.real':{}},callApi(){reads++;return delayEvents && reads === 1 ? Promise.resolve([{entity_id:"calendar.real"}]) : read.promise;}}};
 const factory={createCardElement:()=>element('hui-calendar-card')};
 const window={loadCardHelpers:()=>delayHelpers ? helpers.promise : Promise.resolve(factory)};
 const context=vm.createContext({window,document:{body:element('body'),createElement:element,querySelector:()=>root},Date,Intl,customElements:{get:()=>undefined,whenDefined:async()=>{}},MutationObserver:class{observe(){}disconnect(){}},setTimeout(fn){const id=++next;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),setInterval(fn){const id=++next;intervals.set(id,fn);return id;},clearInterval:id=>intervals.delete(id)});
 const source={isDestroyed:()=>false,executeJavaScript:code=>Promise.resolve(vm.runInContext(code,context))};
 return {read,helpers,factory,intervals,timers,nodes,window,source,get reads(){return reads;}};
}
test('stop during initial production catalog read leaves no timers or mounted result',async()=>{
 const h=harness(), runtime=new CalendarRuntime();
 const started=runtime.start(h.source,'calendar',['calendar.real']);await flush();assert.equal(h.reads,1);
 runtime.stop();h.read.resolve([{entity_id:'calendar.real'}]);const result=await started;await flush();
 assert.equal(h.window.__haViewCalendarFace,undefined);assert.equal(h.nodes.filter(n=>n.localName==='div'&&n.isConnected&&n.style.cssText?.includes('position:fixed')).length,0);
 assert.equal(h.intervals.size,0,'disposed renderer must not allocate refresh interval after canceled read');assert.equal(h.timers.size,0);assert.equal(result.status,'stale');
});
test('layout stop while face update awaits does not mount either native half',async()=>{
 const gate=deferred(), scripts=[], runtime=new LayoutRuntime();const source={isDestroyed:()=>false,executeJavaScript:async code=>scripts.push(code)};
 const started=runtime.start({isDestroyed:()=>false,executeJavaScript:()=>gate.promise},{cards:[{type:'calendar'},{type:'upcoming'}]},()=>source,['calendar.real']);runtime.stop();gate.resolve();await started;
 assert.equal(scripts.length,2);assert.ok(scripts.every(s=>s.includes('disposePage')));
});

test('production renderer helper-load cancellation does not resurrect a host', async () => {
 const h=harness({delayHelpers:true}), runtime=new CalendarRuntime();
 const started=runtime.start(h.source,'calendar',['calendar.real']);await flush();
 assert.ok(h.window.__haViewCalendarFace);runtime.stop();h.helpers.resolve(h.factory);
 assert.equal((await started).status,'stale');await flush();assert.equal(h.reads,0);
 assert.equal(h.window.__haViewCalendarFace,undefined);assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);
});
test('production layout halves canceled during native event reads leave no timers', async () => {
 const h=harness({delayEvents:true}), runtime=new LayoutRuntime();
 await runtime.start({isDestroyed:()=>false,executeJavaScript:async()=>{}},{cards:[{type:'calendar'},{type:'calendar'}]},()=>h.source,['calendar.real']);await flush();
 assert.ok(h.window.__haViewLayoutLeft);assert.ok(h.window.__haViewLayoutRight);assert.ok(h.reads>=2);
 runtime.stop();h.read.resolve([]);await flush();
 assert.equal(h.window.__haViewLayoutLeft,undefined);assert.equal(h.window.__haViewLayoutRight,undefined);
 assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);
});
test('layout replacement while previous update waits only mounts latest generation',async()=>{
 const gate=deferred(), scripts=[], runtime=new LayoutRuntime();const source={isDestroyed:()=>false,executeJavaScript:async code=>scripts.push(code)};
 const old=runtime.start({isDestroyed:()=>false,executeJavaScript:()=>gate.promise},{cards:[{type:'calendar'},{type:'calendar'}]},()=>source,['calendar.old']);
 await runtime.start({isDestroyed:()=>false,executeJavaScript:async()=>{}},{cards:[{type:'calendar'},{type:'upcoming'}]},()=>source,['calendar.new']);gate.resolve();await old;
 const mounts=scripts.filter(s=>s.includes('async function mountPage'));assert.equal(mounts.length,2);assert.ok(mounts.every(s=>s.includes('calendar.new')));runtime.stop();
});
test('uncanceled production mount completes and normal stop clears its refresh timer',async()=>{
 const h=harness(), runtime=new CalendarRuntime();const started=runtime.start(h.source,'calendar',['calendar.real']);await flush();
 h.read.resolve([{entity_id:'calendar.real'}]);assert.equal((await started).status,'mounted');
 assert.ok(h.window.__haViewCalendarFace);assert.equal(h.intervals.size,2);runtime.stop();await flush();
 assert.equal(h.window.__haViewCalendarFace,undefined);assert.equal(h.intervals.size,0);assert.equal(h.timers.size,0);
});
