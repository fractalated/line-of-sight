// Line of Sight — UI, map, and the recompute pipeline.
// Flow: stations/radius -> choose DEM zoom + tile range -> load elevation grid
// -> viewshed per station -> paint coverage highlight canvas -> Leaflet image overlay.

import {
  lonToX, latToY, xToLon, yToLat, metersPerPixel, distanceM, bearingDeg,
  compassPoint, toMaidenhead, fromMaidenhead, parseLatLon, searchPlaces, reverseGeocode,
} from './geo.js';
import { loadElevationGrid } from './terrain.js';
import { computeViewshed, VISIBLE } from './viewshed.js';
import { computeProfile, drawProfile } from './profile.js';
import { buildKmz, circleCoords, pinIcon, canvasBytes } from './kmz.js';
import { findRelays } from './relay.js';

const L = window.L;
const FT = 0.3048, MI = 1609.344, KM = 1000;
const MAX_GRID = 2048; // max analysis size in DEM pixels
const MAX_Z = 14, MIN_Z = 4;

// Coverage is highlighted; ground out of coverage is left as plain map (the owner found
// shaded-vs-unshaded too hard to tell apart).
const PINK = [255, 20, 147]; // one station: in line of sight
const GREEN = [57, 255, 20]; // two stations: seen by both A and B (dayglow green)
const ONLY_A = [43, 120, 255];
const ONLY_B = [255, 150, 20];
const EDGE = [255, 255, 255]; // outline around the two-station overlap, so small patches pop
const EDGE_ALPHA = 0.85;
const SIDE_FACTOR = 0.75; // A-only / B-only drawn a little lighter than the overlap
const GRAY = [20, 24, 40]; // optional "not covered" layer in the KMZ (off by default)
const DEFAULT_HL = 0.5; // highlight strength (alpha), set by the slider
const RADII = { us: [1, 2, 3, 5, 10, 15, 20, 30, 40, 60], metric: [2, 3, 5, 10, 15, 25, 35, 50, 65, 100] };
const PRESETS = {
  us: [[0, 'On the dirt'], [5, 'Handheld'], [30, 'Mast'], [100, 'Tower']],
  metric: [[0, 'On the dirt'], [1.5, 'Handheld'], [10, 'Mast'], [30, 'Tower']],
};
const SLIDER_MAX = { us: 500, metric: 150 };
const DEFAULT_H = 5 * FT;
const DEFAULT_RELAY_H = 10 * FT; // a Meshtastic node or repeater on a short mast
const RELAY_COLOR = '#9b30ff';

const state = {
  mode: 'single', // 'single' | 'dual'
  a: null, // { lat, lon }
  b: null,
  // Antenna heights above ground, meters. "Ground level" means a person standing
  // with a handheld (5 ft): at a literal 0 ft, DEM bumps a few meters away block nearly everything.
  hA: DEFAULT_H, hB: DEFAULT_H, hT: DEFAULT_H,
  hR: DEFAULT_RELAY_H, // relay antenna height (relay-site search)
  radius: 10 * MI, // meters
  k: 4 / 3,
  freq: 146.52, // MHz, national 2 m simplex calling frequency
  units: 'us',
  highlight: DEFAULT_HL,
  target: 'a', // which station a map click places in dual mode
  // Sidebar place labels: the searched address, or neighborhood + city for clicked points.
  labels: { a: '', b: '' },
};

// ---------- Persistence (URL hash holds the shareable state) ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const ll = (s) => {
    if (!s) return null;
    const [lat, lon] = s.split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  };
  const num = (k, d) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : d);
  state.mode = p.get('m') === '2' ? 'dual' : 'single';
  state.a = ll(p.get('a'));
  state.b = ll(p.get('b'));
  state.labels = { a: p.get('la') || '', b: p.get('lb') || '' };
  state.hA = num('ha', DEFAULT_H); state.hB = num('hb', DEFAULT_H); state.hT = num('ht', DEFAULT_H);
  state.hR = num('hr', DEFAULT_RELAY_H);
  state.radius = num('r', state.radius);
  state.k = num('k', state.k);
  state.freq = num('f', state.freq);
  if (p.get('u') === 'metric') state.units = 'metric';
  // 'hl' replaced the old shade params ('s', 'o'), which are ignored in old links.
  state.highlight = Math.min(0.9, Math.max(0.15, num('hl', DEFAULT_HL)));
  if (state.mode === 'dual' && state.a && !state.b) state.target = 'b';
}

function writeHash() {
  const p = new URLSearchParams();
  const ll = (s) => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`;
  p.set('m', state.mode === 'dual' ? '2' : '1');
  if (state.a) p.set('a', ll(state.a));
  if (state.b) p.set('b', ll(state.b));
  if (state.a && state.labels.a) p.set('la', state.labels.a);
  if (state.b && state.labels.b) p.set('lb', state.labels.b);
  p.set('ha', +state.hA.toFixed(2));
  p.set('hb', +state.hB.toFixed(2));
  p.set('ht', +state.hT.toFixed(2));
  p.set('hr', +state.hR.toFixed(2));
  p.set('r', Math.round(state.radius));
  p.set('k', +state.k.toFixed(4));
  p.set('f', state.freq);
  p.set('u', state.units);
  p.set('hl', state.highlight);
  history.replaceState(null, '', '#' + p.toString().replace(/%2C/g, ','));
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- Formatting ----------
const fmt = {
  elev(m) { return state.units === 'us' ? `${Math.round(m / FT).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`; },
  height(m) { return state.units === 'us' ? `${+(m / FT).toFixed(1)} ft` : `${+m.toFixed(1)} m`; },
  dist(m) {
    if (state.units === 'us') {
      const mi = m / MI;
      return mi < 0.2 ? `${Math.round(m / FT)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
    }
    return m < 1000 ? `${Math.round(m)} m` : `${(m / KM).toFixed(m < 10000 ? 2 : 1)} km`;
  },
};
const heightUnit = () => (state.units === 'us' ? FT : 1);
const radiusUnit = () => (state.units === 'us' ? MI : KM);

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, maxZoom: 19, worldCopyJump: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.control.scale({ position: 'bottomright' }).addTo(map);
map.createPane('labels');
map.getPane('labels').style.zIndex = 450; // above the coverage highlight, below markers
map.getPane('labels').classList.add('leaflet-labels-pane');

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';
const esriImageryAttr = 'Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const usgsAttr = 'USGS The National Map';
const baseLayers = {
  'Satellite (Esri World Imagery)': L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, maxNativeZoom: 18, attribution: esriImageryAttr,
  }),
  'Satellite (USGS, US only)': L.tileLayer(`${USGS}/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, maxNativeZoom: 16, attribution: usgsAttr,
  }),
  'Topo (OpenTopoMap)': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    subdomains: 'abc', maxZoom: 19, maxNativeZoom: 17,
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }),
  'Topo (USGS, US only)': L.tileLayer(`${USGS}/USGSTopo/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 19, maxNativeZoom: 16, attribution: usgsAttr,
  }),
  'Street (OpenStreetMap)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
};
const placeLabels = L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 19, maxNativeZoom: 18, pane: 'labels', attribution: 'Labels &copy; Esri',
});
const roadLabels = L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, {
  maxZoom: 19, maxNativeZoom: 18, pane: 'labels', opacity: 0.8,
});
const losLayer = L.layerGroup();
const relayLayer = L.layerGroup(); // relay-site pins and routes (two-station mode)

const savedBase = store.get('los.base');
(baseLayers[savedBase] || baseLayers['Satellite (Esri World Imagery)']).addTo(map);
if (store.get('los.labels') !== '0') placeLabels.addTo(map);
if (store.get('los.roads') === '1') roadLabels.addTo(map);
losLayer.addTo(map);
relayLayer.addTo(map);

