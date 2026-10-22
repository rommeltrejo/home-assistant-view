(() => {
  const left = document.querySelector('#left'), right = document.querySelector('#right'), status = document.querySelector('#status');
  const labels = { clock1: 'Clock 2', clock2: 'Clock 1', calendar: 'Calendar', upcoming: 'Upcoming Events' };
  for (const select of [left, right]) {
    if (select === right) { const option = document.createElement('option'); option.value = ''; option.textContent = 'None — Left fills screen'; select.append(option); }
    for (const [value, label] of Object.entries(labels)) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
  }
  function render() {
    for (const [select, id] of [[left,'left-preview'], [right,'right-preview']]) {
      const preview = document.getElementById(id); preview.replaceChildren();
      if (select.value === 'clock1' || select.value === 'clock2') {
        const frame = document.createElement('iframe'); frame.src = select.value === 'clock1' ? 'faces/clock.html' : 'faces/clock-2.html'; frame.title = labels[select.value]; frame.tabIndex = -1; preview.append(frame);
      } else preview.textContent = select.value ? `${labels[select.value]} uses the existing native Home Assistant renderer on the idle face. Live data is not previewed here.` : 'No second face';
    }
    document.querySelector('#swap').disabled = !right.value;
  }
  left.onchange = right.onchange = render;
  document.querySelector('#swap').onclick = () => { if (!right.value) return; const first = left.value; left.value = right.value; right.value = first; render(); };
  document.querySelector('#cancel').onclick = () => window.layoutEditor.cancel().catch(error => { status.textContent = error.message; });
  document.querySelector('#save').onclick = async () => {
    const button = document.querySelector('#save'); button.disabled = true;
    try { await window.layoutEditor.save({version:2,cards:[{type:left.value},...(right.value?[{type:right.value}]:[])]}); }
    catch(error){status.textContent=error.message;button.disabled=false;}
  };
  window.layoutEditor.get().then(config=>{left.value=config.cards[0].type;right.value=config.cards[1]?.type||'';render();}).catch(error=>{status.textContent=error.message;});
})();
