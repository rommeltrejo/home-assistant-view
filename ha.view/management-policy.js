/** HA.View fixed native frontend entry points, not accessory capability claims. */
'use strict';
const pages = Object.freeze([
  { id: 'devices', label: 'Devices', path: '/config/devices/dashboard', tag: 'ha-config-devices-dashboard', guidance: 'Native device registry and status. HA may require administrator access. Device controls depend on installed integrations and permissions.' },
  { id: 'entities', label: 'Entities', path: '/config/entities', tag: 'ha-config-entities', guidance: 'Native entity registry/status, not a replacement control panel. Some entries may be disabled or unavailable; HA determines access.' },
  { id: 'automations', label: 'Automations', path: '/config/automation/dashboard', tag: 'ha-automation-picker', guidance: 'Native automation management. HA permissions and automation integration availability apply. HA View never runs or edits automations.' },
  { id: 'scenes', label: 'Scenes', path: '/config/scene/dashboard', tag: 'ha-scene-dashboard', guidance: 'Native scene management. If no scenes are configured or the integration is unavailable, there may be nothing to manage. HA permissions apply; no scene actions are verified.' },
  { id: 'activity', label: 'Activity', path: '/logbook', tag: 'ha-panel-logbook', guidance: 'Review a bounded summary of actual HA logbook records from the existing signed-in frontend session. Requires logbook/recorder availability, retained records and account permissions. Empty results do not prove no activity; retention/exclusions, permissions or integration availability may limit results.' },
  { id: 'history', label: 'History', path: '/history', tag: 'ha-panel-history', guidance: 'Partial: native HA state history, not an activity summary engine. Requires HA history/recorder availability, retained history and account permissions. Select entities/time range in HA and wait for native loading. No results, unavailable integration or retrieval errors do not prove there was no activity. Route/panel presence alone does not verify data.' },
  { id: 'notifications', label: 'Notifications', path: null, guidance: 'Home Assistant notifications are a native drawer, not a standalone /notifications route. In the visible HA frontend, open its sidebar (menu), then Notifications (bell). Sign in first if required. Close this launcher to interact with HA. If hidden or unavailable, use HA’s own sidebar/profile settings. Persistent notifications are frontend messages, not a complete security/sensor/alarm feed: configured alerts may notify elsewhere, and entity states need not produce a notification. For review, use the existing Entities entry to find configured alert, sensor, binary_sensor or alarm_control_panel entities; use History for retained state changes and Activity for recorded activity, selecting entities/time ranges in HA. Availability, retention and permissions apply; empty results do not prove there are no alerts. Review only: do not dismiss notifications, acknowledge alerts, or arm/disarm controls. HA View does not detect unsupported alarms, collect events, create or dismiss notifications, or change HA.' }
].map(Object.freeze));
function target(id, backend, current) {
  const page = pages.find(page => page.id === id);
  if (!page) throw new Error('Unknown native management page');
  if (!page.path) return { page, url: null };
  const base = new URL(backend), active = new URL(current);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || active.origin !== base.origin || active.username || active.password) throw new Error('Active HA view must be on the configured HTTP(S) origin');
  return { page, url: new URL(page.path, base.origin).href, origin: base.origin };
}
module.exports = { pages, target };
