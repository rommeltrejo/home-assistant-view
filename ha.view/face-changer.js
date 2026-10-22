/** HA.View release-based gesture controller; independent of renderer event delivery. */
class FaceChanger {
  constructor({ open, dismiss, preview, select, cancel, width = () => 800, count = 2 }) {
    Object.assign(this, { open, dismiss, preview, select, cancel, width, count: Math.max(2, Math.min(16, count)) });
    this.picking = false;
    this.index = 1;
  }
  reset() { clearTimeout(this.timer); this.timer = null; this.press = null; }
  abort() { this.reset(); if (this.picking) { this.picking = false; this.cancel(); } }
  input(type, x = 0, y = 0) {
    if (type === 'cancel') { this.reset(); return; }
    if (type === 'down') {
      if (this.press) {
        const opening = this.press.held;
        this.reset();
        if (!opening) return;
      }
      this.press = { x, y, moved: false, held: false, picker: this.picking };
      if (!this.picking) this.timer = setTimeout(() => {
        if (!this.press || this.press.moved) return;
        this.press.held = true;
        this.picking = true;
        this.open();
      }, 600);
      return;
    }
    const p = this.press;
    if (!p) return;
    const dx = x - p.x, dy = y - p.y;
    if (Math.hypot(dx, dy) > 12) { p.moved = true; clearTimeout(this.timer); }
    if (type !== 'up') return;
    this.reset();
    if (p.held) return; // The release which opened the picker never selects.
    if (p.picker) {
      if (Math.abs(dx) >= Math.max(40, this.width() * .12) && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this.index = Math.max(1, Math.min(this.count, this.index + (dx < 0 ? 1 : -1)));
        this.preview(this.index);
      } else if (!p.moved) { if (this.select(this.index) !== false) this.picking = false; }
    } else if (!p.moved) this.dismiss();
  }
}
module.exports = { FaceChanger };
