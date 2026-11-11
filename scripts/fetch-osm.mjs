// Fetches Shiga Kogen runs, lifts and food spots from OpenStreetMap and writes data/shiga.json.
// Run by .github/workflows/data.yml (weekly + on demand), or locally: node scripts/fetch-osm.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { normalize, overpassQuery } from '../js/osm.js';

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

let raw;
for (const url of ENDPOINTS) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': 'shiga-ride (personal trip app)' },
      body: new URLSearchParams({ data: overpassQuery() }),
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    raw = await res.json();
    break;
  } catch (e) {
    console.error(String(e));
  }
}
if (!raw) process.exit(1);

const data = normalize(raw);
if (!data.lifts.length || !data.pistes.length) {
  console.error('Overpass returned no lifts/runs; keeping the previous snapshot.');
  process.exit(1);
}
mkdirSync('data', { recursive: true });
writeFileSync('data/shiga.json', JSON.stringify(data));
const by = (k) => data.pistes.filter((p) => p.cls === k).length;
console.log(`runs ${data.pistes.length} (beg ${by('beg')}, int ${by('int')}, adv ${by('adv')}, park ${by('park')}, off ${by('off')}), lifts ${data.lifts.length}, food ${data.food.length}, areas ${data.areas.length}`);