L.control.layers(baseLayers, {
  'Place names': placeLabels,
  'Roads': roadLabels,
  'Line-of-sight coverage': losLayer,
}, { position: 'topright' }).addTo(map);

// On-map button to show/hide the coverage highlight (stays reachable when the panel is
// collapsed). Kept in sync with the layers menu's "Line-of-sight coverage" checkbox.
const ShadingToggle = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'leaflet-bar map-btn shading-toggle');
    btn.type = 'button';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="2"/>
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>
        <path class="slash" d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg><span></span>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => {
      if (map.hasLayer(losLayer)) map.removeLayer(losLayer);
      else map.addLayer(losLayer);
    });
    this._btn = btn;
    this.update();
    return btn;
  },
  update() {
    const on = map.hasLayer(losLayer);
    this._btn.classList.toggle('off', !on);
    this._btn.setAttribute('aria-pressed', String(on));
    this._btn.title = on ? 'Hide the coverage highlight' : 'Show the coverage highlight';
    this._btn.querySelector('span').textContent = on ? 'Coverage on' : 'Coverage off';
  },
});
const shadingToggle = new ShadingToggle().addTo(map);
map.on('layeradd layerremove', (e) => { if (e.layer === losLayer) shadingToggle.update(); });

// Crosshair: a fixed reticle at the center of the visible map with a live "lat, lon"
// readout and a Copy button, so it's clear exactly which point gets copied. Drag the map
// to aim; a click moves the clicked spot under the crosshair. Right-click (long-press on
// phones) still copies the clicked point directly, at any time.
let crosshairOn = false;
const CrosshairToggle = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const btn = L.DomUtil.create('button', 'leaflet-bar map-btn crosshair-toggle');
    btn.type = 'button';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg><span></span>`;
    L.DomEvent.disableClickPropagation(btn);
    L.DomEvent.on(btn, 'click', () => setCrosshair(!crosshairOn));
    this._btn = btn;
    this.update();
    return btn;
  },
  update() {
    this._btn.classList.toggle('active', crosshairOn);
    this._btn.setAttribute('aria-pressed', String(crosshairOn));
    this._btn.title = crosshairOn
      ? 'Hide the crosshair (Esc)'
      : 'Show a crosshair with its latitude, longitude, ready to copy';
    this._btn.querySelector('span').textContent = crosshairOn ? 'Crosshair on' : 'Crosshair';
  },
});
const crosshairToggle = new CrosshairToggle().addTo(map);

// Readout box at the side (under the Crosshair button): live coordinates + Copy.
const CrosshairReadout = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const box = L.DomUtil.create('div', 'leaflet-bar xh-readout');
    box.hidden = true;
    box.innerHTML = `
      <div class="xh-label">Crosshair location</div>
      <div class="xh-row">
        <span id="xhCoords" class="xh-coords"></span>
        <button type="button" id="xhCopy" class="xh-copy">Copy</button>
      </div>`;
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  },
});
const crosshairReadout = new CrosshairReadout().addTo(map);

// Center of the part of the map the panel doesn't cover, in container pixels.
function crosshairPoint() {
  const size = map.getSize();
  const panel = $('#panel');
  if (window.innerWidth <= 700) return L.point(size.x / 2, Math.max(60, (size.y - panel.offsetHeight) / 2));
  const right = panel.classList.contains('collapsed') ? 0 : panel.getBoundingClientRect().right;
  return L.point((right + size.x) / 2, size.y / 2);
}

const crosshairLatLng = () => map.containerPointToLatLng(crosshairPoint()).wrap();
const fmtLatLon = (ll) => `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;

function updateCrosshair() {
  if (!crosshairOn) return;
  const pt = crosshairPoint();
  const el = $('#crosshair');
  el.style.left = `${pt.x}px`;
  el.style.top = `${pt.y}px`;
  $('#xhCoords').textContent = fmtLatLon(crosshairLatLng());
}

function setCrosshair(on) {
  crosshairOn = on;
  $('#crosshair').hidden = !on;
  crosshairReadout.getContainer().hidden = !on;
  map.getContainer().classList.toggle('aiming', on);
  crosshairToggle.update();
  updateCrosshair();
}

map.on('move zoom resize', updateCrosshair);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && crosshairOn) setCrosshair(false); });

let copiedTimer = null;
$('#xhCopy').addEventListener('click', async () => {
  const ok = await copyCoords(crosshairLatLng());
  const btn = $('#xhCopy');
  btn.textContent = ok ? 'Copied ✓' : 'Copy';
  btn.classList.toggle('done', ok);
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1800);
});

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copyCoords(latlng) {
  const text = fmtLatLon(latlng);
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  pingAt(latlng, ok);
  showToast(text, ok);
  return ok;
}

