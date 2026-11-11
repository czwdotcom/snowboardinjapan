import { loadResortData } from './data.js';
import { RideGraph, liftLabel } from './route.js';
import { waitFor, report, isHeld, toggleHold, heldIds, waitLevel } from './waits.js';
import { parseGPX, analyzeDay } from './runs.js';
import { fetchSnow, summarize, weatherWord } from './snow.js';
import { dist, lineLength, pointInPolygon, fmtDist, fmtMin } from './geo.js';
import { load, save } from './store.js';

const TRIP = ['2027-01-17', '2027-01-18', '2027-01-19', '2027-01-20'];
const CENTER = [36.745, 138.512];
const CLASSES = [
  ['beg', 'Beginner'], ['int', 'Intermediate'], ['adv', 'Advanced'], ['park', 'Park'], ['off', 'Off-piste'],
];
const CLS_LABEL = Object.fromEntries(CLASSES);
const COLOR = { beg: '#2E7D4F', int: '#D0342C', adv: '#0F1B2A', park: '#7B3FC4', off: '#8A5A2B' };
const LINKS = {
  official: 'https://www.shigakogen.gr.jp/english/',
  trailMap: 'https://shigakogen-ski.or.jp/assets/pdf/shigakogen_map_eng.pdf',
  webcams: 'https://shigakogen.info/shiga-kogen-webcams/',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  data: null,
  graph: null,
  lifts: new Map(),
  allowed: new Set(load('filters', CLASSES.map((c) => c[0]))),
  pos: null,
  dest: null,
  route: null,
  routeFromPos: null,
  days: load('days', []),
  day: null,
  liftArea: new Map(),
};

/* ---------- Map ---------- */
const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true }).setView(CENTER, 13);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.attributionControl.setPrefix(false);

const layers = {
  pisteAreas: L.layerGroup().addTo(map),
  pistes: L.layerGroup().addTo(map),
  lifts: L.layerGroup().addTo(map),
  waits: L.layerGroup(),
  food: L.layerGroup(),
  route: L.layerGroup().addTo(map),
  track: L.layerGroup().addTo(map),
  me: L.layerGroup().addTo(map),
};
const pisteLayers = [];

function drawResort() {
  const d = S.data;
  for (const p of d.pistes) {
    let layer;
    if (p.area) {
      layer = L.polygon(p.coords, { stroke: false, fillColor: COLOR[p.cls], fillOpacity: p.cls === 'off' ? 0.12 : 0.08, interactive: false });
      layers.pisteAreas.addLayer(layer);
    } else {
      const style = p.cls === 'park'
        ? { color: COLOR.park, weight: 8, opacity: 0.45 }
        : p.cls === 'off'
          ? { color: COLOR.off, weight: 3, dashArray: '2 6' }
          : { color: COLOR[p.cls], weight: 4, opacity: 0.95, dashArray: p.diffTagged ? null : '8 5' };
      layer = L.polyline(p.coords, { ...style, lineCap: 'round' });
      layer.on('click', () => showPiste(p));
      layers.pistes.addLayer(layer);
    }
    pisteLayers.push({ p, layer });
  }
  for (const l of d.lifts) {
    S.lifts.set(l.id, l);
    const line = L.polyline(l.coords, { color: '#4A5868', weight: 2.5 });
    line.on('click', () => showLift(l));
    layers.lifts.addLayer(line);
    [l.coords[0], l.coords[l.coords.length - 1]].forEach((c) => layers.lifts.addLayer(L.circleMarker(c, { radius: 3.5, color: '#4A5868', fillColor: '#4A5868', fillOpacity: 1, weight: 1 }).on('click', () => showLift(l))));
  }
  for (const f of d.food) {
    const m = L.marker([f.lat, f.lon], { icon: L.divIcon({ className: '', html: `<div class="fm" aria-hidden="true">${ICON.fork}</div>`, iconSize: [0, 0] }), title: f.name, keyboard: true });
    m.on('click', () => showFood(f));
    layers.food.addLayer(m);
  }
  applyFilters();
  drawWaits();
  map.on('zoomend', zoomLayers);
  zoomLayers();
}

function zoomLayers() {
  const z = map.getZoom();
  z >= 14 ? layers.waits.addTo(map) : layers.waits.remove();
  z >= 15 ? layers.food.addTo(map) : layers.food.remove();
}

function areaOf(pos) {
  if (!S.data) return '';
  const a = S.data.areas.find((ar) => pointInPolygon(pos, ar.coords));
  return a ? shortArea(a.name) : '';
}
// "Shiga Kogen Yakebitaiyama Ski Area" -> "Yakebitaiyama"
function shortArea(n) {
  return (n || '').replace(/^Shiga Kogen\s+/i, '').replace(/\s+Ski (Area|Resort)$/i, '').trim() || n;
}
function liftArea(l) {
  if (!S.liftArea.has(l.id)) S.liftArea.set(l.id, areaOf(l.coords[0]));
  return S.liftArea.get(l.id);
}

