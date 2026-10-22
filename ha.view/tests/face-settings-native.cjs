/* Run with Electron, not node --test. Uses production modal/preload/IPC, temporary profile/store. */
'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-face-settings-native-'));
app.setPath('userData', path.join(tmp, 'profile'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let parent, dispose;
  try {
    parent = new BrowserWindow({ width:640, height:480, show:false, webPreferences:{ sandbox:true } });
    await parent.loadURL('data:text/html,<title>Isolated settings regression</title><button>Underlying face</button>');
    let view, updates = 0;
    const original = parent.contentView.addChildView.bind(parent.contentView);
    parent.contentView.addChildView = child => { view = child; child.webContents.setBackgroundThrottling(false); original(child); };
    const file = path.join(tmp, 'settings.json');
    const store = require('../day-schedule');
    store.write(file, { enabled:true, idleMs:120000, rules:Array.from({length:20},(_,i)=>({time:`${String(i).padStart(2,'0')}:00`,mode:'calendar'})), strategy:'daily', rotationMs:300000, rotationFaces:['clock1','calendar'], calendarEntities:['calendar.fixture'] });
    let inhibited = false; const transitions = [];
    dispose = require('../day-schedule-settings').install({parent,file,schedule:{update(){updates++;}},interaction(open){inhibited=open;transitions.push(open);},calendars:async()=>({status:'ok',calendars:Array.from({length:12},(_,i)=>({entity_id:i?'calendar.'+i:'calendar.fixture',name:'Long readable calendar name '+i}))})});
    const evaluate = code => view.webContents.executeJavaScript(code, true);
    const open = async () => { dispose.open(); await new Promise(resolve => view.webContents.once('did-finish-load', resolve)); await delay(100); assert.equal(inhibited,true); };
    const key = async (keyCode,modifiers=[]) => {view.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')view.webContents.sendInputEvent({type:'char',keyCode:'\r',modifiers});view.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await delay(70);};
    await open();
    assert.equal(await evaluate("document.querySelector('details').open"), false);
    for (const [width,height] of [[320,480],[640,480],[1280,800]]) {
      dispose.close(); parent.setContentSize(width,height); await delay(150); await open();
      view.setBounds({x:0,y:0,width,height}); await delay(150);
      for (const strategy of ['daily','rotation']) {
        await evaluate(`document.querySelector('#strategy').value='${strategy}';document.querySelector('#strategy').dispatchEvent(new Event('change'));`);
        for(const expanded of [false,true]) {
          await evaluate(`document.querySelector('details').open=${expanded}`);
          const geometry=await evaluate(`(()=>{const d=document.querySelector('#dialog'),controls={};for(const [name,id] of [['save','save'],['cancel','close']]){const e=document.getElementById(id),r=e.getBoundingClientRect(),style=getComputedStyle(e);controls[name]={bounds:[r.x,r.y,r.right,r.bottom],width:r.width,height:r.height,visible:style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0};}return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,contentOverflow:document.querySelector('.settings-content').scrollWidth>document.querySelector('.settings-content').clientWidth,dialogOverflow:d.scrollWidth>d.clientWidth,controls}})()`);
          const targets=await evaluate("[...document.querySelectorAll('button,input,select,summary')].filter(e=>e.getClientRects().length).map(e=>{const r=e.getBoundingClientRect();return {id:e.id,width:r.width,height:r.height}})");for(const t of targets){assert.ok(t.width>=44&&t.height>=44,JSON.stringify(t));}
          assert.equal(geometry.width,width);assert.equal(geometry.height,height);assert.equal(geometry.overflow,false,JSON.stringify(geometry));assert.equal(geometry.contentOverflow,false,JSON.stringify(geometry));assert.equal(geometry.dialogOverflow,false,JSON.stringify(geometry));
          for (const [name,control] of Object.entries(geometry.controls)) {
            const evidence=JSON.stringify({name,...geometry});
            assert.equal(control.visible,true,evidence);
            assert.ok(control.bounds[0]>=0&&control.bounds[1]>=0&&control.bounds[2]<=geometry.width&&control.bounds[3]<=geometry.height,evidence);
            assert.ok(control.width>=44&&control.height>=44,evidence);
          }
          const scrolling=await evaluate(`(()=>{const content=document.querySelector('.settings-content'),save=document.querySelector('#save'),before=save.getBoundingClientRect().top;content.scrollTop=content.scrollHeight;return {scrollable:content.scrollHeight>content.clientHeight,scrolled:content.scrollTop>0,pinned:save.getBoundingClientRect().top===before}})()`);
          assert.equal(scrolling.pinned,true,JSON.stringify(scrolling));
          if(strategy==='daily'||expanded){assert.equal(scrolling.scrollable,true,JSON.stringify(scrolling));assert.equal(scrolling.scrolled,true,JSON.stringify(scrolling));}
          console.log('GEOMETRY',width,height,strategy,expanded?'expanded':'closed',JSON.stringify(geometry));
        }
      }
    }
    await evaluate("document.querySelector('details').open=false;document.querySelector('summary').focus()");
    await key('Space');assert.equal(await evaluate("document.querySelector('details').open"),true);assert.equal(inhibited,true);
    await key('Enter');assert.equal(await evaluate("document.querySelector('details').open"),false);
    await key('Tab');assert.equal(await evaluate('document.activeElement.id'),'close','collapsed calendar inputs skipped');
    await evaluate("document.querySelector('#save').focus()");await key('Tab');assert.equal(await evaluate('document.activeElement.id'),'dismiss');
    await key('Tab',['shift']);assert.equal(await evaluate('document.activeElement.id'),'save');
    const before=fs.readFileSync(file,'utf8');
    await evaluate("document.querySelector('#idle-minutes').value='3';document.querySelector('#save').focus()");await key('Enter');
    assert.equal(updates,1);assert.equal(store.read(file).config.idleMs,180000);assert.notEqual(fs.readFileSync(file,'utf8'),before);assert.equal(inhibited,true,'save keeps modal inhibition');
    const saved=fs.readFileSync(file,'utf8');
    await evaluate("document.querySelector('#idle-minutes').value='4';document.querySelector('#close').focus()");await key('Space');assert.equal(inhibited,false);assert.equal(fs.readFileSync(file,'utf8'),saved);
    await open();assert.equal(await evaluate("document.querySelector('#idle-minutes').value"),'3');assert.equal(await evaluate("document.querySelector('details').open"),false);
    assert.equal(await evaluate("(()=>{const e=new PointerEvent('pointerdown',{bubbles:true,cancelable:true});document.querySelector('#backdrop').dispatchEvent(e);return e.defaultPrevented})()"),true);assert.equal(inhibited,true);
    await key('Escape');assert.equal(inhibited,false);assert.equal(fs.readFileSync(file,'utf8'),saved);
    console.log('PASS native disclosure Space/Enter, focus wrap/hidden descendants, Save persistence, Cancel discard, Escape, backdrop protection, settings inhibition',JSON.stringify(transitions));
    dispose(); parent.destroy(); fs.rmSync(tmp,{recursive:true,force:true});app.exit(0);
  } catch(error) { console.error(error); if(dispose)dispose();if(parent&&!parent.isDestroyed())parent.destroy();fs.rmSync(tmp,{recursive:true,force:true});app.exit(1); }
});
