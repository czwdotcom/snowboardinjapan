// Reads a GPX export (e.g. from Slopes) and splits the day into runs, lift rides and queues.

import { dist, distToLine, simplify } from './geo.js';

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file isn’t a readable GPX file.');
  const pts = [];
  doc.querySelectorAll('trkpt, rtept').forEach((el) => {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    const timeEl = el.getElementsByTagName('time')[0];
    const eleEl = el.getElementsByTagName('ele')[0];
    const t = timeEl ? Date.parse(timeEl.textContent.trim()) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) return;
    const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
    pts.push({ lat, lon, t, ele: Number.isFinite(ele) ? ele : null });
  });
  if (pts.length < 10) throw new Error('No timed GPS points found. In Slopes, export the day as GPX (not KMZ).');
  pts.sort((a, b) => a.t - b.t);
  return pts.filter((p, i) => i === 0 || p.t > pts[i - 1].t);
}

const ll = (p) => [p.lat, p.lon];

export function analyzeDay(pts, lifts = []) {
  const n = pts.length;
  const hasEle = pts.filter((p) => p.ele != null).length > n * 0.8;
  if (hasEle) fillEle(pts);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(ll(pts[i - 1]), ll(pts[i]));

  // Smoothed horizontal + vertical speed over a ±10 s window.
  const v = new Float64Array(n), vz = new Float64Array(n);
  for (let i = 0, j = 0, k = 0; i < n; i++) {
    while (pts[i].t - pts[j].t > 10000) j++;
    if (k < i) k = i;
    while (k < n - 1 && pts[k + 1].t - pts[i].t <= 10000) k++;
    const dt = (pts[k].t - pts[j].t) / 1000 || 1;
    v[i] = (cum[k] - cum[j]) / dt;
    vz[i] = hasEle ? (pts[k].ele - pts[j].ele) / dt : 0;
  }

  // Which points sit on a lift line (helps when elevation is noisy or missing).
  const onLift = new Array(n).fill(null);
  if (lifts.length) {
    for (let i = 0; i < n; i += 1) {
      if (v[i] < 0.8 || v[i] > 7) continue;
      for (const l of lifts) {
        if (distToLine(ll(pts[i]), l.coords) < 25) { onLift[i] = l; break; }
      }
    }
  }

  const state = new Array(n);
  for (let i = 0; i < n; i++) {
    if ((hasEle && vz[i] > 0.25) || (onLift[i] && (!hasEle || vz[i] > 0.05))) state[i] = 'lift';
    else if (v[i] < 0.6) state[i] = 'stop';
    else if ((hasEle && vz[i] < -0.2) || v[i] > 2.5) state[i] = 'ride';
    else state[i] = 'other';
  }

  let segs = rle(state, pts);
  segs = mergeShort(segs, 25000);
  // Lift rides must actually climb or last a while; chairs that pause mid-ride get merged.
  segs.forEach((s) => {
    if (s.state !== 'lift') return;
    const gain = hasEle ? pts[s.e].ele - pts[s.s].ele : 999;
    if (gain < 40 && pts[s.e].t - pts[s.s].t < 90000) s.state = 'other';
  });
  segs = mergeSame(segs);
  for (let i = 1; i < segs.length - 1; i++) {
    const a = segs[i - 1], b = segs[i], c = segs[i + 1];
    if (a.state === 'lift' && c.state === 'lift' && b.state !== 'lift' && pts[b.e].t - pts[b.s].t < 60000) b.state = 'lift';
  }
  segs = mergeSame(segs);

  const liftRides = segs.filter((s) => s.state === 'lift').map((s) => {
    const start = ll(pts[s.s]), end = ll(pts[s.e]);
    let best = null, bd = Infinity;
    for (const l of lifts) {
      const d = dist(start, l.coords[0]) + dist(end, l.coords[l.coords.length - 1]);
      if (d < bd) { bd = d; best = l; }
    }
    const lift = bd < 500 ? best : null;
    // Queue: time spent (nearly) still close to the lift bottom right before boarding.
    let q = s.s;
    while (q > 0 && pts[s.s].t - pts[q - 1].t < 30 * 60000 && state[q - 1] !== 'ride' && dist(ll(pts[q - 1]), start) < 150) q--;
    return {
      s: s.s, e: s.e, qs: q,
      name: lift ? lift.name || 'Lift' : 'Lift',
      liftId: lift ? lift.id : null,
      dur: (pts[s.e].t - pts[s.s].t) / 1000,
      queue: (pts[s.s].t - pts[q].t) / 1000,
      gain: hasEle ? Math.round(pts[s.e].ele - pts[s.s].ele) : null,
      start: pts[s.s].t,
      coords: simplify(pts.slice(s.s, s.e + 1).map(ll), 8),
    };
  });

  // Runs: everything between getting off one lift and joining the next queue.
  const bounds = [];
  let cursor = 0;
  for (const lr of liftRides) { bounds.push([cursor, lr.qs]); cursor = lr.e; }
  bounds.push([cursor, n - 1]);
  const runs = [];
  for (const [a, b] of bounds) {
    if (b - a < 5) continue;
    let moving = 0, dDist = 0, top = 0, minE = Infinity, maxE = -Infinity, vert = 0;
    for (let i = a + 1; i <= b; i++) {
      const dt = (pts[i].t - pts[i - 1].t) / 1000;
      const dd = cum[i] - cum[i - 1];
      if (v[i] > 1 && state[i] !== 'lift') { moving += dt; dDist += dd; }
      if (hasEle) {
        minE = Math.min(minE, pts[i].ele); maxE = Math.max(maxE, pts[i].ele);
        if (pts[i].ele < pts[i - 1].ele) vert += pts[i - 1].ele - pts[i].ele;
      }
    }
    top = topSpeed(pts, cum, a, b);
    const drop = hasEle ? Math.max(0, pts[a].ele - Math.min(pts[b].ele, minE)) : null;
    if ((drop ?? 100) < 30 && dDist < 300) continue;
    runs.push({
      start: pts[a].t,
      dur: moving,
      dist: dDist,
      drop: drop != null ? Math.round(drop) : null,
      vert: hasEle ? Math.round(Math.min(vert, maxE - minE + 20)) : null,
      top,
      avg: moving ? dDist / moving : 0,
      coords: simplify(pts.slice(a, b + 1).map(ll), 5),
    });
  }
  runs.forEach((r, i) => {
    const prevLift = liftRides.filter((l) => l.start < r.start).pop();
    r.n = i + 1;
    r.fromLift = prevLift ? prevLift.name : null;
    r.waitBefore = prevLift ? prevLift.queue : 0;
  });

  const totals = {
    runs: runs.length,
    vert: hasEle ? runs.reduce((a, r) => a + (r.drop || 0), 0) : null,
    top: runs.reduce((a, r) => Math.max(a, r.top), 0),
    dist: runs.reduce((a, r) => a + r.dist, 0),
    ride: runs.reduce((a, r) => a + r.dur, 0),
    lift: liftRides.reduce((a, l) => a + l.dur, 0),
    queue: liftRides.reduce((a, l) => a + l.queue, 0),
    span: (pts[n - 1].t - pts[0].t) / 1000,
  };
  const date = new Date(pts[0].t).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  return { id: date, date, start: pts[0].t, end: pts[n - 1].t, hasEle, totals, runs, lifts: liftRides.map(({ s, e, qs, ...rest }) => rest) };
}