// Expanding ring at the copied spot, then gone.
function pingAt(latlng, ok) {
  const m = L.marker(latlng, {
    icon: L.divIcon({ className: '', html: `<div class="copy-ping ${ok ? '' : 'fail'}"><span></span></div>`, iconSize: [44, 44], iconAnchor: [22, 22] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
  setTimeout(() => m.remove(), 1600);
}

let toastTimer = null;
// title defaults to the copy-coordinates wording; other callers (KMZ export) pass their own.
function showToast(text, ok, title = null) {
  const el = $('#toast');
  el.className = `toast show ${ok ? 'ok' : 'fail'}`;
  const t = escapeHtml(title || (ok ? 'Copied to clipboard' : 'Couldn’t copy automatically. Select and copy:'));
  el.innerHTML = ok
    ? `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
       <div><div class="toast-title">${t}</div><div class="toast-coords">${escapeHtml(text)}</div></div>`
    : `<div><div class="toast-title">${t}</div><div class="toast-coords selectable">${escapeHtml(text)}</div></div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ok ? 2800 : 8000);
}

map.on('contextmenu', (e) => copyCoords(e.latlng.wrap()));

map.on('baselayerchange', (e) => store.set('los.base', e.name));
map.on('overlayadd overlayremove', (e) => {
  const on = e.type === 'overlayadd' ? '1' : '0';
  if (e.layer === placeLabels) store.set('los.labels', on);
  if (e.layer === roadLabels) store.set('los.roads', on);
});

const markers = { a: null, b: null };
const circles = { a: null, b: null };
let overlay = null;
let overlayUrl = null;
let pathLine = null;

function stationIcon(key) {
  return L.divIcon({
    className: '',
    html: `<div class="st-marker ${key}">${key.toUpperCase()}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function stationsShown() {
  return state.mode === 'dual' ? ['a', 'b'] : ['a'];
}

function syncMapObjects() {
  for (const key of ['a', 'b']) {
    const pos = state[key];
    const show = pos && stationsShown().includes(key);
    if (!show) {
      if (markers[key]) { markers[key].remove(); markers[key] = null; }
      if (circles[key]) { circles[key].remove(); circles[key] = null; }
      continue;
    }
    const ll = [pos.lat, pos.lon];
    if (!markers[key]) {
      markers[key] = L.marker(ll, { icon: stationIcon(key), draggable: true, keyboard: true, title: `Station ${key.toUpperCase()} (drag to move)` })
        .on('dragend', (e) => {
          const p = e.target.getLatLng().wrap();
          placeStation(key, p.lat, p.lng);
        })
        .addTo(map);
    } else {
      markers[key].setLatLng(ll);
    }
    const color = key === 'a' ? '#2b78ff' : '#ff9614';
    if (!circles[key]) {
      circles[key] = L.circle(ll, { radius: state.radius, color, weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(map);
    } else {
      circles[key].setLatLng(ll).setRadius(state.radius);
    }
  }
  const both = state.mode === 'dual' && state.a && state.b;
  if (both) {
    const lls = [[state.a.lat, state.a.lon], [state.b.lat, state.b.lon]];
    if (!pathLine) pathLine = L.polyline(lls, { color: '#ffffff', weight: 2, opacity: 0.85, dashArray: '2 6', interactive: false }).addTo(map);
    else pathLine.setLatLngs(lls);
  } else if (pathLine) {
    pathLine.remove();
    pathLine = null;
  }
}

// Map point that should sit at the center of the area the panel doesn't cover.
function panTarget(latlng) {
  const panel = $('#panel');
  const pt = map.project(latlng);
  if (window.innerWidth <= 700) {
    return map.unproject(pt.add([0, panel.offsetHeight / 2]));
  }
  return map.unproject(pt.subtract([(panel.offsetWidth + 10) / 2, 0]));
}

function viewPadding() {
  const panel = $('#panel');
  const size = map.getSize();
  // If the panel leaves too little map showing, padding would force fitBounds to max zoom.
  if (window.innerWidth <= 700) {
    const bottom = panel.offsetHeight + 20;
    return size.y - bottom < 150 ? {} : { paddingTopLeft: [20, 20], paddingBottomRight: [20, bottom] };
  }
  const left = panel.offsetWidth + 30;
  return size.x - left < 200 ? {} : { paddingTopLeft: [left, 20], paddingBottomRight: [20, 20] };
}

function fitStations() {
  const pts = stationsShown().map((k) => state[k]).filter(Boolean);
  if (!pts.length) return;
  let b = L.latLng(pts[0].lat, pts[0].lon).toBounds(state.radius * 2);
  for (const p of pts.slice(1)) b = b.extend(L.latLng(p.lat, p.lon).toBounds(state.radius * 2));
  map.fitBounds(b, viewPadding());
}

map.on('click', (e) => {
  const p = e.latlng.wrap();
  if (crosshairOn) {
    // Bring the clicked spot under the crosshair instead of moving a station.
    map.panBy(map.latLngToContainerPoint(e.latlng).subtract(crosshairPoint()));
    return;
  }
  const key = state.mode === 'dual' ? state.target : 'a';
  // Zoomed far out, the analysis circle would be invisible: zoom to it instead of panning.
  const far = map.getZoom() < 9;
  placeStation(key, p.lat, p.lng, { pan: !far && state.mode === 'single', fit: far });
});

// label: pass the searched address; omit it to look up neighborhood + city for the point.
function placeStation(key, lat, lon, { pan = false, fit = false, label = null } = {}) {
  state[key] = { lat, lon };
  state.labels[key] = label || '';
  if (label) cancelLabelLookup(key);
  else lookupLabel(key);
  if (state.mode === 'dual' && key === 'a' && !state.b) setTarget('b');
  syncMapObjects();
  if (fit) fitStations();
  else if (pan) map.panTo(panTarget(L.latLng(lat, lon)));
  writeHash();
  recompute();
}

// ---------- Recompute pipeline ----------
let grid = null;
let runId = 0;
let last = null;

function chooseZoom(pts) {
  for (let z = MAX_Z; z >= MIN_Z; z--) {
    const b = pixelBounds(pts, z);
    if (Math.max(b.maxX - b.minX, b.maxY - b.minY) <= MAX_GRID) return z;
  }
  return MIN_Z;
}

function pixelBounds(pts, z) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const x = lonToX(p.lon, z), y = latToY(p.lat, z);
    const r = state.radius / metersPerPixel(p.lat, z) + 2;
    minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r);
  }
  return { minX, minY, maxX, maxY };
}

// Yield so the status text paints; the timeout covers background tabs where rAF stalls.
const nextFrame = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 50); });

async function recompute() {
  const id = ++runId;
  const keys = stationsShown().filter((k) => state[k]);
  if (!keys.length) {
    clearOverlay();
    setStatus(state.mode === 'dual'
      ? 'Place station A and station B: pick A or B above, then click the map.'
      : 'Click anywhere on the map, search for a place, or use your location.');
    updateInfo();
    renderLegend();
    return;
  }
  const pts = keys.map((k) => state[k]);
  const z = chooseZoom(pts);
  const b = pixelBounds(pts, z);
  const tx0 = Math.floor(b.minX / 256), tx1 = Math.floor(b.maxX / 256);
  const ty0 = Math.max(0, Math.floor(b.minY / 256)), ty1 = Math.min(2 ** z - 1, Math.floor(b.maxY / 256));
  const gridKey = `${z}/${tx0}/${ty0}/${tx1}/${ty1}`;

  try {
    if (!grid || grid.key !== gridKey) {
      setStatus('Loading terrain…');
      const g = await loadElevationGrid(z, tx0, ty0, tx1, ty1, (done, total) => {
        if (id === runId) setStatus(`Loading terrain ${done}/${total}…`);
      });
      if (id !== runId) return;
      grid = { ...g, key: gridKey };
    }
    setStatus('Computing line of sight…');
    await nextFrame();
    if (id !== runId) return;

    const heights = { a: state.hA, b: state.hB };
    const results = keys.map((key) => {
      const s = state[key];
      const mpp = metersPerPixel(s.lat, z);
      const gx = lonToX(s.lon, z) - grid.x0, gy = latToY(s.lat, z) - grid.y0;
      const radiusPx = state.radius / mpp;
      const v = computeViewshed(grid, { gx, gy, mpp, obsH: heights[key], tgtH: state.hT, radiusPx, k: state.k });
      return { key, gx, gy, mpp, radiusPx, vis: v.out, ground: v.groundElev };
    });
    last = { grid, z, results };
    renderOverlay();
    updateProfile();
    // Relay results are only valid for the stations/settings they were found with.
    if (relay && relay.key !== relayKey()) clearRelays('Stations or settings changed. Press “Find relay sites” to search again.');
    updateRelayBox();
    updateInfo();
    renderLegend();
  } catch (err) {
    console.error(err);
    if (id === runId) setStatus(`Something went wrong: ${err.message}`, true);
  }
}

function clearOverlay() {
  last = null;
  if (overlay) { losLayer.removeLayer(overlay); overlay = null; }
  $('#profileBox').hidden = true;
}

function renderOverlay() {
  if (!last) return;
  const { grid: g, z, results } = last;
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  for (const r of results) {
    cx0 = Math.min(cx0, Math.floor(r.gx - r.radiusPx)); cx1 = Math.max(cx1, Math.ceil(r.gx + r.radiusPx));
    cy0 = Math.min(cy0, Math.floor(r.gy - r.radiusPx)); cy1 = Math.max(cy1, Math.ceil(r.gy + r.radiusPx));
  }
  cx0 = Math.max(0, cx0); cy0 = Math.max(0, cy0);
  cx1 = Math.min(g.W - 1, cx1); cy1 = Math.min(g.H - 1, cy1);
  const w = cx1 - cx0 + 1, h = cy1 - cy0 + 1;

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const A = results[0].vis, B = results[1] ? results[1].vis : null;
  const counts = { area: 0, both: 0, a: 0, b: 0 };

  // Pass 1: classify each pixel. 0 = outside, 1 = hidden, 2 = A only, 3 = B only, 4 = visible/both.
  const cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y + cy0) * g.W + cx0;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const va = A[i], vb = B ? B[i] : 0;
      if (!va && !vb) continue;
      counts.area++;
      const sa = va === VISIBLE, sb = vb === VISIBLE;
      let c;
      if (!B) c = sa ? 4 : 1;
      else if (sa && sb) c = 4;
      else if (sa) c = 2;
      else if (sb) c = 3;
      else c = 1;
      if (c === 4) counts.both++;
      else if (c === 2) counts.a++;
      else if (c === 3) counts.b++;
      cls[y * w + x] = c;
    }
  }

  // Pass 2: paint coverage only; hidden ground (class 1) stays transparent, i.e. plain map.
  const hlA = Math.round(state.highlight * 255);
  const sideA = Math.round(state.highlight * SIDE_FACTOR * 255);
  const edgeA = Math.round(EDGE_ALPHA * 255);
  const put = (o, c, a) => { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x, c = cls[j], o = j * 4;
      if (c === 2) put(o, ONLY_A, sideA);
      else if (c === 3) put(o, ONLY_B, sideA);
      else if (c === 4 && !B) put(o, PINK, hlA);
      else if (c === 4) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          cls[j - 1] !== 4 || cls[j + 1] !== 4 || cls[j - w] !== 4 || cls[j + w] !== 4;
        if (edge) put(o, EDGE, edgeA); else put(o, GREEN, hlA);
      }
    }
  }
  ctx.putImageData(img, 0, 0);

  const bounds = L.latLngBounds(
    [yToLat(g.y0 + cy1 + 1, z), xToLon(g.x0 + cx0, z)],
    [yToLat(g.y0 + cy0, z), xToLon(g.x0 + cx1 + 1, z)]
  );
  const myRun = runId;
  canvas.toBlob((blob) => {
    if (myRun !== runId || !blob) return;
    const url = URL.createObjectURL(blob);
    const old = overlayUrl;
    overlayUrl = url;
    if (!overlay) {
      overlay = L.imageOverlay(url, bounds, { interactive: false, className: 'los-overlay' });
      losLayer.addLayer(overlay);
    } else {
      overlay.setUrl(url);
      overlay.setBounds(bounds);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
  });

  // The legend lists these next to each color, straight from the same pixel classes that
  // were just painted, so the numbers and the map always agree.
  lastStats = { dual: !!B, counts, pxArea: results[0].mpp ** 2 };
  lastPaint = { cls, w, h, cx0, cy0, z, g, dual: !!B };
  renderLegend();
  let msg = '';
  if (!B && counts.both / Math.max(1, counts.area) < 0.03) {
    msg = '<span class="muted">Tip: on a broad hilltop, drag the marker toward the edge that faces the area you want to reach, or raise the antenna.</span>';
  }
  if (g.failed) msg += `${msg ? ' ' : ''}<span class="warn-text">${g.failed} terrain tile(s) failed to load; results there are unreliable.</span>`;
  setStatus(msg);
}

