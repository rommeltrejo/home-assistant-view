'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const store=require('./layout-store');
test('one full-width or two equal halves; no user geometry retained',()=>{
 assert.deepEqual(store.regions({cards:[{type:'clock1',x:.4,width:.2}]}),[{type:'clock1',x:0,width:1}]);
 assert.deepEqual(store.regions({cards:[{type:'calendar'},{type:'upcoming'}]}),[{type:'calendar',x:0,width:.5},{type:'upcoming',x:.5,width:.5}]);
 for(const cards of [[],[{type:'layout'}],[{type:'clock1'},{type:'clock2'},{type:'calendar'}]])assert.throws(()=>store.normalize({cards}));
});
test('two existing face instances persist; invalid save preserves disk; old freeform migrates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ha-slots-')),file=path.join(dir,'layout.json');
 try{const config=store.write(file,{cards:[{type:'clock2'},{type:'clock2'}]});assert.deepEqual(store.read(file),config);assert.throws(()=>store.write(file,{cards:[]}));assert.deepEqual(store.read(file),config);
 fs.writeFileSync(file,JSON.stringify({version:1,cards:[{type:'clock',x:.3},{type:'calendar'},{type:'upcoming'}]}));assert.deepEqual(store.read(file),{version:2,cards:[{type:'clock1'},{type:'calendar'}]});}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('layout is selectable/schedulable without calendar gating',()=>{
 assert.equal(require('./face-modes').fromLegacyFace('layout'),'layout');assert.ok(require('./day-schedule').validate({enabled:true,rules:[{time:'09:00',mode:'layout'}]}));assert.equal(new(require('./calendar-availability').CalendarAvailability)({contents:()=>null}).blocked('layout'),false);
});
test('native calendar scripts are independent, region bounded, and disposed on stop',async()=>{
 const {LayoutRuntime}=require('./layout-runtime'), scripts=[],source={isDestroyed:()=>false,executeJavaScript:async s=>scripts.push(s)},view={isDestroyed:()=>false,executeJavaScript:async()=>{}};
 const runtime=new LayoutRuntime();await runtime.start(view,{cards:[{type:'calendar'},{type:'upcoming'}]},()=>source,['calendar.real']);
 assert.equal(scripts.length,2);assert.ok(scripts[0].includes('"key":"__haViewLayoutLeft"'));assert.ok(scripts[1].includes('"key":"__haViewLayoutRight"'));assert.ok(scripts[1].includes('"x":0.5,"width":0.5'));assert.ok(scripts[0].includes('calendar.real'));runtime.stop();assert.equal(scripts.length,4);
});

// Load the actual hooks module without launching Electron; resolveInitialFace is
// the same helper init uses for its selectedFace assignment.
const hooksFile = path.join(__dirname, 'hooks.js');
const hooksModule = { exports: {} };
const hooksRequire = require('node:module').createRequire(hooksFile);
require('node:vm').runInNewContext(fs.readFileSync(hooksFile, 'utf8'), {
 require: id => id === 'electron' ? {} : hooksRequire(id),
 module: hooksModule, __dirname, console,
}, { filename: hooksFile });
const { resolveInitialFace } = hooksModule.exports;
test('hooks startup selection resolves every stable face ID and supported numeric index',()=>{
 const ids = require('./face-modes').FACE_IDS;
 for (const [offset, id] of ids.entries()) {
  for (const value of [id, offset + 1, String(offset + 1)]) assert.equal(resolveInitialFace(value), offset + 1);
 }
 for (const value of [undefined, null, '', 'invalid', 'dashboard', 0, 7, -1, 2.5, '3.5', NaN, Infinity, true, [], {}])
  assert.equal(resolveInitialFace(value), 2);
});
test('hooks startup fallback preserves saved preference priority and legacy clock2',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ha-initial-face-')),file=path.join(dir,'face.json');
 const ids = require('./face-modes').FACE_IDS;
 try {
  for (const [offset, id] of ids.entries()) {
   for (const value of [id, offset + 1, String(offset + 1)]) assert.equal(resolveInitialFace(value,file),offset + 1);
  }
  fs.writeFileSync(file,'invalid json');assert.equal(resolveInitialFace('layout',file),5);
  fs.writeFileSync(file,JSON.stringify({mode:'invalid',face:3}));assert.equal(resolveInitialFace('upcoming',file),4);
  assert.equal(resolveInitialFace('invalid',file),2);
  for (const [offset, id] of ids.entries()) {
   fs.writeFileSync(file,JSON.stringify({mode:id}));
   for (const value of [...ids,1,2,3,4,5,undefined,'invalid']) assert.equal(resolveInitialFace(value,file),offset + 1);
  }
  fs.writeFileSync(file,JSON.stringify({face:2}));assert.equal(resolveInitialFace('layout',file),2);
  fs.writeFileSync(file,JSON.stringify({face:1}));assert.equal(resolveInitialFace('clock2',file),1);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
