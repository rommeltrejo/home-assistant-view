'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {register,list,run,refresh}=require('./menu');
test('all HA.View menu contributors use shared registration and runtime manifest closes local dependencies',()=>{
 const fs=require('node:fs'),path=require('node:path'),{assets}=require('./build/files');
 for(const file of ['day-schedule-settings.js','layout-editor.js','context-settings.js','management.js','camera-dashboard.js']){
  const source=fs.readFileSync(path.join(__dirname,file),'utf8');assert.match(source,/require\('\.\/menu'\)\.register/);assert.doesNotMatch(source,/setApplicationMenu/);
 }
 for(const file of ['menu.js','context.css','face-settings.css'])assert.ok(assets.has('ha.view/'+file));
 for(const asset of assets){
  assert.ok(fs.existsSync(path.join(__dirname,'..',asset)),asset);
  if(!asset.endsWith('.js'))continue;
  const source=fs.readFileSync(path.join(__dirname,'..',asset),'utf8');
  for(const match of source.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)){
   let resolved=path.posix.normalize(path.posix.join(path.posix.dirname(asset),match[1]));if(!path.posix.extname(resolved))resolved+='.js';assert.ok(assets.has(resolved),asset+' -> '+resolved);
  }
 }
});
function fixture(platform='linux') {
 let current=null;
 class Menu {
  constructor(){this.items=[];} append(i){this.items.push(i);}
  static getApplicationMenu(){return current;} static setApplicationMenu(m){current=m;}
  static buildFromTemplate(template){const m=new Menu();for(const item of template){
   const submenu=Array.isArray(item.submenu)?Menu.buildFromTemplate(item.submenu):item.submenu;
   m.append(new MenuItem({...item, ...(submenu ? {submenu} : {})}));
  }return m;}
 }
 class MenuItem{constructor(o){Object.assign(this,o);if(this.role)this.role=this.role.toLowerCase();}}
 return {e:{Menu,MenuItem,platform},get:()=>current,set:m=>{current=m;}};
}
test('native menus persist while temporary tools stay in Settings and the face shortcut is removed on disposal',()=>{
 const f=fixture();let calls=0;const a=register(f.e,'a',[{order:1,label:'Temporary',click:()=>calls++}]);const id=list(f.e)[0].id;
 assert.deepEqual(f.get().items.map(i=>i.role),['filemenu','editmenu','viewmenu','windowmenu','help']);const b=register(f.e,'a',[{order:1,label:'Replacement',click:()=>calls++}]);a();assert.equal(list(f.e)[0].label,'Replacement');assert.throws(()=>run(f.e,id,{}),/Unknown/);
 const c=register(f.e,'faces',[{order:1,label:'Show a face now…',click:()=>calls++}]);assert.deepEqual(f.get().items.at(-2).submenu.items.map(i=>i.label),['Show a face now…']);
 assert.equal(f.get().items.at(-1).label,'Help');assert.deepEqual(f.get().items.at(-1).submenu.items,[]);
 assert.equal(f.get().items.some(i=>/testing|settings/i.test(i.label||'')),false);
 assert.equal(list(f.e).length,1);run(f.e,list(f.e)[0].id,{});assert.equal(calls,1);b();c();assert.deepEqual(f.get().items.map(i=>i.role),['filemenu','editmenu','viewmenu','windowmenu','help']);
});
test('late native defaults discovered by role, fullscreen excluded, OS appMenu retained only on macOS',()=>{
 const f=fixture('darwin');register(f.e,'a',[]);let received;
 const native=new f.e.Menu();const submenu=new f.e.Menu();submenu.append(new f.e.MenuItem({role:'copy',label:'Copy',click:(_e,w,wc)=>{received=[w,wc];}}));submenu.append(new f.e.MenuItem({role:'togglefullscreen',label:'Fullscreen'}));native.append(new f.e.MenuItem({label:'Edit',submenu}));f.set(native);
 const entries=list(f.e);assert.deepEqual(entries.map(e=>e.id),['native:copy']);const w={},wc={copy(){received=[w,this];}};run(f.e,'native:copy',w,wc);assert.deepEqual(received,[w,wc]);assert.throws(()=>run(f.e,'native:togglefullscreen',w,wc));refresh(f.e);assert.deepEqual(f.get().items.map(i=>i.role),['appmenu','filemenu','editmenu','viewmenu','windowmenu','help']);
});
test('macOS keeps native menu order without reviving Settings or testing commands',()=>{
 const f=fixture('darwin');let chosen=0;
 const stop=register(f.e,'tools',[{label:'Camera Dashboard…',click(){throw Error('Not desktop chrome');}}]);
 const face=register(f.e,'faces',[{label:'Show a face now…',click(){chosen++;}}]);
 const items=f.get().items;
 assert.deepEqual(items.map(i=>i.role),['appmenu','filemenu','editmenu','viewmenu','windowmenu',undefined,'help']);
 assert.deepEqual(items.find(i=>i.label==='HA View').submenu.items.map(i=>i.label),['Show a face now…']);
 assert.equal(items.at(-1).submenu.items.length,0);
 assert.equal(items.flatMap(i=>[i.label,...(i.submenu?.items||[]).map(child=>child.label)]).some(label=>/Camera Dashboard|Testing|Settings/.test(label||'')),false);
 items.find(i=>i.label==='HA View').submenu.items[0].click();assert.equal(chosen,1);
 stop();face();assert.deepEqual(f.get().items.map(i=>i.role),['appmenu','filemenu','editmenu','viewmenu','windowmenu','help']);
});
function nativeFixture(roleNames, fallback=false) {
 const f=fixture();
 const make=()=>{const menu=new f.e.Menu();for(const role of roleNames)menu.append(new f.e.MenuItem({role,label:role,click(){throw Error('Must not use role click');}}));return menu;};
 if(fallback){const original=f.e.Menu.buildFromTemplate;let first=true;f.e.Menu.buildFromTemplate=function(template){if(first){first=false;return make();}return original.call(this,template);};}else f.set(make());
 return f;
}
test('actual lowercase roles and mixed-case source roles produce canonical IDs in current and fallback discovery',()=>{
 const names=['pasteAndMatchStyle','selectAll','forceReload','toggleDevTools','resetZoom','zoomIn','zoomOut','hideOthers','unhide','zoom','togglefullscreen'];
 const expected=names.slice(0,7).map(role=>'native:'+role.toLowerCase());
 for(const fallback of [false,true]){
  const f=nativeFixture(names,fallback);assert.deepEqual(list(f.e).map(e=>e.id),expected);
  for(const role of names.slice(7))assert.throws(()=>run(f.e,'native:'+role.toLowerCase(),{},{}),/Unknown/);
 }
});
test('native dispatch uses only captured dashboard, parent, or app documented methods',()=>{
 const mapping={undo:'undo',redo:'redo',cut:'cut',copy:'copy',paste:'paste',pasteandmatchstyle:'pasteAndMatchStyle',delete:'delete',selectall:'selectAll',reload:'reload',forcereload:'reloadIgnoringCache',minimize:'minimize',close:'close',front:'focus',about:'showAboutPanel',hide:'hide',quit:'quit'};
 const f=nativeFixture(Object.keys(mapping));list(f.e);
 for(const [role,method] of Object.entries(mapping)){
  const calls=[];const parent={isDestroyed:()=>false},dashboard={isDestroyed:()=>false};f.e.app={};
  const target=['minimize','close','front'].includes(role)?parent:['about','hide','quit'].includes(role)?f.e.app:dashboard;
  target[method]=function(...args){assert.equal(this,target);calls.push([method,args]);};
  assert.equal(run(f.e,'native:'+role,parent,dashboard),'native');assert.deepEqual(calls,[[method,[]]]);
 }
});
test('zoom and developer tools dispatch to captured contents with explicit state',()=>{
 const f=nativeFixture(['resetzoom','zoomin','zoomout','toggledevtools']);list(f.e);let level=2,opened=false;const calls=[];
 const wc={isDestroyed:()=>false,getZoomLevel:()=>level,setZoomLevel:v=>{level=v;calls.push(v);},isDevToolsOpened:()=>opened,openDevTools:()=>{opened=true;calls.push('open');},closeDevTools:()=>{opened=false;calls.push('close');}};
 for(const role of ['zoomin','zoomout','resetzoom','toggledevtools','toggledevtools'])assert.equal(run(f.e,'native:'+role,{},wc),'native');
 assert.deepEqual(calls,[2.5,2,0,'open','close']);
});
test('disabled, missing, destroyed and unsupported targets never report native success or fall back to focused window',()=>{
 const f=nativeFixture(['copy','close','quit']);list(f.e);
 f.e.BrowserWindow={getFocusedWindow(){throw Error('No focused-window fallback');}};
 for(const wc of [undefined,{}, {isDestroyed:()=>true,copy(){throw Error('Destroyed target called');}}])assert.throws(()=>run(f.e,'native:copy',{},wc),/Unsupported or unavailable/);
 assert.throws(()=>run(f.e,'native:close',{isDestroyed:()=>true,close(){}},{}),/Unsupported or unavailable/);
 assert.throws(()=>run(f.e,'native:quit',{},{}),/Unsupported or unavailable/);
 assert.throws(()=>run(f.e,'native:Copy',{}, {copy(){}}),/Unknown/);
 const disabled=nativeFixture(['reload']);disabled.get().items[0].enabled=false;assert.equal(list(disabled.e)[0].enabled,false);assert.throws(()=>run(disabled.e,'native:reload',{}, {reload(){throw Error('Disabled action called');}}),/disabled/);
});
test('explicit native parent Close handoff never recreates System Settings',()=>{
 const {EventEmitter}=require('node:events'),{install}=require('./system-settings');
 const f=nativeFixture(['close']),parent=new EventEmitter(),handlers=new Map(),views=[];
 Object.assign(parent,{isDestroyed:()=>false,close(){this.emit('close');},getContentBounds:()=>({width:800,height:600}),contentView:{addChildView(){},removeChildView(){}}});
 f.e.ipcMain={handle:(name,fn)=>handlers.set(name,fn),removeHandler:name=>handlers.delete(name)};
 f.e.WebContentsView=class{
  constructor(){views.push(this);const wc=new EventEmitter();this.webContents=wc;Object.assign(wc,{mainFrame:{},isDestroyed:()=>!!wc.destroyed,getURL:()=>wc.url,focus(){},setWindowOpenHandler(){},loadFile(file){wc.url=require('node:url').pathToFileURL(file).href;return Promise.resolve();},close(){wc.destroyed=true;}});}
  setBounds(){} setVisible(){} setBackgroundColor(){}
 };
 const controller=install({electron:f.e,parent,allowed:()=>true,interaction(){},closed(){},target:()=>({})});
 controller.open();const wc=views[0].webContents;
 handlers.get('ha.view:system:run')({sender:wc,senderFrame:wc.mainFrame},'native:close');
 assert.equal(wc.destroyed,true);assert.equal(views.length,1);assert.equal(controller.open(),false);assert.equal(controller.toolClosed(),false);controller();
});