function updateProfile() {
  const box = $('#profileBox');
  if (!last || state.mode !== 'dual' || last.results.length < 2) { box.hidden = true; return; }
  const [ra, rb] = last.results;
  const distM = distanceM(state.a, state.b);
  const prof = computeProfile(last.grid,
    { gx: ra.gx, gy: ra.gy, h: state.hA },
    { gx: rb.gx, gy: rb.gy, h: state.hB },
    { distM, k: state.k, freqMHz: state.freq });
  box.hidden = false;
  const brg = bearingDeg(state.a, state.b);
  $('#pathInfo').textContent = `${fmt.dist(distM)} · ${Math.round(brg)}° ${compassPoint(brg)}`;
  drawProfile($('#profileCanvas'), prof, fmt);

  const v = $('#verdict');
  v.className = `verdict ${prof.verdict}`;
  const pct = Math.max(0, Math.round(prof.minRatio * 100));
  if (prof.verdict === 'blocked') {
    v.innerHTML = `<span class="tag">Blocked.</span> Terrain cuts the direct path ${fmt.dist(prof.blockAt)} from A. Simplex A↔B will likely need a relay, more height, or a different spot.`;
  } else if (prof.verdict === 'marginal') {
    v.innerHTML = `<span class="tag">Line of sight, marginal.</span> The direct path clears terrain, but only ${pct}% of the first Fresnel zone is clear (60% is the usual target). Expect some signal loss.`;
  } else {
    v.innerHTML = `<span class="tag">Clear.</span> Direct line of sight with at least 60% of the first Fresnel zone clear at ${state.freq} MHz.`;
  }
  lastVerdict = v.textContent;
  lastProf = prof;
}

// Reverse-geocode a station's neighborhood/city, debounced so dragging doesn't spam the
// geocoder; results for a station that has since moved are dropped.
const labelTimers = {};
const labelLookups = { a: 0, b: 0 };
function lookupLabel(key, delay = 400) {
  const id = ++labelLookups[key];
  clearTimeout(labelTimers[key]);
  labelTimers[key] = setTimeout(async () => {
    const s = state[key];
    if (!s) return;
    let label = null;
    try { label = await reverseGeocode(s.lat, s.lon); } catch (err) { console.warn(err); }
    if (id !== labelLookups[key]) return;
    state.labels[key] = label || '';
    labelLookups[key] = 0; // done: no longer pending
    updateInfo();
    writeHash();
  }, delay);
  updateInfo();
}

function cancelLabelLookup(key) {
  clearTimeout(labelTimers[key]);
  labelLookups[key] = 0;
}

function updateInfo() {
  const ground = {};
  if (last) for (const r of last.results) ground[r.key] = r.ground;
  for (const key of ['a', 'b']) {
    const el = $(`#info${key.toUpperCase()}`);
    const s = state[key];
    const place = $(`#place${key.toUpperCase()}`);
    if (!s) {
      place.hidden = true;
      el.textContent = key === 'a' ? 'Click the map, search, or use your location.' : 'Choose B above, then click the map.';
      continue;
    }
    const pending = labelLookups[key] > 0;
    place.hidden = !pending && !state.labels[key];
    place.classList.toggle('pending', pending);
    place.textContent = pending ? 'Looking up place…' : state.labels[key];
    place.title = place.textContent;
    const g = ground[key] != null ? ` · ground ${fmt.elev(ground[key])}` : '';
    el.textContent = `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} · ${toMaidenhead(s.lat, s.lon)}${g}`;
  }
}

let lastStats = null; // { dual, counts: { area, both, a, b }, pxArea } from the last paint
let lastPaint = null; // { cls, w, h, cx0, cy0, z, g, dual }: per-pixel classes behind the overlay
let lastVerdict = ''; // A↔B path verdict text
let lastProf = null; // A↔B profile result (verdict, minRatio…)

// Area of n grid pixels, one decimal (so the rows visibly add up to the total).
function fmtArea(n, pxArea) {
  const m2 = n * pxArea;
  const v = state.units === 'us' ? m2 / (MI * MI) : m2 / 1e6;
  const unit = state.units === 'us' ? 'sq mi' : 'km²';
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}

