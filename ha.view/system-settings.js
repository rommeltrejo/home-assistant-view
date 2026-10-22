/** Isolated same-parent settings card with one bounded tool handoff. */
'use strict';
const path = require('node:path');
const registry = require('./menu');
function install({ electron, parent, allowed, interaction, closed, target, browserSettings, toolActive = () => true }) {
  let view, disposed = false, origin = 'dashboard', handing = false, waiting = false, closing = false;
  const documentURL = require('node:url').pathToFileURL(path.join(__dirname,'system-settings.html')).href;
  const trusted = event => { if (disposed || closing || parent.isDestroyed() || !view || view.webContents.isDestroyed() || event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame || view.webContents.getURL() !== documentURL) throw Error('Untrusted system settings sender'); };
  const resize = () => { if (view) { const {width,height} = parent.getContentBounds(); view.setBounds({x:0,y:0,width,height}); } };
  const close = (reason = 'back') => {
    waiting = false;
    if (!view) return;
    const old = view; view = null;
    if (!parent.isDestroyed()) parent.contentView.removeChildView(old);
    old.webContents.removeAllListeners(); if (!old.webContents.isDestroyed()) old.webContents.close();
    interaction(false); if (reason === 'back') closed(origin);
  };
  const open = (source = origin) => {
    if (disposed || closing || parent.isDestroyed() || !allowed()) return false;
    if (view) { view.webContents.focus(); return; }
    origin = source;
    view = new electron.WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'system-settings-preload.js')}});
    const created = view;
    created.setBackgroundColor('#00000000');
    created.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    for (const name of ['will-navigate','will-frame-navigate']) created.webContents.on(name,e=>e.preventDefault());
    created.webContents.on('before-input-event',(e,input)=>{if(input.type==='keyDown' && input.key==='Escape'){e.preventDefault();close();}});
    parent.contentView.addChildView(created); interaction(true); resize(); created.setVisible(true); created.webContents.focus();
    created.webContents.loadFile(path.join(__dirname,'system-settings.html')).catch(()=>{if(view===created)close('error');});
    return true;
  };
  electron.ipcMain.handle('ha.view:system:get',event=>{trusted(event);return { actions: registry.list(electron), showBrowserIcon: browserSettings?.showIcon !== false, browserError: browserSettings?.error || '' };});
  electron.ipcMain.handle('ha.view:system:browser-icon',(event,value)=>{
    trusted(event);
    if (!browserSettings || typeof value !== 'boolean') throw Error('Invalid browser visibility');
    browserSettings.saveShowIcon(value);
    return browserSettings.showIcon;
  });
  electron.ipcMain.handle('ha.view:system:close',event=>{trusted(event);close();});
  electron.ipcMain.handle('ha.view:system:run',(event,id)=>{
    trusted(event);
    if (typeof id !== 'string' || !registry.list(electron).some(entry=>entry.id===id && entry.enabled!==false)) throw Error('Unknown system action');
    const contents = target();
    handing = true; close('handoff');
    try { waiting = registry.run(electron,id,parent,contents)==='tool' && toolActive(); }
    catch (error) { waiting = false; if (!closing && !parent.isDestroyed() && !disposed && allowed()) open(); throw error; }
    finally { handing = false; }
    if (!waiting && !['native:close','native:quit'].includes(id)) open();
  });
  const toolClosed = () => { if (!waiting || handing || disposed) return false; waiting=false; return open(); };
  const dispose = () => { if(disposed)return; disposed=true; close('dispose'); parent.removeListener('close',parentClosing); parent.removeListener('resize',resize); parent.removeListener('closed',dispose); for(const name of ['get','close','run','browser-icon'])electron.ipcMain.removeHandler(`ha.view:system:${name}`); };
  const parentClosing = () => { closing = true; close('parent'); };
  parent.on('close',parentClosing); parent.on('resize',resize); parent.on('closed',dispose);
  return Object.assign(dispose,{open,close,toolClosed});
}
module.exports = {install};