function topSpeed(pts, cum, a, b) {
  // Best sustained speed over ~4 s, ignoring GPS jumps.
  let top = 0;
  for (let i = a, j = a; i <= b; i++) {
    while (j < b && pts[j].t - pts[i].t < 4000) j++;
    const dt = (pts[j].t - pts[i].t) / 1000;
    if (dt < 2) continue;
    const s = (cum[j] - cum[i]) / dt;
    if (s < 35 && s > top) top = s; // >126 km/h is a GPS glitch
  }
  return top;
}

function fillEle(pts) {
  let last = pts.find((p) => p.ele != null)?.ele ?? 0;
  pts.forEach((p) => { if (p.ele == null) p.ele = last; else last = p.ele; });
}

function rle(state, pts) {
  const segs = [];
  for (let i = 0; i < state.length; i++) {
    const last = segs[segs.length - 1];
    if (last && last.state === state[i]) last.e = i;
    else segs.push({ state: state[i], s: i, e: i });
  }
  segs.forEach((s) => { s.ms = pts[s.e].t - pts[s.s].t; });
  return segs;
}

function mergeShort(segs, minMs) {
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.ms < minMs) { prev.e = s.e; prev.ms += s.ms; continue; }
    out.push({ ...s });
  }
  return mergeSame(out);
}

function mergeSame(segs) {
  const out = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.state === s.state) { prev.e = s.e; prev.ms = (prev.ms || 0) + (s.ms || 0); continue; }
    out.push({ ...s });
  }
  return out;
}