// Share of the analyzed area; small shares keep a decimal so a real overlap never reads 0%.
function fmtPct(n, total) {
  if (!n) return '0%';
  const p = (100 * n) / Math.max(1, total);
  if (p < 0.1) return '<0.1%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function renderLegend() {
  const sw = (c, a = state.highlight, cls = '') => `<span class="sw ${cls}" style="background: rgba(${c[0]},${c[1]},${c[2]},${a})"></span>`;
  const side = state.highlight * SIDE_FACTOR;
  const clear = '<span class="sw"></span>';
  const ring = '<span class="sw ring"></span>';
  const dual = state.mode === 'dual';
  const st = lastStats && lastStats.dual === dual && last ? lastStats : null;
  const cell = (n) => (st ? `<span class="lg-area">${fmtArea(n, st.pxArea)}</span><span class="lg-pct">${fmtPct(n, st.counts.area)}</span>` : '<span></span><span></span>');
  const row = (swatch, label, n, cls = '') => `<div class="lg-row ${cls}">${swatch}<span>${label}</span>${n == null ? '<span></span><span></span>' : cell(n)}</div>`;
  const c = st ? st.counts : { area: 0, both: 0, a: 0, b: 0 };
  let rows;
  if (dual) {
    rows = row(sw(GREEN, state.highlight, 'edged'), '<strong>Seen by both A and B</strong>', c.both, 'lg-both')
      + row(sw(ONLY_A, side), 'Seen by A only', c.a)
      + row(sw(ONLY_B, side), 'Seen by B only', c.b)
      + row(clear, 'Seen by neither (plain map)', c.area - c.both - c.a - c.b);
  } else {
    rows = row(sw(PINK), '<strong>In line of sight</strong>', c.both, 'lg-los')
      + row(clear, 'Not in line of sight (plain map)', c.area - c.both);
  }
  const total = st
    ? `<div class="lg-row lg-total"><span></span><span>Total analyzed</span>${cell(c.area)}</div>
       <div class="lg-note">Everything within ${fmt.dist(state.radius)} of ${dual ? 'A or B' : 'your station'}. The rows add up to the total.</div>`
    : '';
  $('#kmzBtn').disabled = !st;
  $('#legend').innerHTML = rows + total + `<div class="lg-row lg-ring">${ring}<span>Analysis range</span><span></span><span></span></div>`;
}

// ---------- Relay sites (repeater / Meshtastic) ----------
// relay = { key, hops (1|2), routes: [{ relays: [{x, y, lat, lon, ground}], legs, totalM, moved }], selected }
let relay = null;
let relaySearching = false;

function relayKey() {
  if (!last || last.results.length < 2) return '';
  const r = (v) => v.toFixed(5);
  return [r(state.a.lat), r(state.a.lon), r(state.b.lat), r(state.b.lon), state.hA, state.hB, state.hR,
    state.radius, state.k, last.grid.key].join('|');
}

const cellToLatLng = (x, y) => ({ lat: yToLat(last.grid.y0 + y + 0.5, last.z), lon: xToLon(last.grid.x0 + x + 0.5, last.z) });

// Check every leg of a route with the same terrain profile as the A→B chart.
function evaluateRoute(route) {
  const g = last.grid;
  const [ra, rb] = last.results;
  const pts = [
    { name: 'A', gx: ra.gx, gy: ra.gy, h: state.hA, lat: state.a.lat, lon: state.a.lon },
    ...route.relays.map((p) => ({ name: p.name, gx: p.x, gy: p.y, h: state.hR, lat: p.lat, lon: p.lon })),
    { name: 'B', gx: rb.gx, gy: rb.gy, h: state.hB, lat: state.b.lat, lon: state.b.lon },
  ];
  route.legs = [];
  route.totalM = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const distM = distanceM(p, q);
    const prof = computeProfile(g, p, q, { distM, k: state.k, freqMHz: state.freq });
    route.legs.push({ from: p.name, to: q.name, distM, verdict: prof.verdict, fresnel: Math.max(0, Math.round(prof.minRatio * 100)) });
    route.totalM += distM;
  }
  route.ok = route.legs.every((l) => l.verdict !== 'blocked');
  return route;
}

function updateRelayBox() {
  const show = state.mode === 'dual' && !!last && last.results.length === 2;
  $('#relayBox').hidden = !show;
  $('#relayBtn').disabled = !show || relaySearching;
}

function relayMsg(html, kind = 'info') {
  const el = $('#relayMsg');
  el.hidden = !html;
  el.className = `search-msg ${kind}`;
  el.innerHTML = html;
}

function clearRelays(message) {
  relay = null;
  relayLayer.clearLayers();
  $('#relayList').innerHTML = '';
  relayMsg(message || '', 'info');
}

async function runRelaySearch() {
  if (!last || last.results.length < 2 || relaySearching) return;
  relaySearching = true;
  updateRelayBox();
  relayLayer.clearLayers();
  $('#relayList').innerHTML = '';
  relayMsg('Searching for relay sites…', 'info');
  const key = relayKey();
  const [ra, rb] = last.results;
  try {
    const found = await findRelays(last.grid, {
      a: { gx: ra.gx, gy: ra.gy, h: state.hA },
      b: { gx: rb.gx, gy: rb.gy, h: state.hB },
      hR: state.hR, radiusPx: ra.radiusPx, mpp: ra.mpp, k: state.k, maxRoutes: 12,
    }, (done, total) => relayMsg(`No single relay site works, so checking two-relay routes: ${done} of ${total} candidate sites…`, 'info'));
    if (key !== relayKey()) return; // stations moved while searching
    // Keep the shortest routes whose legs also pass the profile check (grazing paths can differ).
    const routes = [];
    for (const r of found.routes) {
      r.relays = r.relays.map((p, i) => ({ ...p, ...cellToLatLng(p.x, p.y), ground: last.grid.elev[p.y * last.grid.W + p.x], idx: i }));
      if (evaluateRoute(r).ok) routes.push(r);
      if (routes.length === 3) break;
    }
    if (!routes.length) {
      relayMsg(`<strong>No relay site found</strong> within ${escapeHtml(fmt.dist(state.radius))} of both stations with a ${escapeHtml(fmt.height(state.hR))} relay antenna. Try a taller relay antenna or a bigger range.`, 'error');
      return;
    }
    relay = { key, hops: found.hops, routes, selected: 0 };
    nameRelays();
    routes.forEach(evaluateRoute); // again, so the legs carry the final pin names
    const direct = lastProf ? lastProf.verdict : '';
    const intro = direct === 'clear'
      ? 'A and B already have a clear direct path, so a relay isn’t required. These would still work:'
      : direct === 'marginal'
        ? 'The direct A↔B path is marginal. A relay here would give solid line of sight:'
        : found.hops === 1
          ? 'The direct path is blocked, but <strong>one relay</strong> can link A and B:'
          : 'No single site sees both stations, so these routes use <strong>two relays</strong>:';
    relayMsg(`${intro} <span class="muted">Shortest route first. Drag a purple pin to fine-tune; each hop is rechecked.</span>`, direct === 'clear' ? 'info' : 'warn');
    renderRelays(true);
  } catch (err) {
    console.error(err);
    relayMsg(`<strong>Relay search failed.</strong> ${escapeHtml(err.message)}`, 'error');
  } finally {
    relaySearching = false;
    updateRelayBox();
  }
}

// Option n → pins "n" (one relay) or "na"/"nb" (two relays, a nearer A).
function nameRelays() {
  relay.routes.forEach((r, i) => r.relays.forEach((p, j) => { p.name = r.relays.length === 1 ? `${i + 1}` : `${i + 1}${'ab'[j]}`; }));
}