function liftWait(l) {
  if (isHeld(l.id)) return { min: null, source: 'hold' };
  return waitFor(l, liftArea(l));
}

function drawWaits() {
  layers.waits.clearLayers();
  for (const l of S.lifts.values()) {
    if (!['gondola', 'cable_car', 'chair_lift', 'mixed_lift'].includes(l.type)) continue;
    const w = liftWait(l);
    const lvl = w.source === 'hold' ? 'hold' : waitLevel(w.min);
    const label = w.source === 'hold' ? 'hold' : `${w.source === 'reported' ? '' : '~'}${w.min}m`;
    const mid = l.coords[Math.floor(l.coords.length / 2)];
    const m = L.marker(mid, { icon: L.divIcon({ className: '', html: `<span class="wb ${lvl}"><i></i>${esc(label)}</span>`, iconSize: [0, 0] }), title: `${l.name || liftLabel(l.type)}: ${label}` });
    m.on('click', () => showLift(l));
    layers.waits.addLayer(m);
  }
}

/* ---------- Filters + legend ---------- */
function renderChips() {
  $('#chips').innerHTML = CLASSES.map(([k, label]) => `<button class="chip ${S.allowed.has(k) ? '' : 'off'}" data-cls="${k}" aria-pressed="${S.allowed.has(k)}"><span class="sw ${k}"></span>${label}</button>`).join('');
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cls]');
  if (!b) return;
  const k = b.dataset.cls;
  S.allowed.has(k) ? S.allowed.delete(k) : S.allowed.add(k);
  save('filters', [...S.allowed]);
  renderChips();
  applyFilters();
  if (S.dest) computeRoute();
});
function applyFilters() {
  for (const { p, layer } of pisteLayers) {
    const on = S.allowed.has(p.cls);
    if (p.area) layer.setStyle({ fillOpacity: on ? (p.cls === 'off' ? 0.12 : 0.08) : 0.02 });
    else layer.setStyle({ opacity: on ? (p.cls === 'park' ? 0.45 : 0.95) : 0.12 });
  }
}
let legendOn = load('legend', true);
function renderLegend() {
  $('#legend').hidden = !legendOn;
  $('#btnLegend').classList.toggle('on', legendOn);
  $('#btnLegend').setAttribute('aria-pressed', legendOn);
}
$('#btnLegend').addEventListener('click', () => { legendOn = !legendOn; save('legend', legendOn); renderLegend(); });

/* ---------- Location ---------- */
let watchId = null;
let meMarker = null, accCircle = null;
const nearResort = (p) => p && dist(p, CENTER) < 12000;

