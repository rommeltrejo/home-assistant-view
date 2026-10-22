/** HA.View idle face registry. Stable IDs are persisted and used by schedules. */
'use strict';
const { createRegistry } = require('./face-registry');
// Persisted compatibility indices are pinned here. Future faces are composed here,
// without independently selecting a numeric index in each feature candidate.
module.exports = createRegistry([
  { id: 'clock1', label: 'Clock 2', file: 'clock.html', index: 1 },
  { id: 'clock2', label: 'Clock 1', file: 'clock-2.html', index: 2 },
  { id: 'calendar', label: 'Calendar', file: 'calendar.html', index: 3 },
  { id: 'upcoming', label: 'Upcoming Events', file: 'upcoming-events.html', index: 4 },
  { id: 'layout', label: 'Layout', file: 'layout.html', index: 5 },
  { id: 'weather', label: 'Weather', file: 'weather.html', index: 6 },
]);