function relayIcon(name, selected) {
  return L.divIcon({
    className: '',
    html: `<div class="relay-marker${selected ? ' sel' : ''}"><span>${name}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function relayPopup(route, p) {
  const legs = route.legs.filter((l) => l.from === p.name || l.to === p.name)
    .map((l) => `${escapeHtml(l.from)} → ${escapeHtml(l.to)}: ${escapeHtml(fmt.dist(l.distM))}, ${l.verdict}`).join('<br>');
  return `<div class="relay-pop"><strong>Relay ${escapeHtml(p.name)}</strong><br>
    <span class="mono">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span><br>
    Ground ${escapeHtml(fmt.elev(p.ground))} · antenna ${escapeHtml(fmt.height(state.hR))}<br>${legs}<br>
    <button type="button" class="btn relay-copy">Copy lat, long</button></div>`;
}

function renderRelays(fit = false) {
  relayLayer.clearLayers();
  if (!relay) return;
  relay.routes.forEach((route, i) => {
    const sel = i === relay.selected;
    const lls = [[state.a.lat, state.a.lon], ...route.relays.map((p) => [p.lat, p.lon]), [state.b.lat, state.b.lon]];
    if (sel) L.polyline(lls, { color: '#fff', weight: 7, opacity: 0.8, interactive: false }).addTo(relayLayer);
    L.polyline(lls, { color: RELAY_COLOR, weight: sel ? 4 : 2, opacity: sel ? 1 : 0.55, dashArray: sel ? '10 6' : '4 6', interactive: false }).addTo(relayLayer);
    for (const p of route.relays) {
      const m = L.marker([p.lat, p.lon], { icon: relayIcon(p.name, sel), draggable: true, zIndexOffset: sel ? 900 : 500, title: `Relay ${p.name} (drag to adjust)` })
        .bindPopup(() => relayPopup(route, p))
        .on('popupopen', (e) => {
          const btn = e.popup.getElement().querySelector('.relay-copy');
          if (btn) btn.onclick = () => copyCoords(L.latLng(p.lat, p.lon));
        })
        .on('dragend', (e) => moveRelay(route, p, e.target.getLatLng().wrap()))
        .on('click', () => { if (relay.selected !== i) selectRelayRoute(i); })
        .addTo(relayLayer);
      if (sel) m.setZIndexOffset(1000);
    }
  });
  renderRelayList();
  if (fit) {
    const r = relay.routes[relay.selected];
    map.fitBounds(L.latLngBounds([[state.a.lat, state.a.lon], [state.b.lat, state.b.lon], ...r.relays.map((p) => [p.lat, p.lon])]), viewPadding());
  }
}

function selectRelayRoute(i) {
  relay.selected = i;
  renderRelays(true);
}

function moveRelay(route, p, ll) {
  const g = last.grid;
  const x = Math.floor(lonToX(ll.lng, last.z) - g.x0), y = Math.floor(latToY(ll.lat, last.z) - g.y0);
  if (x < 1 || y < 1 || x >= g.W - 1 || y >= g.H - 1) {
    relayMsg('That spot is outside the loaded terrain. Keep relays within the range circles.', 'error');
    renderRelays();
    return;
  }
  Object.assign(p, { x, y, lat: ll.lat, lon: ll.lng, ground: g.elev[y * g.W + x] });
  route.moved = true;
  evaluateRoute(route);
  renderRelays();
}

function renderRelayList() {
  const tag = (v) => `<span class="v ${v}">${v === 'clear' ? 'clear' : v === 'marginal' ? 'marginal' : 'blocked'}</span>`;
  $('#relayList').innerHTML = relay.routes.map((r, i) => {
    const n = r.relays.length;
    const legs = r.legs.map((l) => `${escapeHtml(l.from)} → ${escapeHtml(l.to)} ${escapeHtml(fmt.dist(l.distM))} ${tag(l.verdict)}`).join('<br>');
    const coords = r.relays.map((p) => `<div class="ro-coord"><span class="rbadge">${p.name}</span><span class="mono">${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</span><button type="button" class="btn ro-copy" data-lat="${p.lat}" data-lon="${p.lon}">Copy</button></div>`).join('');
    return `<div class="relay-opt${i === relay.selected ? ' on' : ''}${r.ok ? '' : ' bad'}" data-i="${i}" role="button" tabindex="0">
      <div class="ro-head"><strong>Option ${i + 1}</strong> · ${n} relay${n > 1 ? 's' : ''} · ${escapeHtml(fmt.dist(r.totalM))} total${r.moved ? ' <span class="muted">(adjusted)</span>' : ''}</div>
      <div class="ro-legs">${legs}</div>${coords}
    </div>`;
  }).join('');
}

// ---------- KMZ export (Google Earth) ----------
// One PNG per coverage class, reprojected from Web Mercator rows to the equal-angle
// latitude rows a KML LatLonBox expects (otherwise the shading drifts north/south).
function classLayerCanvas(p, bounds, match, color, outline = false) {
  const { cls, w, h, cx0, cy0, z, g } = p;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const img = x.createImageData(w, h);
  const d = img.data;
  const y0 = g.y0 + cy0;
  let any = false;
  for (let j = 0; j < h; j++) {
    const lat = bounds.north - ((bounds.north - bounds.south) * (j + 0.5)) / h;
    const sy = Math.min(h - 1, Math.max(0, Math.floor(latToY(lat, z) - y0)));
    const row = sy * w;
    for (let i = 0; i < w; i++) {
      const k = row + i;
      if (!match(cls[k])) continue;
      any = true;
      let col = color;
      if (outline) {
        const edge = i === 0 || sy === 0 || i === w - 1 || sy === h - 1 ||
          !match(cls[k - 1]) || !match(cls[k + 1]) || !match(cls[k - w]) || !match(cls[k + w]);
        if (edge) col = EDGE;
      }
      const o = (j * w + i) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return any ? c : null;
}

const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

async function exportKmz() {
  if (!last || !lastPaint || !lastStats) return;
  const btn = $('#kmzBtn');
  const label = btn.querySelector('.export-label');
  btn.disabled = true;
  const oldText = label.textContent;
  label.textContent = 'Building KMZ…';
  try {
    const p = lastPaint;
    const { z, g, cx0, cy0, w, h } = p;
    const bounds = {
      north: yToLat(g.y0 + cy0, z), south: yToLat(g.y0 + cy0 + h, z),
      west: xToLon(g.x0 + cx0, z), east: xToLon(g.x0 + cx0 + w, z),
    };
    const st = lastStats, c = st.counts;
    const areaTxt = (n) => `${fmtArea(n, st.pxArea)}, ${fmtPct(n, c.area)}`;
    // Same look as the app: coverage highlighted, "not covered" layers included but off.
    const hl = state.highlight, side = hl * SIDE_FACTOR;
    const defs = p.dual
      ? [
        { name: 'Seen by both A and B', n: c.both, match: (v) => v === 4, color: GREEN, alpha: hl, outline: true, order: 4, file: 'both' },
        { name: 'Seen by A only', n: c.a, match: (v) => v === 2, color: ONLY_A, alpha: side, order: 3, file: 'a-only' },
        { name: 'Seen by B only', n: c.b, match: (v) => v === 3, color: ONLY_B, alpha: side, order: 2, file: 'b-only' },
        { name: 'Seen by neither (gray, optional)', n: c.area - c.both - c.a - c.b, match: (v) => v === 1, color: GRAY, alpha: 0.35, order: 1, file: 'neither', hidden: true },
      ]
      : [
        { name: 'In line of sight', n: c.both, match: (v) => v === 4, color: PINK, alpha: hl, order: 2, file: 'visible' },
        { name: 'Not in line of sight (gray, optional)', n: c.area - c.both, match: (v) => v === 1, color: GRAY, alpha: 0.35, order: 1, file: 'not-visible', hidden: true },
      ];
    const layers = [];
    for (const dfn of defs) {
      const canvas = classLayerCanvas(p, bounds, dfn.match, dfn.color, dfn.outline);
      if (!canvas) continue;
      layers.push({
        name: `${dfn.name} (${areaTxt(dfn.n)})`,
        file: `files/${dfn.file}.png`,
        png: await canvasBytes(canvas),
        alpha: dfn.alpha,
        visible: !dfn.hidden,
        drawOrder: dfn.order,
        description: `${escapeHtml(dfn.name)}: ${escapeHtml(areaTxt(dfn.n))} of the ${escapeHtml(fmtArea(c.area, st.pxArea))} analyzed.`,
      });
    }

    const keys = p.dual ? ['a', 'b'] : ['a'];
    const hts = { a: state.hA, b: state.hB };
    const ground = {};
    for (const r of last.results) ground[r.key] = r.ground;
    const stations = [];
    for (const key of keys) {
      const s = state[key];
      const K = key.toUpperCase();
      const title = p.dual ? `Station ${K}` : 'Your station';
      stations.push({
        key,
        name: `${K}: ${state.labels[key] || `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`}`,
        lat: s.lat, lon: s.lon,
        icon: await pinIcon(K, key === 'a' ? '#2b78ff' : '#ff9614'),
        description: `<b>${escapeHtml(title)}</b><br>${escapeHtml(state.labels[key] || '')}<br>
          ${s.lat.toFixed(6)}, ${s.lon.toFixed(6)} · ${toMaidenhead(s.lat, s.lon)}<br>
          Ground ${escapeHtml(fmt.elev(ground[key] ?? 0))} · antenna ${escapeHtml(fmt.height(hts[key]))}`,
      });
    }
    const circles = keys.map((key) => ({
      name: `Range around ${key.toUpperCase()} (${fmt.dist(state.radius)})`,
      coords: circleCoords(state[key].lat, state[key].lon, state.radius),
      color: key === 'a' ? [43, 120, 255] : [255, 150, 20],
    }));
    const path = p.dual ? {
      name: `Path A → B (${fmt.dist(distanceM(state.a, state.b))})`,
      coords: `${state.a.lon},${state.a.lat},0 ${state.b.lon},${state.b.lat},0`,
      color: [255, 255, 255],
      description: escapeHtml(lastVerdict),
    } : null;

    const title = p.dual
      ? `Line of Sight: ${state.labels.a || 'A'} & ${state.labels.b || 'B'}`
      : `Line of Sight: ${state.labels.a || 'station'}`;
    const kLabel = state.k > 1.2 ? 'radio (4/3 Earth)' : state.k > 0 ? 'optical (true Earth)' : 'ignored (flat)';
    const description = `
      <p>Line-of-sight coverage from <a href="${escapeHtml(location.href)}">Line of Sight</a>, exported ${escapeHtml(new Date().toLocaleString())}.</p>
      <table>
        <tr><td>Range analyzed</td><td>${escapeHtml(fmt.dist(state.radius))}${p.dual ? ' around A and around B' : ''}</td></tr>
        <tr><td>Antenna A</td><td>${escapeHtml(fmt.height(state.hA))}</td></tr>
        ${p.dual ? `<tr><td>Antenna B</td><td>${escapeHtml(fmt.height(state.hB))}</td></tr>` : ''}
        <tr><td>Other radio's antenna</td><td>${escapeHtml(fmt.height(state.hT))}</td></tr>
        <tr><td>Earth curvature</td><td>${escapeHtml(kLabel)}</td></tr>
        <tr><td>Total analyzed</td><td>${escapeHtml(fmtArea(c.area, st.pxArea))}</td></tr>
      </table>
      <p>Terrain only (AWS Terrain Tiles elevation). Trees and buildings are not modeled.</p>
      <p><a href="${escapeHtml(location.href)}">Open this analysis in Line of Sight</a></p>`;
    const center = p.dual
      ? { lat: (state.a.lat + state.b.lat) / 2, lon: (state.a.lon + state.b.lon) / 2 }
      : state.a;
    const span = state.radius * 2 + (p.dual ? distanceM(state.a, state.b) : 0);

    // Relay sites, if a search was run for exactly these stations and settings.
    let relays = null;
    if (p.dual && relay && relay.key === relayKey()) {
      relays = {
        icon: await pinIcon('R', RELAY_COLOR),
        routes: relay.routes.map((r, i) => {
          const legs = r.legs.map((l) => `${escapeHtml(l.from)} → ${escapeHtml(l.to)}: ${escapeHtml(fmt.dist(l.distM))}, ${l.verdict}`).join('<br>');
          return {
            name: `Option ${i + 1}: ${r.relays.length} relay${r.relays.length > 1 ? 's' : ''}, ${fmt.dist(r.totalM)} total`,
            description: `${legs}<br>Relay antenna ${escapeHtml(fmt.height(state.hR))} · checked at ${state.freq} MHz`,
            visible: i === relay.selected,
            coords: [state.a, ...r.relays, state.b].map((q) => `${q.lon.toFixed(6)},${q.lat.toFixed(6)},0`).join(' '),
            pins: r.relays.map((q) => ({
              name: `Relay ${q.name}`, lat: q.lat, lon: q.lon,
              description: `${q.lat.toFixed(6)}, ${q.lon.toFixed(6)}<br>Ground ${escapeHtml(fmt.elev(q.ground))} · antenna ${escapeHtml(fmt.height(state.hR))}`,
            })),
          };
        }),
      };
    }

    const blob = buildKmz({
      name: title, description,
      lookAt: { lat: center.lat, lon: center.lon, range: span * 1.4 },
      bounds, layers, stations, circles, path, relays,
    });
    const date = new Date().toISOString().slice(0, 10);
    const namePart = keys.map((k) => slug(state.labels[k]) || k).join('_');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `line-of-sight_${namePart}_${date}.kmz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showToast(`${a.download}`, true, 'KMZ downloaded');
  } catch (err) {
    console.error(err);
    showToast(`Export failed: ${err.message}`, false, 'KMZ export failed');
  } finally {
    btn.disabled = false;
    label.textContent = oldText;
  }
}

// ---------- UI wiring ----------
function $(sel) { return document.querySelector(sel); }

// Message right under the search box (errors must be seen without scrolling). Empty hides it.
function searchMsg(html, kind = 'info') {
  const el = $('#searchMsg');
  el.hidden = !html;
  el.className = `search-msg ${kind}`;
  el.innerHTML = html;
}

function setStatus(html, isError = false) {
  const el = $('#status');
  el.innerHTML = html;
  el.classList.toggle('error', isError);
}

let debounceTimer = null;
function recomputeSoon(ms = 120) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(recompute, ms);
}

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('dual', mode === 'dual');
  for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('#titleA').textContent = mode === 'dual' ? 'Station A' : 'Your station';
  if (mode === 'dual' && state.a && !state.b) setTarget('b');
  if (mode !== 'dual') clearRelays('');
  syncMapObjects();
  writeHash();
  recompute();
}

