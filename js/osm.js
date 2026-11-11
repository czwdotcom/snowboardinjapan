// Turns a raw Overpass API response into the compact shape the app uses.
// Shared by the browser (live fallback) and scripts/fetch-osm.mjs (GitHub Action snapshot).

export const BBOX = [36.64, 138.46, 36.81, 138.57]; // south, west, north, east — covers all Shiga Kogen areas

export function overpassQuery(b = BBOX) {
  const bb = b.join(',');
  return `[out:json][timeout:90];
(
  way["piste:type"~"^(downhill|snow_park|skitour)$"](${bb});
  way["aerialway"](${bb});
  node["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court)$"](${bb});
  way["amenity"~"^(restaurant|cafe|fast_food|bar|pub|food_court)$"](${bb});
  way["landuse"="winter_sports"](${bb});
  relation["landuse"="winter_sports"](${bb});
);
out geom;`;
}

const LIFT_TYPES = new Set(['gondola', 'cable_car', 'chair_lift', 'mixed_lift', 'drag_lift', 't-bar', 'j-bar', 'platter', 'rope_tow', 'magic_carpet']);

function displayName(t) {
  return t['name:en'] || t['piste:name:en'] || t.name || t['piste:name'] || t['name:ja'] || '';
}

export function pisteClass(t) {
  const type = t['piste:type'];
  const d = (t['piste:difficulty'] || '').toLowerCase();
  const nm = `${t.name || ''} ${t['piste:name'] || ''} ${t['name:en'] || ''}`;
  if (type === 'snow_park' || /park|パーク/i.test(nm)) return 'park';
  if (type === 'skitour' || d === 'freeride' || d === 'extreme' || t['piste:grooming'] === 'backcountry') return 'off';
  if (d === 'novice' || d === 'easy') return 'beg';
  if (d === 'intermediate') return 'int';
  if (d === 'advanced' || d === 'expert') return 'adv';
  return 'int'; // untagged difficulty: treat as intermediate, flagged in UI
}

function liftSpeed(t) {
  const type = t.aerialway;
  if (type === 'gondola' || type === 'cable_car') return 5;
  if (type === 'chair_lift' || type === 'mixed_lift') return t['aerialway:detachable'] === 'yes' ? 5 : 2.3;
  if (type === 'magic_carpet') return 0.6;
  return 2.5;
}

function geom(el) {
  return (el.geometry || []).map((p) => [round(p.lat), round(p.lon)]);
}
function round(x) { return Math.round(x * 1e6) / 1e6; }

function centroid(coords) {
  let la = 0, lo = 0;
  coords.forEach(([a, b]) => { la += a; lo += b; });
  return [round(la / coords.length), round(lo / coords.length)];
}

export function normalize(raw) {
  const out = { generated: new Date().toISOString(), pistes: [], lifts: [], food: [], areas: [] };
  for (const el of raw.elements || []) {
    const t = el.tags || {};
    if (el.type === 'way' && t['piste:type']) {
      const coords = geom(el);
      if (coords.length < 2) continue;
      const closed = el.nodes && el.nodes[0] === el.nodes[el.nodes.length - 1];
      out.pistes.push({
        id: el.id,
        name: displayName(t),
        ref: t['piste:ref'] || t.ref || '',
        cls: pisteClass(t),
        diffTagged: !!t['piste:difficulty'],
        area: closed && (t.area === 'yes' || coords.length > 3) && t.area !== 'no',
        nodes: el.nodes || [],
        coords,
      });
    } else if (el.type === 'way' && LIFT_TYPES.has(t.aerialway)) {
      const coords = geom(el);
      if (coords.length < 2) continue;
      out.lifts.push({
        id: el.id,
        name: displayName(t) || (t.ref ? `Lift ${t.ref}` : ''),
        ref: t.ref || '',
        type: t.aerialway,
        speed: liftSpeed(t),
        duration: t['aerialway:duration'] ? parseDuration(t['aerialway:duration']) : null,
        nodes: el.nodes || [],
        coords,
      });
    } else if (t.amenity && (el.type === 'node' || el.type === 'way')) {
      const pos = el.type === 'node' ? [round(el.lat), round(el.lon)] : centroid(geom(el));
      if (!pos[0]) continue;
      out.food.push({
        id: `${el.type[0]}${el.id}`,
        name: displayName(t) || t.amenity,
        nameJa: t.name && t.name !== displayName(t) ? t.name : '',
        kind: t.amenity,
        cuisine: t.cuisine || '',
        hours: t.opening_hours || '',
        lat: pos[0],
        lon: pos[1],
      });
    } else if (t.landuse === 'winter_sports') {
      let coords = [];
      if (el.type === 'way') coords = geom(el);
      else if (el.members) {
        el.members.filter((m) => m.role === 'outer' && m.geometry).forEach((m) => {
          coords = coords.concat(m.geometry.map((p) => [round(p.lat), round(p.lon)]));
        });
      }
      if (coords.length < 3) continue;
      out.areas.push({ id: el.id, name: displayName(t), nameJa: t.name || '', coords });
    }
  }
  return out;
}

function parseDuration(s) {
  // OSM aerialway:duration is minutes, or "mm:ss"
  if (/^\d+:\d+$/.test(s)) { const [m, sec] = s.split(':').map(Number); return m * 60 + sec; }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * 60 : null;
}
