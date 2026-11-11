// Loads the resort data: the snapshot built by the GitHub Action, or live from OpenStreetMap as a fallback.

import { normalize, overpassQuery } from './osm.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const LIVE_CACHE = 'shiga-osm-live';

export async function loadResortData() {
  try {
    const res = await fetch('./data/shiga.json', { cache: 'no-cache' });
    if (res.ok) {
      const d = await res.json();
      if (d.pistes && d.pistes.length) return { data: d, source: 'snapshot' };
    }
  } catch { /* fall through */ }

  // No snapshot yet: try the cached live copy, then OpenStreetMap directly.
  try {
    const c = await caches.open(LIVE_CACHE);
    const hit = await c.match('osm');
    if (hit) return { data: await hit.json(), source: 'cached' };
  } catch { /* Cache API unavailable */ }

  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery() }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = normalize(await res.json());
      try { (await caches.open(LIVE_CACHE)).put('osm', new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })); } catch { /* ignore */ }
      return { data, source: 'live' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Could not load map data');
}
