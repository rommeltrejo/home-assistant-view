/** Independent native HA calendar mounts in fixed regions of the authenticated dashboard. */
'use strict';
const { mountScript, disposePage } = require('./calendar-runtime');
const { regions } = require('./layout-store');
class LayoutRuntime {
  stop() {
    this.generation = (this.generation || 0) + 1;
    const source = this.source; this.source = null;
    if (source && !source.isDestroyed?.()) for (const key of ['__haViewLayoutLeft', '__haViewLayoutRight']) source.executeJavaScript(`(${disposePage.toString()})(${JSON.stringify(key)})`).catch(() => {});
  }
  async start(contents, config, source, entityIds) {
    this.stop(); const generation = this.generation; this.source = source();
    if (contents.isDestroyed()) return;
    await contents.executeJavaScript(`window.layoutFace?.update(${JSON.stringify({ config })})`);
    if (generation !== this.generation || !this.source || this.source.isDestroyed?.()) return;
    for (const [i, card] of regions(config).entries()) {
      if (['calendar', 'upcoming'].includes(card.type)) this.source.executeJavaScript(mountScript(card.type, entityIds, { x: card.x, width: card.width }, i ? '__haViewLayoutRight' : '__haViewLayoutLeft')).catch(() => {});
    }
  }
}
module.exports = { LayoutRuntime };