function startLocation(center) {
  if (!('geolocation' in navigator)) { toast('This browser has no location access.'); return; }
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(onPos, (err) => {
      toast(err.code === 1 ? 'Location is blocked. Allow it for this site in your browser settings.' : 'Can’t get your location right now.');
      $('#btnLocate').classList.remove('live');
      watchId = null;
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    save('locOn', true);
  }
  $('#btnLocate').classList.add('live');
  if (center && S.pos) centerOnMe();
  else if (center) S.centerNext = true;
}
function onPos(p) {
  S.pos = [p.coords.latitude, p.coords.longitude];
  if (!meMarker) {
    accCircle = L.circle(S.pos, { radius: p.coords.accuracy, color: '#1F5FD6', weight: 0, fillOpacity: 0.12, interactive: false }).addTo(layers.me);
    meMarker = L.marker(S.pos, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(layers.me);
  } else {
    meMarker.setLatLng(S.pos); accCircle.setLatLng(S.pos).setRadius(p.coords.accuracy);
  }
  if (S.centerNext) { S.centerNext = false; centerOnMe(); }
  const a = nearResort(S.pos) ? areaOf(S.pos) : '';
  $('#areaName').textContent = a || 'Shiga Kogen';
  if (S.dest && S.routeFromPos && dist(S.pos, S.routeFromPos) > 100) computeRoute(true);
  if ($('#view-eat').classList.contains('active')) renderEat();
}
function centerOnMe() {
  if (!S.pos) return;
  if (nearResort(S.pos)) map.setView(S.pos, Math.max(map.getZoom(), 15));
  else toast(`You’re ${Math.round(dist(S.pos, CENTER) / 1000).toLocaleString()} km from Shiga Kogen. Your dot will appear here once you arrive.`);
}
$('#btnLocate').addEventListener('click', () => startLocation(true));

/* ---------- Lift / run / food details ---------- */
function openModal(id) { $(id).hidden = false; $(id).querySelector('[data-close]').focus(); }
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('click', (e) => {
  if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
}));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

function showLift(l) {
  const w = liftWait(l);
  const len = lineLength(l.coords);
  const ride = l.duration || len / l.speed;
  const held = isHeld(l.id);
  const waitTxt = held ? 'On hold' : w.source === 'reported' ? `${w.min} min · you reported ${w.ago} min ago` : `~${w.min} min (estimate)`;
  $('#detailTitle').textContent = l.name || liftLabel(l.type);
  $('#detailBody').innerHTML = `
    <p class="hint">${esc(liftLabel(l.type))}${liftArea(l) ? ` · ${esc(liftArea(l))}` : ''}</p>
    <div class="kv">
      <div><span>Wait now</span><b>${esc(waitTxt.split(' · ')[0])}</b></div>
      <div><span>Ride time</span><b>${fmtMin(ride)}</b></div>
    </div>
    ${w.source === 'reported' ? `<p class="hint">Reported ${w.ago} min ago.</p>` : held ? '' : '<p class="hint">Estimated from lift type, time of day and weekday vs weekend. Report the real queue to override it for 45 min.</p>'}
    <p class="label">How long is the queue right now?</p>
    <div class="row gap" id="reportBtns">
      ${[0, 5, 10, 15, 20].map((m) => `<button class="btn small" data-min="${m}">${m === 0 ? 'None' : m === 20 ? '20+ min' : `${m} min`}</button>`).join('')}
    </div>
    <p class="label">Lift status</p>
    <div class="row gap">
      <button class="btn small ${held ? 'sel' : ''}" id="holdBtn" aria-pressed="${held}">${held ? 'Marked on hold · tap to clear' : 'Mark on hold / closed'}</button>
      <a class="btn small" href="${LINKS.official}" target="_blank" rel="noopener">Official live status ↗</a>
    </div>
    <p class="hint">Lifts on hold are skipped when planning routes.</p>
    <div class="row gap" style="margin-top:12px"><button class="btn primary" id="routeLift">Route to this lift</button></div>`;
  $('#reportBtns').onclick = (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    report(l.id, Number(b.dataset.min));
    drawWaits();
    if (S.dest) computeRoute();
    showLift(l);
  };
  $('#holdBtn').onclick = () => { toggleHold(l.id); drawWaits(); if (S.dest) computeRoute(); showLift(l); };
  $('#routeLift').onclick = () => { $('#detail').hidden = true; setDest({ label: l.name || liftLabel(l.type), node: l.nodes[0] }); };
  openModal('#detail');
}

function showPiste(p) {
  $('#detailTitle').textContent = p.name || `${CLS_LABEL[p.cls]} run`;
  $('#detailBody').innerHTML = `
    <p class="hint"><span class="sw ${p.cls}"></span> ${CLS_LABEL[p.cls]}${p.diffTagged ? '' : ' (difficulty not mapped; shown dashed)'}</p>
    <div class="kv"><div><span>Length</span><b>${fmtDist(lineLength(p.coords))}</b></div><div><span>Area</span><b style="font-size:15px">${esc(areaOf(p.coords[0]) || 'Shiga Kogen')}</b></div></div>
    ${p.cls === 'off' ? '<p class="hint">Off-piste: ungroomed and unpatrolled. Rules differ between areas, so check before you go.</p>' : ''}
    <button class="btn primary" id="routePiste">Route to the top of this run</button>`;
  $('#routePiste').onclick = () => { $('#detail').hidden = true; setDest({ label: p.name || `${CLS_LABEL[p.cls]} run`, node: p.nodes[0] }); };
  openModal('#detail');
}

function showFood(f) {
  $('#detailTitle').textContent = f.name;
  $('#detailBody').innerHTML = `
    ${f.nameJa ? `<p class="hint" lang="ja">${esc(f.nameJa)}</p>` : ''}
    <div class="tags"><span>${esc(kindLabel(f.kind))}</span>${f.cuisine ? `<span>${esc(f.cuisine.replace(/;/g, ', ').replace(/_/g, ' '))}</span>` : ''}</div>
    <p class="hint">${f.hours ? `Hours: ${esc(f.hours)}` : 'Hours not listed'}</p>
    <button class="btn primary" id="routeFood">Route me there</button>`;
  $('#routeFood').onclick = () => { $('#detail').hidden = true; routeToPoint(f.name, [f.lat, f.lon]); };
  openModal('#detail');
}

/* ---------- Routing ---------- */
function setDest(dest) {
  S.dest = dest;
  go('map');
  $('#routeSheet').classList.add('open');
  $('#sheetToggle').setAttribute('aria-expanded', 'true');
  computeRoute();
}
function routeToPoint(label, pos) {
  if (!S.graph) return;
  const n = S.graph.nearestNode(pos, 600);
  if (!n) { toast('That spot isn’t near any run or lift.'); return; }
  setDest({ label, node: n.node });
}

function computeRoute(quiet) {
  if (!S.graph || !S.dest) return;
  let fromPos, fromLabel;
  if (S.pos && nearResort(S.pos)) { fromPos = S.pos; fromLabel = 'From your location'; }
  else { fromPos = [map.getCenter().lat, map.getCenter().lng]; fromLabel = S.pos ? 'You’re not at Shiga yet, so this starts from the map centre.' : 'Starting from the map centre. Tap ◎ to start from your location.'; }
  const start = S.graph.nearestNode(fromPos, 2500);
  if (!start) { routeMsg('Move the map over the ski area to plan from there.'); return; }
  S.routeFromPos = S.pos && nearResort(S.pos) ? S.pos : null;
  const r = S.graph.route(start.node, S.dest.node, {
    allowed: S.allowed,
    held: heldIds(),
    waitMin: (l) => { const w = liftWait(l); return w.min ?? 0; },
  });
  $('#routeFrom').textContent = fromLabel;
  $('#btnClearRoute').hidden = false;
  if (!r) {
    S.route = null; layers.route.clearLayers();
    const anyRoute = S.graph.route(start.node, S.dest.node, { allowed: new Set(CLASSES.map((c) => c[0])), held: new Set(), waitMin: () => 0 });
    routeMsg(anyRoute
      ? `No route to ${S.dest.label} with your current filters or lift holds. Turn on more run types or clear a hold.`
      : `${S.dest.label} isn’t linked to where you are by lifts or runs. Kumanoyu, Yokoteyama and Shibutoge are reached by the free shuttle bus.`);
    return;
  }
  S.route = r;
  $('#sheetTitle').textContent = `To ${S.dest.label}`;
  $('#sheetSub').textContent = r.steps.length ? `~${fmtMin(r.total)} · ${r.lifts} lift${r.lifts === 1 ? '' : 's'}` : 'You’re already here';
  $('#steps').innerHTML = r.steps.map((s, i) => stepHTML(s, i)).join('');
  layers.route.clearLayers();
  const all = r.steps.map((s) => s.coords);
  if (all.length) {
    L.polyline(all, { color: '#1F5FD6', weight: 8, opacity: 0.85, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(layers.route);
    L.polyline(all, { color: '#FFFFFF', weight: 2, dashArray: '4 7', interactive: false }).addTo(layers.route);
    if (!quiet) map.fitBounds(L.latLngBounds(all.flat()), { paddingTopLeft: [20, 70], paddingBottomRight: [20, 260] });
  }
}
function stepHTML(s, i) {
  if (s.kind === 'lift') {
    const held = isHeld(s.lift.id);
    const lvl = waitLevel(s.wait);
    return `<li><span class="num">${i + 1}</span><span class="st"><b>${esc(s.name)}</b><span>${liftLabel(s.lift.type)} · ride ${fmtMin(s.t)}</span></span>${held ? '' : `<span class="tag ${lvl}">~${s.wait} min</span>`}</li>`;
  }
  if (s.kind === 'walk') return `<li><span class="num walk">${i + 1}</span><span class="st"><b>Walk / skate across</b><span>${fmtDist(s.len)}</span></span></li>`;
  const via = s.via && s.via.length ? ` · then ${s.via.map(esc).join(', ')}` : '';
  return `<li><span class="num ${s.cls}">${i + 1}</span><span class="st"><b>${esc(s.name || `${CLS_LABEL[s.cls]} run`)}</b><span>Hardest: ${CLS_LABEL[s.cls]} · ${fmtDist(s.len)}${via}</span></span></li>`;
}
function routeMsg(msg) {
  $('#sheetTitle').textContent = S.dest ? `To ${S.dest.label}` : 'Where to?';
  $('#sheetSub').textContent = 'No route';
  $('#steps').innerHTML = `<li><span class="st"><span>${esc(msg)}</span></span></li>`;
}
function clearRoute() {
  S.dest = null; S.route = null; layers.route.clearLayers();
  $('#steps').innerHTML = ''; $('#routeFrom').textContent = '';
  $('#sheetTitle').textContent = 'Where to?';
  $('#sheetSub').textContent = 'Pick a lift, food spot or area';
  $('#btnClearRoute').hidden = true;
}
$('#btnClearRoute').addEventListener('click', clearRoute);
$('#sheetToggle').addEventListener('click', () => {
  const open = $('#routeSheet').classList.toggle('open');
  $('#sheetToggle').setAttribute('aria-expanded', open);
});

/* ---------- Destination picker ---------- */
function pickerItems() {
  if (!S.data) return [];
  const lifts = [...S.lifts.values()]
    .filter((l) => l.type !== 'magic_carpet')
    .sort((a, b) => rankLift(a) - rankLift(b) || (a.name || '').localeCompare(b.name || ''))
    .map((l) => ({ group: 'Lifts', label: l.name || liftLabel(l.type), sub: `${liftLabel(l.type)}${liftArea(l) ? ` · ${liftArea(l)}` : ''}`, pick: () => setDest({ label: l.name || liftLabel(l.type), node: l.nodes[0] }) }));
  const food = S.data.food.map((f) => ({ group: 'Food & drink', label: f.name, sub: `${kindLabel(f.kind)}${areaOf([f.lat, f.lon]) ? ` · ${areaOf([f.lat, f.lon])}` : ''}`, pick: () => routeToPoint(f.name, [f.lat, f.lon]) }));
  const areas = S.data.areas.filter((a) => a.name).map((a) => {
    const c = a.coords.reduce((acc, p) => [acc[0] + p[0] / a.coords.length, acc[1] + p[1] / a.coords.length], [0, 0]);
    return { group: 'Ski areas', label: shortArea(a.name), sub: a.nameJa && a.nameJa !== a.name ? a.nameJa : '', pick: () => routeToPoint(shortArea(a.name), c) };
  });
  return [...areas, ...lifts, ...food];
}
const rankLift = (l) => ({ gondola: 0, cable_car: 0, mixed_lift: 1, chair_lift: 2 }[l.type] ?? 3);
function renderPicker() {
  const q = $('#pickerSearch').value.trim().toLowerCase();
  const items = pickerItems().filter((it) => !q || `${it.label} ${it.sub}`.toLowerCase().includes(q));
  S.pickerItems = items;
  let html = '', group = '';
  items.slice(0, 200).forEach((it, i) => {
    if (it.group !== group) { group = it.group; html += `<h4>${esc(group)}</h4>`; }
    html += `<button class="pick" data-i="${i}"><span class="st"><b>${esc(it.label)}</b><span>${esc(it.sub)}</span></span></button>`;
  });
  $('#pickerList').innerHTML = html || '<p class="hint">Nothing matches.</p>';
}
$('#btnPickDest').addEventListener('click', () => {
  if (!S.data) { toast('Map data is still loading.'); return; }
  $('#pickerSearch').value = '';
  renderPicker();
  $('#picker').hidden = false;
  $('#pickerSearch').focus();
});
$('#pickerSearch').addEventListener('input', renderPicker);
$('#pickerList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-i]');
  if (!b) return;
  $('#picker').hidden = true;
  S.pickerItems[Number(b.dataset.i)].pick();
});

/* ---------- Runs (Slopes GPX) ---------- */
$('#gpxInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const msgs = [];
  for (const f of files) {
    try {
      const pts = parseGPX(await f.text());
      const day = analyzeDay(pts, S.data ? S.data.lifts : []);
      day.file = f.name;
      S.days = S.days.filter((d) => d.id !== day.id).concat(day).sort((a, b) => a.start - b.start);
      S.day = day.id;
      msgs.push(`${fmtDate(day.date)}: ${day.totals.runs} runs imported.`);
    } catch (err) {
      msgs.push(`${f.name}: ${err.message}`);
    }
  }
  if (!save('days', S.days)) msgs.push('Phone storage is full, so this import won’t be kept after closing the app.');
  $('#importMsg').textContent = msgs.join(' ');
  renderRuns();
});

