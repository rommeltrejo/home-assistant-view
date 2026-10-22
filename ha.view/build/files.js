/** HA.View package source allowlist. Dependencies are separately pruned by Packager. */
'use strict';
const runtime = new Set([
  'browser.js', 'browser-policy.js', 'browser-preload.js', 'browser-renderer.js', 'browser.html', 'browser-launcher.html', 'browser.css',
  'activity-bridge.js', 'activity-policy.js', 'calendar-availability.js', 'calendar-data.js', 'calendar-runtime.js', 'weather-availability.js', 'weather-data.js', 'weather-runtime.js',
  'camera-config.js', 'camera-dashboard.js', 'camera-preload.js', 'camera-renderer.js', 'camera-settings.html',
  'system-settings.js', 'system-settings-preload.js', 'system-settings-renderer.js', 'system-settings.html', 'system-settings.css', 'tool-modal.css', 'modal-interaction.js', 'menu.js', 'context.css', 'context-bridge.js', 'frontend-auth.js', 'context-policy.js', 'context-preload.js', 'context-renderer.js', 'context-settings.js', 'context.html',
  'dashboard-layout.js', 'day-schedule.js', 'day-schedule-preload.js', 'day-schedule-renderer.js',
  'day-schedule-settings.js', 'day-schedule.html', 'face-changer.js', 'face-changer-preload.js',
  'face-settings.css', 'face-changer-renderer.js', 'face-changer-store.js', 'face-changer.html', 'face-modes.js', 'face-registry.js', 'hooks.js', 'identity.js',
  'quit-status.js', 'linux-display.js', 'layout-store.js', 'layout-runtime.js', 'layout-face.js', 'layout-editor.js', 'layout-editor-preload.js',
  'layout-editor-renderer.js', 'layout-editor.html', 'layout.css',
  'startup-recovery.js', 'startup-recovery-controller.js', 'startup-recovery-probe.js', 'startup-recovery-preload.js', 'startup-recovery-renderer.js', 'startup-recovery.html',
  'startup-settings.js', 'installer-startup.js', 'initial-settings.js', 'initial-settings-preload.js', 'initial-settings-renderer.js', 'initial-settings.html', 'management-policy.js', 'management-preload.js', 'management-renderer.js', 'management.html', 'management.js',
]);
const assets = new Set([
  'index.js', 'package.json', 'LICENSE', 'README.md',
  'js/hardware.js', 'js/integration.js', 'js/webview.js',
  'html/pager.html', 'html/header.html', 'html/widget.html', 'html/navigation.html',
  'img/icon.png', 'img/display.png', 'img/mqtt.png',
  ...[...runtime].map(file => `ha.view/${file}`),
  ...['clock.html', 'clock-2.html', 'calendar.html', 'calendar-preview.html', 'upcoming-events.html', 'upcoming-preview.html', 'layout.html', 'weather.html', 'weather-preview.html', 'weather.css', 'weather-renderer.js'].map(file => `ha.view/faces/${file}`),
]);
function ignore(file) {
  const name = file.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!name) return false;
  if (name === 'node_modules' || name.startsWith('node_modules/')) {
    // Never copy local dependency caches or credentials. Forge prunes devDependencies.
    return name.split('/').some(part => part.startsWith('.') || /^(?:credentials|secrets)(?:\.|$)/i.test(part));
  }
  return !assets.has(name) && ![...assets].some(asset => asset.startsWith(`${name}/`));
}
module.exports = { assets, ignore };
