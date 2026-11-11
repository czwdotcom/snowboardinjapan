// Small geometry helpers (WGS84, metres).

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function dist(a, b) {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += dist(coords[i - 1], coords[i]);
  return d;
}

// Distance from point p to segment ab, using a local flat projection (fine at ski-area scale).
export function distToSegment(p, a, b) {
  const k = Math.cos(rad(p[0]));
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * k, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y) * (Math.PI / 180) * R;
}

export function distToLine(p, coords) {
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) best = Math.min(best, distToSegment(p, coords[i - 1], coords[i]));
  return best;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > p[0]) !== (yj > p[0]) && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Grid index for "what's near this point" lookups.
export class Grid {
  constructor(cell = 0.001) { this.cell = cell; this.m = new Map(); }
  key(lat, lon) { return `${Math.floor(lat / this.cell)}:${Math.floor(lon / this.cell)}`; }
  add(lat, lon, item) {
    const k = this.key(lat, lon);
    if (!this.m.has(k)) this.m.set(k, []);
    this.m.get(k).push(item);
  }
  near(lat, lon, rings = 1) {
    const cy = Math.floor(lat / this.cell), cx = Math.floor(lon / this.cell);
    const res = [];
    for (let y = cy - rings; y <= cy + rings; y++)
      for (let x = cx - rings; x <= cx + rings; x++) {
        const a = this.m.get(`${y}:${x}`);
        if (a) res.push(...a);
      }
    return res;
  }
}

// Douglas–Peucker simplification to keep stored tracks small.
export function simplify(pts, tol = 4) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = 0, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i], pts[s], pts[e]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

export function fmtMin(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
