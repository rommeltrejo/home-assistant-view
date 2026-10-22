'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'day-schedule.html'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'face-settings.css'),'utf8');
test('grouped Face Settings retains contract IDs and collapses per-face configuration',()=>{
  const ids=['backdrop','dialog','title','close','idle-title','idle-minutes','idle-override','schedule-title','enabled','strategy','daily-controls','rules','add','rotation-controls','rotation-minutes','rotation-faces','save','calendar-heading','calendar-status','calendar-entities','status'];
  for(const id of ids)assert.equal((html.match(new RegExp(`id="${id}"`,'g'))||[]).length,1,id);
  assert.match(html, /Inactivity timer[\s\S]*<hr>[\s\S]*Automatic faces/);
  assert.match(html, /<details[^>]*class="[^"]*face-disclosure[^>]*><summary/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /button,input,select,summary,/);
  assert.match(html, /<footer class="settings-actions">[\s\S]*id="close"[^>]*>Cancel[\s\S]*id="save">Save settings/);
  assert.match(css, /\.settings-content\{[^}]*overflow:auto/);
  assert.match(css, /\.settings-actions\{flex:none/);
  assert.match(css, /min-height:44px/);
  assert.match(html, /if\(!dialog.contains\(event.target\)\)event.preventDefault\(\)/);
});

test('checkboxes retain compact indicators inside 44px touch targets and disclosure focus is unclipped',()=>{
  assert.match(css,/input\[type=checkbox\]\{[^}]*width:44px;height:44px/);
  assert.match(css,/input\[type=checkbox\]::before\{[^}]*inset:11px/);
  assert.match(css,/button\{min-width:44px/);
  assert.match(css,/summary:focus-visible\{outline-offset:-4px/);
});


test('configuration stays one collapsed Calendar group without future provider panels', () => {
  assert.equal((html.match(/<details\b/g) || []).length, 1);
  assert.match(html, /id="calendar-settings"/);
  assert.match(html, /<script src="day-schedule-renderer.js"><\/script>/);
  assert.doesNotMatch(html, /Weather|Timer configuration|Photo gallery|To-do configuration/);
});
