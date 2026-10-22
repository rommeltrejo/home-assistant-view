/** HA.View chooser consumes only the main-process composed snapshot; no registration. */
'use strict';
(() => {
  let faces = [], frames = [], cards = [], previewIndex = 1, hiddenFaces = [], toastTimer;
  const element = id => document.getElementById(id);
  window.showToast = message => {
    clearTimeout(toastTimer);
    element('toast').textContent = message;
    toastTimer = setTimeout(() => element('toast').textContent = '', 3000);
  };
  window.previewFace = n => {
    if (!Number.isSafeInteger(n) || n < 1 || n > faces.length) return;
    previewIndex = n;
    const face = faces[n - 1], hidden = hiddenFaces.includes(face.id), button = element('hide');
    button.setAttribute('aria-pressed', String(hidden));
    button.setAttribute('aria-label', `${hidden ? 'Unhide' : 'Hide'} ${face.label}`);
    button.title = button.getAttribute('aria-label');
    element('track').style.transform = `translateX(-${(n - 1) * 100}%)`;
    element('label').textContent = face.label;
    element('dots').textContent = faces.map((_, i) => i + 1 === n ? '●' : '○').join(' ');
  };
  window.initializeChooser = snapshot => {
    // Validate the entire payload before creating any iframe or assigning a URL.
    faces = []; frames = []; cards = []; hiddenFaces = []; previewIndex = 1;
    element('track').replaceChildren();
    element('label').textContent = ''; element('dots').textContent = '';
    element('hide').setAttribute('aria-pressed', 'false');
    element('hide').setAttribute('aria-label', 'Hide face'); element('hide').title = 'Hide face';
    element('track').style.transform = '';
    const ids = new Set();
    if (!Array.isArray(snapshot) || !snapshot.length) return false;
    for (let index = 0; index < snapshot.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, index)) return false;
      const face = snapshot[index];
      if (!face || typeof face !== 'object' || Array.isArray(face) ||
          Object.keys(face).some(key => !['id', 'label', 'previewFile'].includes(key)) ||
          typeof face.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(face.id) || ids.has(face.id) ||
          typeof face.label !== 'string' || !face.label.trim() ||
          typeof face.previewFile !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/.test(face.previewFile)) return false;
      ids.add(face.id);
    }
    faces = snapshot.map(({ id, label, previewFile }) => ({ id, label, previewFile }));
    for (const face of faces) {
      const article = document.createElement('article'), frame = document.createElement('iframe');
      frame.setAttribute('src', `faces/${face.previewFile}`);
      frame.setAttribute('title', `${face.label} preview`);
      frame.setAttribute('tabindex', '-1');
      article.setAttribute('data-id', face.id);
      article.setAttribute('data-hidden', 'false');
      article.append(frame); element('track').append(article); frames.push(frame); cards.push(article);
    }
    window.previewFace(1);
    return true;
  };
  window.setHiddenFaces = hidden => {
    hiddenFaces = Array.isArray(hidden) ? hidden.filter(id => faces.some(face => face.id === id)) : [];
    cards.forEach((card, index) => card.setAttribute('data-hidden', String(hiddenFaces.includes(faces[index].id))));
    window.previewFace(previewIndex);
  };
  window.setLayoutPreview = config => {
    const frame = frames[faces.findIndex(face => face.id === 'layout')];
    if (!frame) return;
    const paint = () => frame.contentWindow?.layoutFace?.update({ config, data: {
      calendar: { message: 'Live calendar data on face' }, upcoming: { message: 'Live calendar data on face' },
    } });
    frame.onload = paint; paint();
  };
})();
