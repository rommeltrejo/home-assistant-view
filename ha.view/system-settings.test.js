'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),path=require('node:path'),fs=require('node:fs');
const registry=require('./menu'),{install}=require('./system-settings'),{createSettings}=require('./browser');
function fixture(browserSettings){
 const handlers=new Map(),views=[],children=[],parent=new EventEmitter();let destroyed=false,allowed=true,current=null;const interactions=[],returns=[];
 Object.assign(parent,{isDestroyed:()=>destroyed,getContentBounds:()=>({width:900,height:600}),contentView:{addChildView:v=>children.push(v),removeChildView:v=>children.splice(children.indexOf(v),1)}});
 class View{constructor(options){this.options=options;views.push(this);this.webContents=new EventEmitter();const wc=this.webContents;Object.assign(wc,{mainFrame:{},url:'',getURL:()=>wc.url,isDestroyed:()=>!!wc.destroyed,close:()=>{wc.destroyed=true;},focus(){},setWindowOpenHandler:fn=>{this.popup=fn;},loadFile:file=>{wc.url=require('node:url').pathToFileURL(file).href;return Promise.resolve();}});}setBounds(b){this.bounds=b;}setVisible(v){this.visible=v;}setBackgroundColor(c){this.background=c;}}
 class Menu{constructor(){this.items=[];}append(i){this.items.push(i);}static getApplicationMenu(){return current;}static setApplicationMenu(m){current=m;}}
 const e={platform:'linux',WebContentsView:View,Menu,MenuItem:class{constructor(o){Object.assign(this,o);}},ipcMain:{handle:(k,v)=>handlers.set(k,v),removeHandler:k=>handlers.delete(k)}};
 const controller=install({electron:e,parent,browserSettings,allowed:()=>allowed,interaction:v=>interactions.push(v),closed:o=>returns.push(o),target:()=>({dashboard:true})});
 return {e,controller,parent,handlers,views,children,interactions,returns,event:()=>({sender:views.at(-1).webContents,senderFrame:views.at(-1).webContents.mainFrame}),block:()=>{allowed=false;},destroy:()=>{destroyed=true;parent.emit('closed');}};
}
test('same-parent shield ownership, exact frame/document trust, resize, navigation deny and cleanup',()=>{
 const f=fixture();f.controller.open('chooser');const v=f.views[0],event=f.event();assert.deepEqual(v.bounds,{x:0,y:0,width:900,height:600});assert.equal(v.background,'#00000000');assert.equal(v.options.webPreferences.sandbox,true);assert.equal(v.options.webPreferences.nodeIntegration,false);assert.deepEqual(v.popup(),{action:'deny'});
 for(const name of ['get','run','close']){const fn=f.handlers.get('ha.view:system:'+name);assert.throws(()=>fn({...event,senderFrame:{}},'x'),/Untrusted/);assert.throws(()=>fn({...event,sender:{}},'x'),/Untrusted/);}
 const url=v.webContents.url;v.webContents.url='file:///wrong.html';assert.throws(()=>f.handlers.get('ha.view:system:get')(event),/Untrusted/);v.webContents.url=url;
 assert.throws(()=>f.handlers.get('ha.view:system:run')(event,'unknown'),/Unknown/);assert.equal(f.children.length,1);
 let prevented=0;v.webContents.emit('will-frame-navigate',{preventDefault(){prevented++;}});v.webContents.emit('before-input-event',{preventDefault(){prevented++;}},{type:'keyDown',key:'Escape'});assert.equal(prevented,2);assert.deepEqual(f.returns,['chooser']);assert.equal(f.children.length,0);assert.equal(v.webContents.destroyed,true);assert.throws(()=>f.handlers.get('ha.view:system:get')(event),/Untrusted/);
 f.controller.open();f.parent.emit('resize');f.controller();f.controller();assert.equal(f.handlers.size,0);assert.equal(f.parent.eventNames().length,0);
});
test('bounded handoff resumes only on tool close; OFF, blocked ownership and parent close cancel reopening',()=>{
 const f=fixture();let calls=0;const unregister=registry.register(f.e,'tool',[{order:1,label:'Tool',click:()=>calls++}]);
 const run=()=>f.handlers.get('ha.view:system:run')(f.event(),registry.list(f.e)[0].id);
 f.controller.open('chooser');run();assert.equal(calls,1);assert.equal(f.children.length,0);assert.equal(f.controller.toolClosed(),true);assert.equal(f.children.length,1);assert.equal(f.controller.toolClosed(),false);
 run();f.controller.close('off');assert.equal(f.controller.toolClosed(),false);assert.equal(f.children.length,0);
 f.controller.open();run();f.block();assert.equal(f.controller.toolClosed(),false);assert.equal(f.children.length,0);f.controller();unregister();
 const g=fixture();g.controller.open();g.parent.emit('close');assert.equal(g.controller.open(),false);g.destroy();assert.equal(g.handlers.size,0);assert.equal(g.controller.toolClosed(),false);
});
test('native Close does not recreate settings on parent closing; temporary action cleanup invalidates IDs',()=>{
 const f=fixture();f.parent.close=()=>f.parent.emit('close');const native=new f.e.Menu();native.append(new f.e.MenuItem({role:'close',label:'Close window',click:()=>f.parent.emit('close')}));f.e.Menu.setApplicationMenu(native);
 f.controller.open();f.handlers.get('ha.view:system:run')(f.event(),'native:close');assert.equal(f.views.length,1);assert.equal(f.children.length,0);f.controller();
});
test('chooser adjacent stable native System target, compact tool styling, Close controls and runtime allowlist',()=>{
 const read=file=>fs.readFileSync(path.join(__dirname,file),'utf8');assert.match(read('face-changer.html'),/id="system">Settings<\/button>/);assert.match(read('hooks.js'),/\['cancel','system','hide'\]/);assert.doesNotMatch(read('system-settings.html'),/Testing tools|readiness|future/i);
 for(const file of ['management.html','camera-settings.html']){assert.match(read(file),/id="close">Close/);assert.match(read(file),/tool-modal.css/);assert.match(read(file),/modal-interaction.js/);}
 for(const file of ['management.js','camera-dashboard.js','context-settings.js'])assert.match(read(file),/modal: true, fullscreenable: false/);
 assert.match(read('layout-editor.html'),/body class="layout-settings"/);assert.match(read('modal-interaction.js'),/event.key !== 'Tab'/);
 for(const file of ['system-settings.js','system-settings.html','system-settings-preload.js','system-settings-renderer.js','system-settings.css','tool-modal.css','modal-interaction.js'])assert.ok(require('./build/files').assets.has('ha.view/'+file));
});

test('system browser visibility IPC trusts exact frame and shares persistent setting', t => {
 const os=require('node:os');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ha-system-browser-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const settings=createSettings(path.join(dir,'browser.json'));const f=fixture(settings);f.controller.open();
 const get=f.handlers.get('ha.view:system:get'),save=f.handlers.get('ha.view:system:browser-icon'),event=f.event();
 assert.equal(get(event).showBrowserIcon,true);
 assert.throws(()=>save({...event,senderFrame:{}},false),/Untrusted/);
 assert.throws(()=>save(event,'false'),/Invalid/);
 assert.equal(save(event,false),false);assert.equal(get(event).showBrowserIcon,false);
 assert.equal(createSettings(path.join(dir,'browser.json')).showIcon,false);
 f.controller();assert.equal(f.handlers.size,0);
});
