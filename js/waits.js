// Lift wait estimates, your own wait reports, and lifts you've marked as on hold.
// Shiga Kogen doesn't publish queue times, so these are rough estimates unless you report one.

import { load, save } from './store.js';

const REPORT_TTL = 45 * 60 * 1000;

const BASE = { gondola: 6, cable_car: 8, chair_lift: 3, mixed_lift: 5, drag_lift: 1, 't-bar': 1, 'j-bar': 1, platter: 1, rope_tow: 0, magic_carpet: 0 };

let reports = load('waitReports', {}); // liftId -> {min, at}
let holds = new Set(load('holds', []));

// Japan time, whatever timezone the phone is set to.
function tokyo(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d);
  const get = (t) => p.find((x) => x.type === t).value;
  return { h: Number(get('hour')) + Number(get('minute')) / 60, weekend: ['Sat', 'Sun'].includes(get('weekday')) };
}

function timeFactor(d) {
  const { h } = tokyo(d);
  if (h < 8.5) return 0.8;
  if (h < 9.75) return 1.6; // first-lift rush from the base areas
  if (h < 11.5) return 1.1;
  if (h < 13) return 0.6; // everyone's at lunch
  if (h < 15) return 0.9;
  return 0.5;
}

function dayFactor(d) {
  return tokyo(d).weekend ? 1.8 : 1; // weekends busier (17 Jan 2027 is a Sunday)
}

export function waitFor(lift, areaName = '', now = new Date()) {
  const r = reports[lift.id];
  if (r && now - r.at < REPORT_TTL) return { min: r.min, source: 'reported', ago: Math.round((now - r.at) / 60000) };
  let base = BASE[lift.type] ?? 2;
  if (lift.type === 'chair_lift' && lift.speed >= 5) base = 4;
  const central = /ichinose|一の瀬|takamagahara|高天ヶ原|giant|ジャイアント/i.test(areaName) ? 1.3 : 1;
  const min = Math.round(base * timeFactor(now) * dayFactor(now) * central);
  return { min, source: 'estimate' };
}

export function report(liftId, min) {
  reports[liftId] = { min, at: Date.now() };
  save('waitReports', reports);
}

export function isHeld(id) { return holds.has(id); }
export function toggleHold(id) {
  holds.has(id) ? holds.delete(id) : holds.add(id);
  save('holds', [...holds]);
}
export function heldIds() { return holds; }

export function waitLevel(min) {
  if (min >= 15) return 'long';
  if (min >= 10) return 'mid';
  return 'short';
}
