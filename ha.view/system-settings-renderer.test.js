'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
function element(tag) {
  return { tag, children: [], textContent: '', disabled: false, open: false,
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, fn) { this[name] = fn; },
    set innerHTML(_) { throw Error('Unsafe HTML'); } };
}
async function fixture(file, window, ids) {
  const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
  vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), {
    window: { addEventListener() {}, ...window },
    document: { getElementById: id => nodes[id], createElement: element }
  });
  await new Promise(resolve => setImmediate(resolve));
  return nodes;
}
const entries = [
  ['faces:1', 'Automatic faces…'], ['layout:2', 'Edit split layout…'],
  ['context:3', 'State-based face rules…'], ['management:4', 'Home Assistant management…'],
  ['cameras:5', 'Camera Dashboard…']
].map(([id, label]) => ({ id, label, group: '<img onerror=evil()>' }));
test('only registered HA actions render, with two core rows and collapsed Advanced', async () => {
  const runs = []; let closed = false;
  const nodes = await fixture('./system-settings-renderer.js', { systemSettings: {
    get: async () => ({ actions: [...entries, ...['reload','copy','close','quit','toggledevtools'].map(id => ({id:`native:${id}`,label:'Automatic faces…'})), {id:'other:9',label:'Automatic faces…'}], showBrowserIcon: true }),
    run: async id => runs.push(id), close: () => { closed = true; }
  } }, ['actions','status','close']);
  const [toggle, core, advanced] = nodes.actions.children;
  assert.equal(toggle.children[0].textContent, 'Show browser icon'); assert.equal(toggle.children[1].checked, true);
  assert.equal(core.children.length, 2); assert.equal(advanced.tag, 'details'); assert.equal(advanced.open, false);
  assert.equal(advanced.children[0].textContent, 'Advanced — Experimental');
  const buttons = [...core.children, ...advanced.children.slice(1)];
  assert.deepEqual(buttons.map(b => b.children[0].textContent), ['Face Settings','Split Layout','State-based Faces — Experimental','Home Assistant — Experimental','Camera Dashboard — Experimental']);
  assert.deepEqual(buttons.map(b => b.children[1].textContent), ['Choose what appears when the screen is idle.','Choose the two faces shown together.','Change the idle face when a Home Assistant entity changes.','Open devices, entities, automations, or activity.','Choose an existing Home Assistant camera dashboard.']);
  for (const button of buttons) await button.onclick();
  assert.deepEqual(runs, entries.map(e => e.id)); nodes.close.onclick(); assert.equal(closed, true);
});
test('native-only or unknown entries do not produce an Advanced placeholder', async () => {
  const nodes = await fixture('./system-settings-renderer.js', {systemSettings:{get:async()=>({actions:[{id:'native:reload',label:'Reload'},{id:'faces:8',label:'<script>bad()</script>'}],showBrowserIcon:true})}}, ['actions','status','close']);
  assert.equal(nodes.actions.children.length, 1); assert.equal(nodes.status.textContent, '');
});
test('disabled actions stay disabled and failed actions can be retried', async () => {
  const nodes = await fixture('./system-settings-renderer.js', {systemSettings:{get:async()=>({actions:[{...entries[0],enabled:false},entries[1]],showBrowserIcon:true}),run:async()=>{throw Error('unavailable');}}}, ['actions','status','close']);
  const [disabled, enabled] = nodes.actions.children[1].children;
  assert.equal(disabled.disabled,true); enabled.onclick(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(enabled.disabled,false); assert.match(nodes.status.textContent,/Settings unavailable/);
});
test('management uses local concise helpers, safe text and exact known status mapping', async () => {
  let update, activity;
  const nodes = await fixture('./management-renderer.js', {nativeManagement:{
    status:fn=>{update=fn;return()=>{};}, activityStatus:fn=>{activity=fn;return()=>{};},
    get:async()=>({message:'Choose an existing native HA page. Route access is not verified device control.', pages:[{id:'devices',label:'<img onerror=evil()>',path:'/devices',guidance:'Future verification paragraph'}]}),
    open:async()=>({message:'Custom actual error <script>bad()</script>'})
  }}, ['status','activity-state','activity-output','read-activity','activity-hours','pages','close']);
  assert.equal(nodes.status.textContent,'Choose a Home Assistant page.');
  const [button, helper] = nodes.pages.children[0].children;
  assert.equal(button.textContent,'Open <img onerror=evil()>'); assert.equal(helper.textContent,'Open the Home Assistant device list.');
  await button.click(); assert.equal(nodes.status.textContent,'Custom actual error <script>bad()</script>');
  update({state:'page-present',message:'Unrecognized failure'}); assert.equal(nodes.status.textContent,'Unrecognized failure');
  update({message:'Native route loaded; page content, permissions and controls are not yet verified.'}); assert.equal(nodes.status.textContent,'Page navigation finished. Close this window to check the page.');
  activity({state:'ready',start:'start',end:'end',received:600,count:500,shown:20,output:'<script>records</script>',truncated:true});
  assert.match(nodes['activity-output'].textContent,/600 records returned; 500 processed; 20 shown/);
  assert.match(nodes['activity-output'].textContent,/<script>records<\/script>/); assert.match(nodes['activity-output'].textContent,/limited subset/);
  activity({state:'empty'}); assert.equal(nodes['activity-output'].textContent,'');
});

test('system browser switch invokes shared setter and rolls back on failure', async () => {
  let selected;
  const nodes = await fixture('./system-settings-renderer.js', {systemSettings:{get:async()=>({actions:[],showBrowserIcon:true}),setBrowserIcon:async value=>{selected=value;return value;}}}, ['actions','status','close']);
  const toggle = nodes.actions.children[0].children[1];
  toggle.checked=false; await toggle.onchange(); assert.equal(selected,false); assert.equal(toggle.checked,false);
  const failed = await fixture('./system-settings-renderer.js', {systemSettings:{get:async()=>({actions:[],showBrowserIcon:false}),setBrowserIcon:async()=>{throw Error('readonly');}}}, ['actions','status','close']);
  const bad=failed.actions.children[0].children[1]; bad.checked=true; await bad.onchange();
  assert.equal(bad.checked,false); assert.match(failed.status.textContent,/not saved/);
});

test('camera settings guidance names explicit configuration without guessing wording', () => {
  const source = fs.readFileSync(require.resolve('./camera-dashboard'), 'utf8');
  assert.match(source, /HA View opens only the dashboard you configure\./);
  assert.doesNotMatch(source, /will not guess one/);
});
