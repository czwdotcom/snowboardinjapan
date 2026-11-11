// Snow and weather from Open-Meteo (free, no key). Two points: the top of Yakebitaiyama and Ichinose village.

import { load, save } from './store.js';

const SPOTS = [
  { key: 'top', label: 'Summit ~2,000 m', lat: 36.7652, lon: 138.5222, ele: 2000 },
  { key: 'base', label: 'Ichinose ~1,600 m', lat: 36.7262, lon: 138.5118, ele: 1600 },
];

const URL_BASE = 'https://api.open-meteo.com/v1/forecast';

export async function fetchSnow() {
  const q = new URLSearchParams({
    latitude: SPOTS.map((s) => s.lat).join(','),
    longitude: SPOTS.map((s) => s.lon).join(','),
    elevation: SPOTS.map((s) => s.ele).join(','),
    hourly: 'snowfall,temperature_2m,wind_speed_10m,wind_gusts_10m,snow_depth,weather_code',
    daily: 'snowfall_sum,temperature_2m_max,temperature_2m_min,wind_gusts_10m_max',
    timezone: 'Asia/Tokyo',
    past_days: '2',
    forecast_days: '14',
  });
  try {
    const res = await fetch(`${URL_BASE}?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = { at: Date.now(), spots: SPOTS.map((s, i) => ({ ...s, ...(Array.isArray(json) ? json[i] : json) })) };
    save('snow', data);
    return { data, live: true };
  } catch (e) {
    const cached = load('snow', null);
    if (cached) return { data: cached, live: false };
    throw e;
  }
}

// Tokyo local time "now" in the same "YYYY-MM-DDTHH:00" format Open-Meteo uses.
export function tokyoHourKey(d = new Date()) {
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }); // "2027-01-18 07:42:10"
  return `${s.slice(0, 10)}T${s.slice(11, 13)}:00`;
}

export function summarize(spot, now = new Date()) {
  const h = spot.hourly;
  const key = tokyoHourKey(now);
  let i = h.time.indexOf(key);
  if (i < 0) i = h.time.length - 1;
  const sum = (a, b) => {
    let s = 0;
    for (let k = Math.max(0, a); k <= Math.min(h.time.length - 1, b); k++) s += h.snowfall[k] || 0;
    return Math.round(s);
  };
  // "Overnight" = 4pm yesterday to 8am today, the window that matters for first chair.
  const today = key.slice(0, 10);
  const i8 = h.time.indexOf(`${today}T08:00`);
  const overnight = i8 >= 0 ? sum(i8 - 16, i8 - 1) : sum(i - 16, i - 1);
  const gustsToday = Math.max(...h.wind_gusts_10m.slice(i, i + 10).filter((x) => x != null));
  return {
    now: { temp: h.temperature_2m[i], wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], code: h.weather_code[i] },
    overnight,
    last24: sum(i - 23, i),
    next24: sum(i + 1, i + 24),
    depth: h.snow_depth[i] != null ? Math.round(h.snow_depth[i] * 100) : null,
    gustsToday,
    daily: spot.daily.time.map((d, k) => ({
      date: d,
      snow: Math.round(spot.daily.snowfall_sum[k] || 0),
      hi: spot.daily.temperature_2m_max[k],
      lo: spot.daily.temperature_2m_min[k],
      gust: spot.daily.wind_gusts_10m_max[k],
    })),
  };
}

export function weatherWord(code) {
  if (code == null) return '';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return code >= 75 || code === 86 ? 'Heavy snow' : 'Snowing';
  if ([0, 1].includes(code)) return 'Clear';
  if ([2].includes(code)) return 'Partly cloudy';
  if ([3].includes(code)) return 'Overcast';
  if ([45, 48].includes(code)) return 'Fog';
  if (code >= 51 && code <= 67) return 'Rain / sleet';
  if (code >= 95) return 'Storm';
  return 'Cloudy';
}