function renderRuns() {
  const tabs = $('#dayTabs');
  if (!S.days.length) {
    tabs.innerHTML = '';
    $('#dayDetail').innerHTML = '<div class="empty">No runs yet. After each day on the mountain, export it from Slopes and import it here.</div>';
    $('#howto').open = true;
    return;
  }
  if (!S.days.find((d) => d.id === S.day)) S.day = S.days[S.days.length - 1].id;
  tabs.innerHTML = S.days.map((d) => `<button role="tab" aria-selected="${d.id === S.day}" data-day="${d.id}">${dayName(d.date)}</button>`).join('');
  const d = S.days.find((x) => x.id === S.day);
  const t = d.totals;
  const tot = t.ride + t.lift + t.queue || 1;
  $('#dayDetail').innerHTML = `
    <div class="stats">
      <div class="stat"><span>Runs</span><b>${t.runs}</b></div>
      <div class="stat"><span>Vertical descent</span><b>${t.vert != null ? `${t.vert.toLocaleString()} m` : '—'}</b></div>
      <div class="stat"><span>Top speed</span><b>${kmh(t.top)} km/h</b></div>
      <div class="stat"><span>Distance ridden</span><b>${(t.dist / 1000).toFixed(1)} km</b></div>
    </div>
    <div class="split">
      <b style="font-size:13px">Where your time went</b>
      <div class="bar" role="img" aria-label="Riding ${fmtMin(t.ride)}, on lifts ${fmtMin(t.lift)}, queuing ${fmtMin(t.queue)}">
        <i style="flex:${t.ride / tot};background:#1F5FD6"></i><i style="flex:${t.lift / tot};background:#9AAAB9"></i><i style="flex:${t.queue / tot};background:#D9661F"></i>
      </div>
      <div class="keys">
        <span><i style="background:#1F5FD6"></i>Riding ${fmtMin(t.ride)}</span>
        <span><i style="background:#9AAAB9"></i>On lifts ${fmtMin(t.lift)}</span>
        <span><i style="background:#D9661F"></i>Queuing ${fmtMin(t.queue)}</span>
      </div>
    </div>
    <div class="runlist">
      ${d.runs.map((r, i) => `
        <button class="runrow" data-run="${i}">
          ${trace(r.coords)}
          <span class="st"><b>Run ${r.n}${r.fromLift ? ` · from ${esc(r.fromLift)}` : ''}</b>
          <span>${fmtClock(r.start)} · ${fmtMin(r.dur)}${r.drop != null ? ` · ${r.drop} m drop` : ''}${r.waitBefore > 30 ? ` · queued ${fmtMin(r.waitBefore)}` : ''}</span></span>
          <span class="spd">${kmh(r.top)} km/h</span>
        </button>`).join('') || '<p class="hint" style="padding:12px">No runs detected in this file.</p>'}
    </div>
    <div class="row gap" style="margin-top:12px">
      <button class="btn" id="showDay">Show whole day on map</button>
      <button class="btn danger" id="delDay">Delete day</button>
    </div>
    ${d.hasEle ? '' : '<p class="hint">This file has no elevation, so vertical stats are missing and lift rides are matched by position only.</p>'}`;
}
$('#dayTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-day]'); if (b) { S.day = b.dataset.day; renderRuns(); } });
$('#dayDetail').addEventListener('click', (e) => {
  const d = S.days.find((x) => x.id === S.day);
  if (!d) return;
  const r = e.target.closest('[data-run]');
  if (r) { const run = d.runs[Number(r.dataset.run)]; showTracks([run], `Run ${run.n} · ${kmh(run.top)} km/h top · ${fmtMin(run.dur)}`); return; }
  if (e.target.closest('#showDay')) showTracks(d.runs, `${dayName(d.date)} · ${d.totals.runs} runs`);
  if (e.target.closest('#delDay')) {
    S.days = S.days.filter((x) => x.id !== d.id); save('days', S.days); S.day = null; renderRuns();
  }
});
function showTracks(runs, label) {
  layers.track.clearLayers();
  const all = [];
  runs.forEach((r) => { L.polyline(r.coords, { color: '#D9661F', weight: 5, opacity: 0.9, interactive: false }).addTo(layers.track); all.push(...r.coords); });
  go('map');
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [40, 80] });
  banner(label, () => layers.track.clearLayers());
}
function trace(coords) {
  if (!coords || coords.length < 2) return '<svg class="trace" aria-hidden="true"></svg>';
  const la = coords.map((c) => c[0]), lo = coords.map((c) => c[1]);
  const [y0, y1, x0, x1] = [Math.min(...la), Math.max(...la), Math.min(...lo), Math.max(...lo)];
  const s = Math.max(y1 - y0, (x1 - x0) * 0.8) || 1;
  const pts = coords.map(([y, x]) => `${(4 + ((x - x0) * 0.8 / s) * 36).toFixed(1)},${(4 + ((y1 - y) / s) * 24).toFixed(1)}`).join(' ');
  return `<svg class="trace" viewBox="0 0 44 32" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

/* ---------- Eat ---------- */
const EAT_FILTERS = [['all', 'All'], ['cafe', 'Cafés'], ['restaurant', 'Restaurants'], ['fast_food', 'Quick bites'], ['bar', 'Bars']];
let eatFilter = 'all';
function kindLabel(k) { return { restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Quick bites', bar: 'Bar', pub: 'Bar', food_court: 'Food court' }[k] || k; }
function renderEat() {
  $('#eatChips').innerHTML = EAT_FILTERS.map(([k, l]) => `<button class="chip ${eatFilter === k ? '' : 'off'}" style="text-decoration:none" data-k="${k}" aria-pressed="${eatFilter === k}">${l}</button>`).join('');
  if (!S.data) { $('#eatList').innerHTML = '<div class="empty">Loading…</div>'; return; }
  const here = S.pos && nearResort(S.pos);
  const from = here ? S.pos : [map.getCenter().lat, map.getCenter().lng];
  $('#eatFrom').textContent = here ? 'Nearest to you' : 'Distances from the map centre. Turn on location (◎ on the map) to sort by where you are.';
  const list = S.data.food
    .filter((f) => eatFilter === 'all' || f.kind === eatFilter || (eatFilter === 'bar' && f.kind === 'pub'))
    .map((f) => ({ f, d: dist(from, [f.lat, f.lon]) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 40);
  $('#eatList').innerHTML = list.map(({ f, d }) => `
    <div class="card">
      <div class="card-head"><div><b>${esc(f.name)}</b>${f.nameJa ? `<div class="sub" lang="ja">${esc(f.nameJa)}</div>` : ''}<div class="sub">${esc(areaOf([f.lat, f.lon]) || 'Shiga Kogen')}</div></div><span class="d">${fmtDist(d)}</span></div>
      <div class="tags"><span>${esc(kindLabel(f.kind))}</span>${f.cuisine ? `<span>${esc(f.cuisine.split(';')[0].replace(/_/g, ' '))}</span>` : ''}</div>
      <p class="hint">${f.hours ? `Hours: ${esc(f.hours)}` : 'Hours not listed'}</p>
      <div class="card-foot"><button class="btn small" data-show="${esc(f.id)}">Show on map</button><button class="btn small primary" data-route="${esc(f.id)}">Route me there</button></div>
    </div>`).join('') || '<div class="empty">Nothing mapped for this filter yet.</div>';
}
$('#eatChips').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { eatFilter = b.dataset.k; renderEat(); } });
$('#eatList').addEventListener('click', (e) => {
  const s = e.target.closest('[data-show]'), r = e.target.closest('[data-route]');
  const id = (s || r)?.dataset.show || (s || r)?.dataset.route;
  const f = id && S.data.food.find((x) => x.id === id);
  if (!f) return;
  if (r) routeToPoint(f.name, [f.lat, f.lon]);
  else { go('map'); map.setView([f.lat, f.lon], 17); showFood(f); }
});

/* ---------- Snow ---------- */
async function renderSnow() {
  let res;
  try { res = await fetchSnow(); }
  catch {
    $('#snowBody').innerHTML = `<h2>Snow monitor</h2><div class="empty">Can’t reach the forecast right now. It’ll load when you’re back online.</div>${linksHTML()}`;
    return;
  }
  const top = summarize(res.data.spots[0]);
  const base = summarize(res.data.spots[1]);
  const tripInRange = top.daily.some((d) => TRIP.includes(d.date));
  const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const maxSnow = Math.max(5, ...top.daily.map((d) => d.snow));
  let headline;
  if (top.overnight >= 10) headline = 'Powder morning. Head for the first gondola; trees on Okushiga and Yakebitai hold it best.';
  else if (top.next24 >= 10) headline = `More snow coming: about ${top.next24} cm in the next 24 hours.`;
  else headline = 'No big new snow. Groomers will be firm first thing and soften by late morning.';
  const windy = top.gustsToday >= 50;
  $('#snowPillText').textContent = `${Math.round(top.now.temp)}° · ${top.overnight} cm new`;
  $('#snowBody').innerHTML = `
    <h2>Snow monitor</h2>
    <p class="hint">${res.live ? 'Updated' : 'Offline · saved'} ${new Date(res.data.at).toLocaleString('en-GB', { timeZone: 'Asia/Tokyo', weekday: 'short', hour: '2-digit', minute: '2-digit' })} (Japan time) · Open-Meteo forecast model</p>
    <div class="hero">
      <span class="eyebrow">Overnight at the summit</span>
      <div class="big"><b>${top.overnight}</b><span>cm new</span></div>
      <p>${esc(headline)}</p>
    </div>
    ${windy ? `<div class="card" style="border-color:#D9661F;margin-bottom:10px"><b>Wind-hold risk</b><p class="hint">Gusts up to ${Math.round(top.gustsToday)} km/h on the ridge today. Gondolas, especially Okushiga, may go on standby. Yakebitaiyama is more sheltered.</p></div>` : ''}
    <div class="stats">
      <div class="stat"><span>Summit now</span><b>${Math.round(top.now.temp)} °C</b><span>${esc(weatherWord(top.now.code))}</span></div>
      <div class="stat"><span>Ichinose now</span><b>${Math.round(base.now.temp)} °C</b><span>${esc(weatherWord(base.now.code))}</span></div>
      <div class="stat"><span>Wind · summit</span><b>${Math.round(top.now.wind)} km/h</b><span>gusts ${Math.round(top.now.gust)}</span></div>
      <div class="stat"><span>Last 24 h</span><b>${top.last24} cm</b><span>next 24 h: ${top.next24} cm</span></div>
    </div>
    ${top.depth != null ? `<p class="hint">Model snow depth at the summit: about ${top.depth} cm. Check the resort’s report for the measured base.</p>` : ''}
    <p class="label">New snow by day (summit)</p>
    <div class="fc">
      ${top.daily.map((d) => `<div class="${TRIP.includes(d.date) ? 'trip' : ''} ${d.date < todayKey ? 'past' : ''}"><span>${shortDay(d.date)}</span><span class="barwrap"><i style="height:${Math.max(3, Math.round((d.snow / maxSnow) * 56))}px"></i></span><b>${d.snow}</b><span>${Math.round(d.lo)}°/${Math.round(d.hi)}°</span></div>`).join('')}
    </div>
    <p class="hint">${tripInRange ? 'Your trip days are outlined in blue.' : 'Your trip days (17–20 Jan) will appear here once they’re within the 14-day forecast, from about 6 Jan.'}</p>
    ${linksHTML()}`;
}
function linksHTML() {
  return `<p class="label">Official info &amp; webcams</p><div class="links">
    <a href="${LINKS.official}" target="_blank" rel="noopener">Shiga Kogen: live lifts &amp; navigator <span aria-hidden="true">↗</span></a>
    <a href="${LINKS.trailMap}" target="_blank" rel="noopener">Official trail map (PDF) <span aria-hidden="true">↗</span></a>
    <a href="${LINKS.webcams}" target="_blank" rel="noopener">Webcams <span aria-hidden="true">↗</span></a></div>`;
}

/* ---------- Shell ---------- */
function go(view) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.go === view;
    b.classList.toggle('active', on);
    on ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current');
  });
  if (view === 'map') setTimeout(() => map.invalidateSize(), 0);
  if (view === 'eat') renderEat();
  if (view === 'runs') renderRuns();
  try { sessionStorage.setItem('shiga.view', view); } catch { /* ignore */ }
}
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

let toastTimer;
function toast(msg) { banner(msg); clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#banner').hidden = true; }, 5000); }
function banner(msg, onClose) {
  clearTimeout(toastTimer);
  const b = $('#banner');
  b.innerHTML = `<span>${esc(msg)}</span><button type="button">${onClose ? 'Close' : 'OK'}</button>`;
  b.hidden = false;
  b.querySelector('button').onclick = () => { b.hidden = true; onClose && onClose(); };
}

function dayLabel() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const i = TRIP.indexOf(today);
  if (i >= 0) return `Day ${i + 1} · ${dayName(today)}`;
  if (today < TRIP[0]) {
    const days = Math.round((Date.parse(TRIP[0]) - Date.parse(today)) / 86400000);
    return `Trip in ${days} day${days === 1 ? '' : 's'} · 17–20 Jan`;
  }
  return 'Shiga Kogen trip · Jan 2027';
}
const kmh = (ms) => Math.round(ms * 3.6);
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dayName = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
const fmtClock = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

const ICON = {
  fork: '<svg viewBox="0 0 24 24"><path d="M7 3v8M5 3v5a2 2 0 004 0V3M7 11v10M17 3c-2 0-3 3-3 6s1 4 3 4v8"/></svg>',
};

/* ---------- Boot ---------- */
async function boot() {
  $('#dayLabel').textContent = dayLabel();
  renderChips();
  renderLegend();
  renderRuns();
  const last = (() => { try { return sessionStorage.getItem('shiga.view'); } catch { return null; } })();
  if (last && last !== 'map') go(last);

  renderSnow();
  setInterval(renderSnow, 30 * 60000);
  setInterval(() => { if (S.data) { drawWaits(); if (S.dest) computeRoute(true); } }, 60000);

  if (load('locOn', false)) startLocation(false);

  try {
    const { data, source } = await loadResortData();
    S.data = data;
    S.graph = new RideGraph(data);
    drawResort();
    $('#mapLoading').hidden = true;
    if (source === 'live' || source === 'cached') console.info('Resort data loaded from', source);
    if ($('#view-eat').classList.contains('active')) renderEat();
  } catch (e) {
    $('#mapLoading').innerHTML = 'Couldn’t load runs &amp; lifts. Check your connection. <button class="btn small" id="retry">Retry</button>';
    $('#retry').onclick = () => location.reload();
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
