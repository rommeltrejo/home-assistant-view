/** HA.View calendar face availability; readable catalog intersected with selection; never event counts or preference writes. */
'use strict';
const { listCalendars } = require('./calendar-data');
const DEPENDENT = ['calendar', 'upcoming'];
class CalendarAvailability {
  constructor({ contents, changed = () => {}, probe = listCalendars, selection = () => [] }) {
    Object.assign(this, { contents, changed, probe, selection });
    this.generation = 0;
    this.status = 'loading';
  }
  invalidate(reset = false) {
    this.generation++;
    if (reset) { this.status = 'loading'; this.changed(); }
  }
  hidden(manual) { return [...new Set([...manual, ...(this.status === 'available' ? [] : DEPENDENT)])]; }
  blocked(id) { return DEPENDENT.includes(id) && this.status !== 'available'; }
  toast() {
    return this.status === 'absent' ? 'No calendar to show' :
      this.status === 'loading' ? 'Calendar availability is still loading. Try again.' :
      'Calendar availability could not be verified. Connect to Home Assistant and try again.';
  }
  async refresh() {
    const generation = ++this.generation, contents = this.contents(), url = contents?.getURL?.();
    const selected = [...this.selection()], selectionKey = JSON.stringify(selected);
    this.status = 'loading'; this.changed();
    let result;
    try { result = await this.probe(contents); } catch { result = { status: 'error' }; }
    if (selectionKey !== JSON.stringify(this.selection()) || generation !== this.generation || contents !== this.contents() || contents?.getURL?.() !== url || contents?.isDestroyed?.()) return false;
    this.status = result?.status === 'setup-needed' ? 'absent' :
      result?.status === 'ok' && Array.isArray(result.calendars) ? (result.calendars.some(calendar => !selected.length || selected.includes(calendar.entity_id)) ? 'available' : 'absent') : 'unverified';
    this.changed();
    return true;
  }
}
module.exports = { CalendarAvailability, DEPENDENT };
