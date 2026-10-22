/** HA.View discoverable help for Home Assistant's own dashboard editor.
 * No DOM injection, URL rewriting, editor automation, or HA writes.
 */
'use strict';
const HELP = Object.freeze({
  type: 'info',
  title: 'Dashboard layout customization',
  message: 'Customize layouts in Home Assistant',
  detail: [
    'Use the dashboard’s own top-right menu (⋮), then Edit dashboard when available. HA View displays the same Home Assistant dashboard; it does not provide a second editor.',
    'Sign in to Home Assistant with an account allowed to edit this dashboard. If editing is missing, check permissions and the dashboard type. YAML-managed dashboards may require configuration outside the visual editor.',
    'An automatically managed dashboard may offer Take control before editing. That changes how Home Assistant manages it: do not confirm it unless you intend that change.',
    'In Home Assistant’s editor, customize the supported cards, views or sections. Save/Done applies changes in Home Assistant. Leave without saving if you only want to inspect.',
    'After an authorized save, return to this dashboard in HA View and verify the layout. Use the existing Refresh control if necessary. Home returns to the configured dashboard URL.',
    'This help does not check your login or permissions, open the editor, or change any Home Assistant configuration.'
  ].join('\n\n'),
  buttons: ['Close'],
  defaultId: 0,
  cancelId: 0,
  noLink: true
});
function install({ ipcMain, dialog, getWebview }) {
  let open = false;
  const listener = async (event, button) => {
    const w = getWebview();
    if (button?.id !== 'dashboard-layout-help' || !w?.navigation ||
        event.sender !== w.navigation.webContents || open || w.window.isDestroyed()) return;
    open = true;
    try {
      await dialog.showMessageBox(w.window, HELP);
    } catch (_) {
      // No URLs, auth details or backend responses in logs.
      console.error('HA.View dashboard layout help could not open.');
    } finally { open = false; }
  };
  ipcMain.on('button-click', listener);
  return () => ipcMain.removeListener('button-click', listener);
}
let dispose;
function init() {
  if (dispose) return;
  const { ipcMain, dialog, app } = require('electron');
  dispose = install({ ipcMain, dialog, getWebview: () => global.WEBVIEW });
  app.once('will-quit', () => { dispose?.(); dispose = undefined; });
}
module.exports = { HELP, install, init };
