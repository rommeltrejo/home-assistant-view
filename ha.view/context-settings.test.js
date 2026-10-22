'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const handlers=new Map();let current, windows=[];
class Menu{constructor(){this.items=[];}append(i){this.items.push(i);}static getApplicationMenu(){return current;}static setApplicationMenu(m){current=m;}}
class MenuItem{constructor(o){Object.assign(this,o);}}
class BrowserWindow extends EventEmitter{constructor(){super();windows.push(this);this.webContents=new EventEmitter();Object.assign(this.webContents,{mainFrame:{},setWindowOpenHandler(){},loadFile:undefined});this.loadFile=()=>Promise.resolve();}isDestroyed(){return !!this.destroyed;}close(){this.destroyed=true;this.emit('closed');}focus(){}}
const electronPath=require.resolve('electron');require.cache[electronPath]={id:electronPath,filename:electronPath,loaded:true,exports:{Menu,MenuItem,BrowserWindow,ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}}};
const {install}=require('./context-settings');
test('context exact-frame Save, Cancel/Close/Escape discard, fresh reopen and disposed sender rejection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ha-context-')),file=path.join(dir,'rules.json');let updates=0;const interactions=[];
 const dispose=install({file,policy:{update(){updates++;}},changed(){},interaction:v=>interactions.push(v)});
 const event=()=>({sender:windows.at(-1).webContents,senderFrame:windows.at(-1).webContents.mainFrame});
 try{
 dispose.open(); const get=handlers.get('ha.view:context:get'),save=handlers.get('ha.view:context:save'),close=handlers.get('ha.view:context:close');const old=event();
 assert.equal(get(old).config.enabled,false);
 for(const fn of [get,save,close])assert.throws(()=>fn({...old,senderFrame:{}},{}),/Untrusted/);
 const config={enabled:true,rules:[{entity_id:'binary_sensor.example',state:'on',mode:'clock1'},{entity_id:'sensor.example',state:'ON',mode:'clock2'}]};save(old,config);const bytes=fs.readFileSync(file,'utf8');assert.equal(updates,1);close(old);assert.throws(()=>save(old,config),/Untrusted/);
 dispose.open();assert.deepEqual(get(event()).config,config);windows.at(-1).close();assert.equal(fs.readFileSync(file,'utf8'),bytes);
 dispose.open();let prevented=false;windows.at(-1).webContents.emit('before-input-event',{preventDefault(){prevented=true;}},{type:'keyDown',key:'Escape'});assert.ok(prevented);assert.equal(fs.readFileSync(file,'utf8'),bytes);
 dispose.open();assert.deepEqual(get(event()).config,config);const last=event();dispose();assert.throws(()=>get(last),/Untrusted/);dispose();assert.equal(handlers.size,0);assert.deepEqual(interactions,[true,false,true,false,true,false,true,false]);
 }finally{dispose();fs.rmSync(dir,{recursive:true,force:true});}
});