function setTarget(t) {
  state.target = t;
  for (const b of document.querySelectorAll('#targetSeg button')) b.setAttribute('aria-checked', String(b.dataset.target === t));
}

// Height controls: number input + slider + preset chips, all in display units.
const heightCtls = {};
function buildHeightControls() {
  for (const el of document.querySelectorAll('.height-ctl')) {
    const key = el.dataset.key;
    el.innerHTML = `
      <div class="h-top">
        <label for="${key}Num" class="lbl">${el.dataset.label}</label>
        <span class="h-num"><input id="${key}Num" type="number" min="0" max="3000" step="any" inputmode="decimal"><span class="unit"></span></span>
      </div>
      ${el.dataset.hint ? `<div class="hint">${el.dataset.hint}</div>` : ''}
      <input type="range" min="0" step="1" aria-label="${el.dataset.label}">
      <div class="presets"></div>`;
    const num = el.querySelector('input[type=number]');
    const range = el.querySelector('input[type=range]');
    const set = (disp) => {
      const v = Math.max(0, Number(disp) || 0);
      state[key] = v * heightUnit();
      syncHeight(key);
      writeHash();
      recomputeSoon();
    };
    num.addEventListener('change', () => set(num.value));
    range.addEventListener('input', () => set(range.value));
    el.querySelector('.presets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) set(b.dataset.v);
    });
    heightCtls[key] = { el, num, range };
  }
}

