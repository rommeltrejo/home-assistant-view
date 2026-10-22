/** HA.View local sandbox renderer: text-only updates; no IPC, network or HA writes. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const label = value => ({ partlycloudy: 'Partly cloudy', 'clear-night': 'Clear night', 'lightning-rainy': 'Thunderstorms', 'snowy-rainy': 'Sleet', 'windy-variant': 'Windy' }[value] || String(value || '').replace(/^./, char => char.toUpperCase()));
  const icons = { sunny: '☀', 'clear-night': '☾', partlycloudy: '⛅', cloudy: '☁', fog: '≋', rainy: '☂', pouring: '☂', lightning: 'ϟ', 'lightning-rainy': 'ϟ', snowy: '❄', 'snowy-rainy': '❄', hail: '❄', windy: '≋', 'windy-variant': '≋' };
  const number = value => typeof value === 'number' && Number.isFinite(value);
  const temp = value => number(value) ? `${Math.round(value)}°` : '—';
  let current = null;
  function clock() { if (!current) return; try { $('clock').textContent = new Intl.DateTimeFormat(undefined, { timeZone: current.timezone, hour: 'numeric', minute: '2-digit' }).format(Date.now()); } catch { $('clock').textContent = ''; } }
  function update(data) {
    if (!data || !number(data.temperature)) return;
    current = data;
    $('weather').dataset.sky = !data.isDaytime ? 'night' : ['rainy', 'pouring', 'lightning', 'lightning-rainy', 'cloudy', 'fog'].includes(data.condition) ? 'storm' : 'day';
    $('name').textContent = data.name; $('condition').textContent = label(data.condition);
    $('temperature').textContent = temp(data.temperature); $('unit').textContent = data.temperatureUnit || '';
    $('range').textContent = [number(data.high) ? `H:${temp(data.high)}` : '', number(data.low) ? `L:${temp(data.low)}` : ''].filter(Boolean).join('  ');
    clock(); $('forecast').replaceChildren();
    const rows = Array.isArray(data.forecast) ? data.forecast.slice(0, data.forecastType === 'hourly' ? 8 : 7) : [];
    $('forecast-section').hidden = !rows.length;
    $('forecast-heading').textContent = data.forecastType === 'hourly' ? 'Hourly forecast' : 'Daily forecast';
    for (const row of rows) {
      const card = document.createElement('div'); card.className = 'sample';
      const add = (value, className = '') => { const element = document.createElement('span'); element.className = className; element.textContent = value; card.append(element); };
      try { add(new Intl.DateTimeFormat(undefined, { timeZone: data.timezone, ...(data.forecastType === 'hourly' ? { hour: 'numeric' } : { weekday: 'short' }) }).format(Date.parse(row.datetime))); } catch { continue; }
      add(icons[row.condition] || '—', 'icon'); card.lastChild.setAttribute('aria-label', label(row.condition) || 'Condition unavailable');
      add(temp(row.temperature)); if (number(row.low)) add(temp(row.low), 'low');
      if (number(row.precipitationProbability)) add(`${row.precipitationProbability}%`, 'rain');
      $('forecast').append(card);
    }
    $('details').replaceChildren();
    for (const [title, value] of [['Feels like', number(data.feelsLike) ? temp(data.feelsLike) : null], ['Wind', number(data.windSpeed) ? `${data.windSpeed} ${data.windUnit || ''}` : null], ['Humidity', number(data.humidity) ? `${data.humidity}%` : null]]) {
      if (value === null) continue;
      const detail = document.createElement('div'), icon = document.createElement('span'), name = document.createElement('small'), reading = document.createElement('strong');
      icon.className = 'metric-icon'; icon.textContent = { 'Feels like': '♨', Wind: '≋', Humidity: '◒' }[title]; icon.setAttribute('aria-hidden', 'true'); name.textContent = title; reading.textContent = value; detail.append(icon, name, reading); $('details').append(detail);
    }
  }
  window.weatherFace = Object.freeze({ update });
  const timer = setInterval(clock, 1000); window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
