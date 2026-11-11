// Builds a ride graph from OSM runs and lifts, then finds the quickest way between two points.
// Runs are mapped downhill in OpenStreetMap and lifts bottom-to-top, so way direction = travel direction.

import { dist, Grid, lineLength } from './geo.js';

const RIDE_SPEED = { beg: 6, int: 8, adv: 8, park: 6, off: 5 }; // m/s, relaxed holiday pace incl. stops
const WALK_SPEED = 0.9;

export class RideGraph {
  constructor(data) {
    this.coord = new Map();
    this.adj = new Map();
    this.grid = new Grid(0.0007);
    this.ways = new Map();
    const add = (from, to, e) => {
      if (!this.adj.has(from)) this.adj.set(from, []);
      this.adj.get(from).push({ to, ...e });
    };
    const reg = (id, c) => {
      if (!this.coord.has(id)) { this.coord.set(id, c); this.grid.add(c[0], c[1], id); }
    };
    const endpoints = [];

    for (const p of data.pistes) {
      if (p.area || p.nodes.length !== p.coords.length) continue;
      this.ways.set(`p${p.id}`, p);
      p.nodes.forEach((n, i) => reg(n, p.coords[i]));
      for (let i = 1; i < p.nodes.length; i++) {
        const len = dist(p.coords[i - 1], p.coords[i]);
        add(p.nodes[i - 1], p.nodes[i], { kind: 'run', way: `p${p.id}`, cls: p.cls, len, t: len / RIDE_SPEED[p.cls] });
      }
      endpoints.push([p.nodes[0], 45, `p${p.id}`], [p.nodes[p.nodes.length - 1], 45, `p${p.id}`]);
    }
    for (const l of data.lifts) {
      if (l.nodes.length !== l.coords.length) continue;
      this.ways.set(`l${l.id}`, l);
      l.nodes.forEach((n, i) => reg(n, l.coords[i]));
      const a = l.nodes[0], b = l.nodes[l.nodes.length - 1];
      const len = lineLength(l.coords);
      add(a, b, { kind: 'lift', way: `l${l.id}`, lift: l, len, t: l.duration || len / l.speed });
      endpoints.push([a, 80, `l${l.id}`], [b, 80, `l${l.id}`]);
    }
    // Stitch runs and lifts that meet but don't share an OSM node (common at lift stations).
    const nodeWay = new Map();
    for (const [w, obj] of this.ways) obj.nodes.forEach((n) => { if (!nodeWay.has(n)) nodeWay.set(n, new Set()); nodeWay.get(n).add(w); });
    for (const [n, radius, w] of endpoints) {
      const c = this.coord.get(n);
      for (const m of this.grid.near(c[0], c[1], 1)) {
        if (m === n || nodeWay.get(m)?.has(w)) continue;
        const d = dist(c, this.coord.get(m));
        if (d > radius) continue;
        const e = { kind: 'walk', len: d, t: d / WALK_SPEED + 10 };
        add(n, m, e);
        add(m, n, e);
      }
    }
  }

  nearestNode(pos, maxM = 400) {
    let best = null, bd = Infinity;
    for (let rings = 1; rings <= 6 && !best; rings++) {
      for (const n of this.grid.near(pos[0], pos[1], rings)) {
        const d = dist(pos, this.coord.get(n));
        if (d < bd) { bd = d; best = n; }
      }
    }
    return bd <= maxM ? { node: best, dist: bd } : null;
  }

  // opts: { allowed:Set<cls>, held:Set<liftId>, waitMin:(lift)=>minutes }
  route(from, to, opts) {
    const distTo = new Map([[from, 0]]);
    const prev = new Map();
    const heap = new Heap();
    heap.push(0, from);
    while (heap.size) {
      const [d, n] = heap.pop();
      if (n === to) break;
      if (d > (distTo.get(n) ?? Infinity)) continue;
      for (const e of this.adj.get(n) || []) {
        if (e.kind === 'run' && !opts.allowed.has(e.cls)) continue;
        if (e.kind === 'lift' && opts.held.has(e.lift.id)) continue;
        const cost = e.t + (e.kind === 'lift' ? opts.waitMin(e.lift) * 60 : 0);
        const nd = d + cost;
        if (nd < (distTo.get(e.to) ?? Infinity)) {
          distTo.set(e.to, nd);
          prev.set(e.to, [n, e]);
          heap.push(nd, e.to);
        }
      }
    }
    if (!prev.has(to) && from !== to) return null;
    const edges = [];
    for (let n = to; n !== from; ) { const [p, e] = prev.get(n); edges.unshift({ from: p, ...e }); n = p; }
    return this.toSteps(edges, opts);
  }

  toSteps(edges, opts) {
    const steps = [];
    for (const e of edges) {
      const last = steps[steps.length - 1];
      const coords = [this.coord.get(e.from), this.coord.get(e.to)];
      if (e.kind === 'lift') {
        const l = e.lift;
        const wait = opts.waitMin(l);
        steps.push({ kind: 'lift', name: l.name || liftLabel(l.type), lift: l, len: e.len, t: e.t, wait, coords: l.coords });
      } else if (last && last.kind === e.kind && (e.kind === 'walk' || last.way === e.way)) {
        last.len += e.len; last.t += e.t; last.coords.push(coords[1]);
      } else if (last && e.kind === 'walk' && last.kind === 'run') {
        last.len += e.len; last.t += e.t; last.coords.push(coords[1]); // short skate between runs: fold into the run
      } else {
        const w = this.ways.get(e.way);
        steps.push({ kind: e.kind, way: e.way, cls: e.cls, name: w ? w.name : '', len: e.len, t: e.t, coords });
      }
    }
    // Merge consecutive run steps on unnamed connectors into their neighbour for a cleaner list.
    const out = [];
    for (const s of steps) {
      const prev = out[out.length - 1];
      if (s.kind === 'walk' && s.len < 60) { if (prev) { prev.len += s.len; prev.t += s.t; } continue; }
      if (prev && s.kind === 'run' && prev.kind === 'run' && (!s.name || s.name === prev.name)) {
        prev.len += s.len; prev.t += s.t; prev.coords.push(...s.coords.slice(1));
        prev.cls = rank(s.cls) > rank(prev.cls) ? s.cls : prev.cls;
        continue;
      }
      out.push(s);
    }
    const total = out.reduce((a, s) => a + s.t + (s.wait || 0) * 60, 0);
    return { steps: out, total, lifts: out.filter((s) => s.kind === 'lift').length };
  }
}

const RANK = { beg: 0, park: 1, int: 2, adv: 3, off: 4 };
const rank = (c) => RANK[c] ?? 2;

export function liftLabel(type) {
  return { gondola: 'Gondola', cable_car: 'Ropeway', chair_lift: 'Chairlift', mixed_lift: 'Gondola/chair', drag_lift: 'Drag lift', 't-bar': 'T-bar', 'j-bar': 'J-bar', platter: 'Platter', rope_tow: 'Rope tow', magic_carpet: 'Magic carpet' }[type] || 'Lift';
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