function syncHeight(key) {
  const { el, num, range } = heightCtls[key];
  const disp = +(state[key] / heightUnit()).toFixed(1);
  if (document.activeElement !== num) num.value = disp;
  range.max = SLIDER_MAX[state.units];
  range.step = state.units === 'us' ? 1 : 0.5;
  range.value = Math.min(disp, SLIDER_MAX[state.units]);
  el.querySelector('.unit').textContent = state.units === 'us' ? 'ft' : 'm';
  el.querySelector('.presets').innerHTML = PRESETS[state.units]
    .map(([v, name]) => `<button type="button" data-v="${v}" class="${Math.abs(v - disp) < 0.05 ? 'on' : ''}">${name}${v ? ` ${v}` : ''}</button>`)
    .join('');
}

function buildRadiusOptions() {
  const sel = $('#radiusSel');
  const u = radiusUnit();
  const label = state.units === 'us' ? 'mi' : 'km';
  const opts = RADII[state.units];
  // snap current radius to the nearest option in these units
  let best = opts[0];
  for (const o of opts) if (Math.abs(o * u - state.radius) < Math.abs(best * u - state.radius)) best = o;
  state.radius = best * u;
  sel.innerHTML = opts.map((o) => `<option value="${o}" ${o === best ? 'selected' : ''}>${o} ${label}</option>`).join('');
}

function syncAllControls() {
  for (const k of Object.keys(heightCtls)) syncHeight(k);
  buildRadiusOptions();
  $('#kSel').value = [...$('#kSel').options].reduce((a, o) => (Math.abs(+o.value - state.k) < Math.abs(+a - state.k) ? o.value : a), '1.3333333');
  $('#freqIn').value = state.freq;
  $('#unitsSel').value = state.units;
  $('#opacityIn').value = state.highlight;
}

let opacityTimer = 0;
function wireControls() {
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.mode !== state.mode) setMode(b.dataset.mode);
  });
  $('#targetSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setTarget(b.dataset.target);
  });
  $('#radiusSel').addEventListener('change', (e) => {
    state.radius = +e.target.value * radiusUnit();
    syncMapObjects();
    writeHash();
    recompute();
  });
  $('#kSel').addEventListener('change', (e) => { state.k = +e.target.value; writeHash(); recompute(); });
  $('#freqIn').addEventListener('change', (e) => {
    const f = +e.target.value;
    if (f > 0) {
      state.freq = f;
      writeHash();
      updateProfile();
      if (relay) { relay.routes.forEach(evaluateRoute); renderRelays(); }
    }
  });
  $('#unitsSel').addEventListener('change', (e) => {
    state.units = e.target.value;
    syncAllControls();
    syncMapObjects();
    writeHash();
    recompute();
  });
  $('#opacityIn').addEventListener('input', (e) => {
    state.highlight = +e.target.value;
    // Alpha is baked into the overlay pixels (colors differ per class); repaint, throttled.
    if (!opacityTimer) opacityTimer = setTimeout(() => { opacityTimer = 0; renderOverlay(); }, 40);
    renderLegend();
    writeHash();
  });

  $('#kmzBtn').addEventListener('click', exportKmz);
  $('#relayBtn').addEventListener('click', runRelaySearch);
  $('#meshBtn').addEventListener('click', () => {
    state.freq = 915;
    $('#freqIn').value = state.freq;
    writeHash();
    updateProfile();
    if (relay) { relay.routes.forEach(evaluateRoute); renderRelays(); }
    relayMsg('Frequency set to 915 MHz (US Meshtastic) for the hop and A→B checks. Change it under More settings.', 'info');
  });
  $('#relayList').addEventListener('click', (e) => {
    const copy = e.target.closest('.ro-copy');
    if (copy) { copyCoords(L.latLng(+copy.dataset.lat, +copy.dataset.lon)); return; }
    const opt = e.target.closest('.relay-opt');
    if (opt && relay) selectRelayRoute(+opt.dataset.i);
  });
  $('#relayList').addEventListener('keydown', (e) => {
    const opt = e.target.closest('.relay-opt');
    if (opt && relay && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectRelayRoute(+opt.dataset.i); }
  });

  $('#panelToggle').addEventListener('click', () => {
    const panel = $('#panel');
    const collapsed = panel.classList.toggle('collapsed');
    $('#panelToggle').setAttribute('aria-expanded', String(!collapsed));
    $('#panelToggle').setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
  });

  // Keep map clicks/scrolls from leaking through the panel
  L.DomEvent.disableClickPropagation($('#panel'));
  L.DomEvent.disableScrollPropagation($('#panel'));

  $('#searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    const key = state.mode === 'dual' ? state.target : 'a';
    const list = $('#searchResults');
    list.hidden = true;
    const direct = parseLatLon(q) || fromMaidenhead(q);
    if (direct) { searchMsg(''); placeStation(key, direct.lat, direct.lon, { fit: true }); return; }

    // Prefer matches near what the user is looking at, once they've zoomed in to a region.
    const c = map.getCenter().wrap();
    const near = map.getZoom() >= 7 ? { lat: c.lat, lon: c.lng } : null;
    const btn = $('#searchForm button[type=submit]');
    btn.disabled = true;
    searchMsg('Searching…', 'info');
    try {
      const { results, note } = await searchPlaces(q, { near });
      if (!results.length) {
        searchMsg(`<strong>No match for “${escapeHtml(q)}”.</strong> Check the spelling, add the city and state (e.g. “123 Main St, Golden, CO”), or click the map instead.`, 'error');
        return;
      }
      const pick = (h) => placeStation(key, h.lat, h.lon, { fit: true, label: h.label });
      pick(results[0]);
      searchMsg(note ? escapeHtml(note) : '', 'warn');
      if (results.length > 1) {
        list.innerHTML =
          `<li class="results-head">Not the right place? Other matches:</li>` +
          results.map((h, i) => `<li><button type="button" data-i="${i}" class="${i === 0 ? 'on' : ''}">${escapeHtml(h.label)}<span>${escapeHtml(h.name)}</span></button></li>`).join('');
        list.hidden = false;
        list.onclick = (ev) => {
          const b = ev.target.closest('button');
          if (!b) return;
          pick(results[+b.dataset.i]);
          for (const o of list.querySelectorAll('button')) o.classList.toggle('on', o === b);
          searchMsg('');
        };
      }
    } catch (err) {
      searchMsg(`<strong>Search failed.</strong> ${escapeHtml(err.message)}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  $('#searchInput').addEventListener('input', () => { if ($('#searchMsg').classList.contains('error')) searchMsg(''); });

  $('#locateBtn').addEventListener('click', () => {
    if (!navigator.geolocation) { searchMsg('This browser can’t share its location.', 'error'); return; }
    searchMsg('Finding your location…', 'info');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const key = state.mode === 'dual' ? state.target : 'a';
        searchMsg('');
        placeStation(key, pos.coords.latitude, pos.coords.longitude, { fit: true });
      },
      (err) => searchMsg(`<strong>Location unavailable.</strong> ${escapeHtml(err.message)}. Check that location access is allowed for this site.`, 'error'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });

  // On phones the panel is a bottom sheet; keep Leaflet's bottom controls above it.
  new ResizeObserver(() => {
    const sheet = window.innerWidth <= 700 ? $('#panel').offsetHeight : 0;
    document.documentElement.style.setProperty('--sheet-h', `${sheet}px`);
    updateCrosshair();
  }).observe($('#panel'));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateProfile, 150);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Start ----------
readHash();
buildHeightControls();
wireControls();
syncAllControls();
setTarget(state.target);
document.body.classList.toggle('dual', state.mode === 'dual');
for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-checked', String(b.dataset.mode === state.mode));
$('#titleA').textContent = state.mode === 'dual' ? 'Station A' : 'Your station';
map.setView([39.5, -98.35], 4);
for (const key of ['a', 'b']) if (state[key] && !state.labels[key]) lookupLabel(key, 0);
if (state.a || state.b) {
  syncMapObjects();
  fitStations();
}
renderLegend();
recompute();
