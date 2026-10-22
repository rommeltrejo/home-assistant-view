'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectWeather, normalizeWeather } = require('./weather-data');
const entity = (id = 'weather.a', bits = 3) => ({ entity_id: id, state: 'sunny', attributes: { temperature: 21, supported_features: bits, temperature_unit: '°C' } });
test('selection prefers hourly, stable ID, retained usable choice', () => {
  const states = { z: entity('weather.z'), a: entity(), d: entity('weather.daily', 1) };
  assert.equal(selectWeather(states).entity_id, 'weather.a');
  assert.equal(selectWeather(states, 'weather.daily').entity_id, 'weather.daily');
  states.a.state = 'unknown'; assert.equal(selectWeather(states).entity_id, 'weather.z');
});
test('invalid current readings rejected, partial current remains usable', () => {
  for (const temperature of [NaN, Infinity, '22', null]) assert.equal(normalizeWeather({ ...entity(), attributes: { temperature } }), null);
  const data = normalizeWeather(entity(), null); assert.equal(data.temperatureUnit, '°C'); assert.deepEqual(data.forecast, []); assert.equal(data.high, null); assert.equal(data.feelsLike, null);
});
test('hourly bounded, probability preserved, not mislabeled today extremes', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const rows = Array.from({ length: 20 }, (_, i) => ({ datetime: new Date(now + i * 3600000).toISOString(), temperature: i, precipitation_probability: 30 }));
  const data = normalizeWeather(entity(), rows, { now, timezone: 'UTC' });
  assert.equal(data.forecast.length, 8); assert.equal(data.forecast[0].precipitationProbability, 30); assert.equal(data.high, null); assert.equal(data.low, null);
});
test('daily today only, invalid forecasts excluded, timezone retained', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const data = normalizeWeather(entity(), [{ datetime: 'bad', temperature: 2 }, { datetime: '2026-10-19T14:00:00Z', temperature: 25, templow: 10 }, { datetime: '2026-10-20T14:00:00Z', temperature: 99 }], { now, timezone: 'America/New_York', forecastType: 'daily' });
  assert.equal(data.high, 25); assert.equal(data.low, 10); assert.equal(data.timezone, 'America/New_York');
});
module.exports = { entity };
test('secondary daily supplies genuine local today extremes without replacing hourly', () => {
  const now = Date.parse('2026-10-19T02:00:00Z');
  const hourly = [{ datetime: '2026-10-19T02:00:00Z', temperature: 99, templow: -99 }];
  const daily = [{ datetime: '2026-10-18T16:00:00Z', temperature: 25, templow: 10 }, { datetime: '2026-10-19T16:00:00Z', temperature: 30, templow: 12 }];
  const data = normalizeWeather(entity(), hourly, { now, timezone: 'America/New_York', dailyForecast: daily });
  assert.equal(data.high, 25); assert.equal(data.low, 10);
  assert.equal(data.forecastType, 'hourly'); assert.equal(data.forecast[0].temperature, 99);
  for (const dailyForecast of [null, [], [{ datetime: 'bad', temperature: 1 }], [daily[1]]]) {
    const missing = normalizeWeather(entity(), hourly, { now, timezone: 'America/New_York', dailyForecast });
    assert.equal(missing.high, null); assert.equal(missing.low, null);
  }
  assert.equal(normalizeWeather(entity(), hourly, { now, dailyForecast: [{ datetime: hourly[0].datetime, temperature: 25, templow: '10' }] }).low, null);
});
