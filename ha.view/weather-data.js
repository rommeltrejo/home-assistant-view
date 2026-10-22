/** HA.View read-only Weather normalization. No forecast is synthesized. */
'use strict';
const CONDITIONS = new Set(['clear-night', 'cloudy', 'exceptional', 'fog', 'hail', 'lightning', 'lightning-rainy', 'partlycloudy', 'pouring', 'rainy', 'snowy', 'snowy-rainy', 'sunny', 'windy', 'windy-variant']);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' ? value.slice(0, 180) : '';
function usable(entity) {
  return /^weather\.[a-z0-9_]+$/.test(entity?.entity_id || '') && CONDITIONS.has(entity.state) && numeric(entity.attributes?.temperature);
}
function forecastType(entity) {
  const bits = entity?.attributes?.supported_features;
  return Number.isInteger(bits) && (bits & 2) ? 'hourly' : Number.isInteger(bits) && (bits & 1) ? 'daily' : null;
}
function selectWeather(states, retainedId) {
  const candidates = Object.values(states || {}).filter(usable);
  return candidates.find(entity => entity.entity_id === retainedId) || candidates.sort((a, b) => {
    const rank = entity => ({ hourly: 0, daily: 1 }[forecastType(entity)] ?? 2);
    return rank(a) - rank(b) || (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0);
  })[0] || null;
}
function normalizeWeather(entity, forecast, context = {}) {
  if (!usable(entity)) return null;
  const a = entity.attributes, type = context.forecastType || forecastType(entity), now = numeric(context.now) ? context.now : Date.now();
  const rows = (Array.isArray(forecast) ? forecast.slice(0, 192) : []).filter(row => row && numeric(row.temperature) && typeof row.datetime === 'string' && Number.isFinite(Date.parse(row.datetime)))
    .map(row => ({ datetime: row.datetime, temperature: row.temperature, low: numeric(row.templow) ? row.templow : null,
      precipitationProbability: numeric(row.precipitation_probability) && row.precipitation_probability >= 0 && row.precipitation_probability <= 100 ? row.precipitation_probability : null,
      condition: CONDITIONS.has(row.condition) ? row.condition : null, isDaytime: typeof row.is_daytime === 'boolean' ? row.is_daytime : null }))
    .filter(row => Date.parse(row.datetime) >= now - (type === 'daily' ? 86400000 : 3600000))
    .sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime))
    .filter((row, i, all) => i === 0 || row.datetime !== all[i - 1].datetime).slice(0, type === 'hourly' ? 8 : type === 'daily' ? 7 : 0);
  let timezone = text(context.timezone) || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { timezone = 'UTC'; }
  const dayHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const date = value => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
  // Today's extrema come only from a genuine daily record, never hourly extrema.
  const dailyRows = type === 'daily' ? forecast : context.dailyForecast;
  const today = (Array.isArray(dailyRows) ? dailyRows.slice(0, 192) : []).find(row =>
    row && numeric(row.temperature) && typeof row.datetime === 'string' && Number.isFinite(Date.parse(row.datetime)) && date(Date.parse(row.datetime)) === date(now));
  return { entityId: entity.entity_id, name: text(a.friendly_name) || entity.entity_id, condition: entity.state,
    temperature: a.temperature, temperatureUnit: text(a.temperature_unit), windUnit: text(a.wind_speed_unit),
    pressureUnit: text(a.pressure_unit), precipitationUnit: text(a.precipitation_unit), visibilityUnit: text(a.visibility_unit),
    feelsLike: numeric(a.apparent_temperature) ? a.apparent_temperature : null,
    humidity: numeric(a.humidity) && a.humidity >= 0 && a.humidity <= 100 ? a.humidity : null,
    windSpeed: numeric(a.wind_speed) && a.wind_speed >= 0 ? a.wind_speed : null,
    high: today?.temperature ?? null, low: numeric(today?.templow) ? today.templow : null,
    forecastType: rows.length ? type : null, forecast: rows, timezone, now,
    isDaytime: typeof context.isDaytime === 'boolean' ? context.isDaytime : entity.state === 'clear-night' ? false : dayHour >= 6 && dayHour < 18 };
}
module.exports = { CONDITIONS, numeric, usable, forecastType, selectWeather, normalizeWeather };
