/** Settings-only input shield and keyboard focus loop. Never installed in HA. */
'use strict';
(() => {
  const dialog = document.querySelector('#dialog,.tool-card,.editor');
  if (!dialog) return;
  const controls = () => [...dialog.querySelectorAll('button,input,select,textarea,summary,[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  for (const name of ['pointerdown','pointerup','click','wheel']) document.addEventListener(name, event => {
    if (!dialog.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
  }, {capture:true,passive:false});
  document.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const list = controls();
    if (!list.length) { event.preventDefault(); return; }
    const first=list[0],last=list.at(-1);
    if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement===first) || (!event.shiftKey && document.activeElement===last)) { event.preventDefault(); (event.shiftKey?last:first).focus(); }
  });
  controls()[0]?.focus();
})();
