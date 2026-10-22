(() => {
  window.layoutFace = { update: ({ config }) => {
    const canvas = document.querySelector('#canvas'); canvas.replaceChildren();
    for (const card of config.cards) {
      const slot = document.createElement('section'); slot.className = 'slot'; slot.dataset.type = card.type;
      if (card.type === 'clock1' || card.type === 'clock2') {
        const frame = document.createElement('iframe'); frame.src = card.type === 'clock1' ? 'clock.html' : 'clock-2.html'; frame.title = card.type === 'clock1' ? 'Clock 2' : 'Clock 1'; frame.tabIndex = -1; slot.append(frame);
      }
      canvas.append(slot);
    }
  } };
})();
