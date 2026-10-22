'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepare } = require('./source');
const exe='/fixture/Electron.app/Contents/MacOS/Electron';
test('other platforms do not sign',()=>assert.equal(prepare(exe,{platform:'win32',run:()=>{throw Error('called')}}),false));
test('reject non-source bundle',()=>assert.throws(()=>prepare('/fixture/HA.app/Contents/MacOS/HA',{platform:'darwin'}),/non-source/));
function fixture(valid=false,id='com.github.Electron',fail=false){const calls=[];return {calls,run:(bin,args)=>{calls.push(args);if(bin.endsWith('PlistBuddy'))return {status:0,stdout:id};if(args[0]==='-dvv')return {status:0,stderr:valid?'Identifier=com.github.Electron\nInfo.plist entries=31':'Identifier=Electron\nInfo.plist=not bound'};if(args[0]==='--force'){valid=!fail;return {status:fail?1:0,stderr:'failure'}}return {status:valid?0:1}}}}
test('valid bound signature is idempotent',()=>{const f=fixture(true);assert.equal(prepare(exe,{platform:'darwin',run:f.run}),false);assert.equal(f.calls.length,3)});
test('repairs unbound signature and verifies',()=>{const f=fixture();assert.equal(prepare(exe,{platform:'darwin',run:f.run}),true);assert.deepEqual(f.calls[3],['--force','--deep','--sign','-','--identifier','com.github.Electron','/fixture/Electron.app']);assert.equal(f.calls.length,6)});
test('unexpected identity fails closed',()=>{const f=fixture(false,'org.other');assert.throws(()=>prepare(exe,{platform:'darwin',run:f.run}),/Unexpected/);assert.equal(f.calls.length,1)});
test('signing failure does not launch',()=>{const f=fixture(false,undefined,true);assert.throws(()=>prepare(exe,{platform:'darwin',run:f.run}),/preparation failed/)});

test('final signature verification failure fails closed',()=>{const f=fixture();const run=(bin,args)=>{if(args[0]==='--verify' && f.calls.some(a=>a[0]==='--force'))return {status:1,stderr:'invalid'};return f.run(bin,args)};assert.throws(()=>prepare(exe,{platform:'darwin',run}),/signature verification failed/)});
for (const detail of ['Identifier=org.wrong\nInfo.plist entries=31','Identifier=com.github.Electron\nInfo.plist=not bound']) {
 test(`post-sign identity fails closed: ${detail}`,()=>{const f=fixture();const run=(bin,args)=>{if(args[0]==='-dvv' && f.calls.some(a=>a[0]==='--force'))return {status:0,stderr:detail};return f.run(bin,args)};assert.throws(()=>prepare(exe,{platform:'darwin',run}),/post-sign identity/)});
}

test('bundled bootstrap preserves source identity and path',()=>{const vm=require('node:vm');const {bootstrap}=require('./source');const calls=[];const app={setName:n=>calls.push(n),setVersion:v=>calls.push(v),setAppPath:p=>calls.push(p)};const argv=['Electron','--web-url=http://ha.example.test'];vm.runInNewContext(bootstrap('/fixture/source'),{process:{argv},require:id=>id==='electron'?{app}:id==='node:path'?require('node:path'):id.endsWith('package.json')?{name:'ha.view',version:'1.6.0',main:'index.js'}:calls.push(id)});assert.deepEqual(calls,['ha.view','1.6.0','/fixture/source','/fixture/source/index.js']);assert.deepEqual(argv,['Electron','--web-url=http://ha.example.test'])});
test('LaunchServices args preserve caller URL and do not weaken security',()=>{const {launchArguments}=require('./source');assert.deepEqual(launchArguments('/cache/Electron.app',['--app-kiosk=framed','--web-url=http://ha.example.test']),['-n','-W','/cache/Electron.app','--args','--trace-warnings','--app-kiosk=framed','--web-url=http://ha.example.test'])});
