/** HA.View deliberately bounded activity-summary policy. */
'use strict';
const MAX_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 500;
const MAX_EVENT_CHARS = 512;
const MAX_OUTPUT_CHARS = 24000;
const MAX_PAGE = 20;
function requestWindow(now, hours = 24) {
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Choose a period up to 24 hours');
  const end = new Date(now), start = new Date(now - Math.min(hours * 3600000, MAX_RANGE_MS));
  return { start_time: start.toISOString(), end_time: end.toISOString() };
}
function summarize(raw, { start, end } = {}) {
  if (!Array.isArray(raw)) throw new Error('Unexpected activity response');
  const clipped = raw.slice(0, MAX_EVENTS);
  const entries = [];
  for (const item of clipped) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const when = Number(item.when);
    const timestamp = Number.isFinite(when) ? (when < 1e12 ? when * 1000 : when) : NaN;
    if (!Number.isFinite(timestamp) || (start && timestamp < start) || (end && timestamp > end)) continue;
    const text = [item.name || item.entity_id || item.domain, item.message, typeof item.state === 'string' ? `state: ${item.state}` : null].filter(v => typeof v === 'string').join(' — ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_EVENT_CHARS);
    if (!text) continue;
    entries.push({ timestamp, text });
  }
  entries.sort((a,b) => b.timestamp - a.timestamp);
  const rows = entries.slice(0, MAX_PAGE);
  let output = rows.map(e => `${new Date(e.timestamp).toLocaleString([], { hour:'numeric', minute:'2-digit' })} — ${e.text}`).join('\n');
  output = output.slice(0, MAX_OUTPUT_CHARS);
  return { count: entries.length, shown: rows.length, truncated: raw.length > MAX_EVENTS || entries.length > MAX_PAGE || output.length >= MAX_OUTPUT_CHARS, output };
}
module.exports = { MAX_RANGE_MS, MAX_EVENTS, MAX_EVENT_CHARS, MAX_OUTPUT_CHARS, MAX_PAGE, requestWindow, summarize };
