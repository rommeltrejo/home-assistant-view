'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { WeatherAvailability, TOAST } = require('./weather-availability');
test('unavailable Weather is excluded without changing manual visibility', async () => {
 const contents={getURL:()=> 'https://ha/'}; let result={status:'absent'}, changes=0;
 const gate=new WeatherAvailability({contents:()=>contents,probe:async()=>result,changed:()=>changes++});
 assert.equal(TOAST,'set up weather on Home Assistant'); assert.equal(gate.blocked('weather'),true);
 assert.equal(gate.blocked('clock2'),false); await gate.refresh(); assert.deepEqual(gate.hidden(['calendar']),['calendar','weather']);
 result={status:'ok'}; await gate.refresh(); assert.equal(gate.blocked('weather'),false); assert.deepEqual(gate.hidden(['weather']),['weather']);
 await gate.refresh(); assert.equal(changes,1); result={status:'error'};await gate.refresh();assert.equal(changes,2);
});
test('obsolete weather probes cannot re-enable a new session',async()=>{
 let finish;const contents={getURL:()=> 'https://ha/'};
 const gate=new WeatherAvailability({contents:()=>contents,probe:()=>new Promise(r=>finish=r)});
 const pending=gate.refresh();gate.invalidate();finish({status:'ok'});assert.equal(await pending,false);assert.equal(gate.available,false);
});
test('chooser rejected selections remain open',()=>{
 const {FaceChanger}=require('./face-changer'); const picker=new FaceChanger({select:()=>false});
 picker.picking=true;picker.input('down',0,0);picker.input('up',0,0);assert.equal(picker.picking,true);
});
test('Weather availability skips rotation and gates daily choices without rewriting configuration', async () => {
 const { DaySchedule, validate, DEFAULT } = require('./day-schedule');
 const contents={getURL:()=> 'https://ha/'};let result={status:'unavailable'};
 const gate=new WeatherAvailability({contents:()=>contents,probe:async()=>result});
 const rotation=new DaySchedule({config:validate({enabled:true,strategy:'rotation',rules:[],rotationFaces:['weather','clock2']})});
 const daily=new DaySchedule({config:validate({enabled:true,rules:[{time:'00:00',mode:'weather'}]})});
 const saved=JSON.stringify(rotation.config);
 rotation.setHidden(gate.hidden([]));assert.deepEqual(rotation.rotationFaces(),['clock2']);assert.equal(rotation.mode(),'clock2');
 assert.equal(daily.mode(),'weather');assert.equal(gate.blocked(daily.mode()),true);
 result={status:'ok'};await gate.refresh();rotation.setHidden(gate.hidden([]));
 assert.deepEqual(rotation.rotationFaces(),['weather','clock2']);assert.equal(gate.blocked(daily.mode()),false);
 assert.equal(JSON.stringify(rotation.config),saved);assert.equal(DEFAULT.rotationFaces.includes('weather'),false);
 rotation.setHidden(gate.hidden(['weather']));assert.deepEqual(rotation.rotationFaces(),['clock2']);
 rotation.stop();daily.stop();
});
