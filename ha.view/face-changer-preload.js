/** HA.View touch bridge. Mouse gestures are owned by native before-mouse-event. */
const { ipcRenderer } = require('electron');
let primary = null;
window.addEventListener('DOMContentLoaded', () => {
  for (const [name, type] of Object.entries({ pointerdown: 'down', pointermove: 'move', pointerup: 'up', pointercancel: 'cancel' })) {
    window.addEventListener(name, event => {
      if (event.pointerType !== 'touch') return;
      event.preventDefault();
      if (type === 'down') {
        if (primary !== null) { ipcRenderer.send('ha.view:face-touch', { type: 'cancel' }); return; }
        primary = event.pointerId;
        event.target.setPointerCapture?.(primary);
      }
      // A hold navigates to the picker; its new preload has no original pointer ID.
      if (primary === null && (type === "up" || type === "cancel")) primary = event.pointerId;
      if (event.pointerId !== primary) return;
      ipcRenderer.send('ha.view:face-touch', { type, x: event.clientX, y: event.clientY });
      if (type === 'up' || type === 'cancel') primary = null;
    }, { capture: true, passive: false });
  }
});
