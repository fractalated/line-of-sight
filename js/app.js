// Line of Sight — UI, map, and the recompute pipeline.
// Flow: stations/radius -> choose DEM zoom + tile range -> load elevation grid
// -> viewshed per station -> paint shading canvas -> Leaflet image overlay.

import {
  lonToX, latToY, xToLon, yToLat, metersPerPixel, distanceM, bearingDeg,
  compassPoint, toMaidenhead, fromMaidenhead, parseLatLon, searchPlaces, reverseGeocode,
} from './geo.js';
import { loadElevationGrid } from './terrain.js';
import { computeViewshed, VISIBLE } from './viewshed.js';
import { computeProfile, drawProfile } from './profile.js';

const L = window.L;
const FT = 0.3048, MI = 1609.344, KM = 1000;
const MAX_GRID = 2048; // max analysis size in DEM pixels
const MAX_Z = 14, MIN_Z = 4;

const SHADES = { dark: [20, 24, 40], red: [215, 28, 28], purple: [115, 30, 170] };
const ONLY_A = [43, 120, 255];
const ONLY_B = [255, 150, 20];
// Two-station overlap: hot pink with a white outline, drawn at a fixed strength so it
// stands out no matter how the shade-strength slider is set.
const BOTH = [255, 20, 147];
const BOTH_EDGE = [255, 255, 255];
const BOTH_ALPHA = 0.6;
const BOTH_EDGE_ALPHA = 0.85;
const RADII = { us: [1, 2, 3, 5, 10, 15, 20, 30, 40, 60], metric: [2, 3, 5, 10, 15, 25, 35, 50, 65, 100] };
const PRESETS = {
  us: [[0, 'On the dirt'], [5, 'Handheld'], [30, 'Mast'], [100, 'Tower']],
  metric: [[0, 'On the dirt'], [1.5, 'Handheld'], [10, 'Mast'], [30, 'Tower']],
};
const SLIDER_MAX = { us: 500, metric: 150 };
const DEFAULT_H = 5 * FT;

const state = {
  mode: 'single', // 'single' | 'dual'
  a: null, // { lat, lon }
  b: null,
  // Antenna heights above ground, meters. "Ground level" means a person standing
  // with a handheld (5 ft): at a literal 0 ft, DEM bumps a few meters away block nearly everything.
  hA: DEFAULT_H, hB: DEFAULT_H, hT: DEFAULT_H,
  radius: 10 * MI, // meters
  k: 4 / 3,
  freq: 146.52, // MHz, national 2 m simplex calling frequency
  units: 'us',
  shade: 'dark',
  opacity: 0.3,
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
  state.radius = num('r', state.radius);
  state.k = num('k', state.k);
  state.freq = num('f', state.freq);
  if (p.get('u') === 'metric') state.units = 'metric';
  if (SHADES[p.get('s')]) state.shade = p.get('s');
  state.opacity = num('o', state.opacity);
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
  p.set('r', Math.round(state.radius));
  p.set('k', +state.k.toFixed(4));
  p.set('f', state.freq);
  p.set('u', state.units);
  p.set('s', state.shade);
  p.set('o', state.opacity);
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
map.getPane('labels').style.zIndex = 450; // above the shading, below markers
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

const savedBase = store.get('los.base');
(baseLayers[savedBase] || baseLayers['Satellite (Esri World Imagery)']).addTo(map);
if (store.get('los.labels') !== '0') placeLabels.addTo(map);
if (store.get('los.roads') === '1') roadLabels.addTo(map);
losLayer.addTo(map);

L.control.layers(baseLayers, {
  'Place names': placeLabels,
  'Roads': roadLabels,
  'Line-of-sight shading': losLayer,
}, { position: 'topright' }).addTo(map);

// On-map button to show/hide the shading (stays reachable when the panel is collapsed).
// Kept in sync with the layers menu, which has its own "Line-of-sight shading" checkbox.
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
    this._btn.title = on ? 'Hide line-of-sight shading' : 'Show line-of-sight shading';
    this._btn.querySelector('span').textContent = on ? 'Shading on' : 'Shading off';
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
function showToast(text, ok) {
  const el = $('#toast');
  el.className = `toast show ${ok ? 'ok' : 'fail'}`;
  el.innerHTML = ok
    ? `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
       <div><div class="toast-title">Copied to clipboard</div><div class="toast-coords">${text}</div></div>`
    : `<div><div class="toast-title">Couldn't copy automatically. Select and copy:</div><div class="toast-coords selectable">${text}</div></div>`;
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
  const shade = SHADES[state.shade];
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

  // Pass 2: paint. Shading uses the strength slider; the two-station overlap is always bold.
  const shadeA = Math.round(state.opacity * 255);
  const bothA = Math.round(BOTH_ALPHA * 255);
  const edgeA = Math.round(BOTH_EDGE_ALPHA * 255);
  const put = (o, c, a) => { d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = a; };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x, c = cls[j], o = j * 4;
      if (c === 1) put(o, shade, shadeA);
      else if (c === 2) put(o, ONLY_A, shadeA);
      else if (c === 3) put(o, ONLY_B, shadeA);
      else if (c === 4 && B) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          cls[j - 1] !== 4 || cls[j + 1] !== 4 || cls[j - w] !== 4 || cls[j + w] !== 4;
        if (edge) put(o, BOTH_EDGE, edgeA); else put(o, BOTH, bothA);
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

  const pct = (n) => `${Math.round((100 * n) / Math.max(1, counts.area))}%`;
  const within = `within ${fmt.dist(state.radius)}`;
  let msg;
  if (!B) msg = `<strong>${pct(counts.both)}</strong> of the area ${within} is in line of sight.`;
  else msg = `<span class="both-text">Seen by both: <strong>${pct(counts.both)}</strong></span> · A only ${pct(counts.a)} · B only ${pct(counts.b)} (${within} of either).`;
  if (counts.both / Math.max(1, counts.area) < 0.03) {
    msg += ' <span class="muted">Tip: on a broad hilltop, drag the marker toward the edge that faces the area you want to reach, or raise the antenna.</span>';
  }
  if (g.failed) msg += ` <span class="warn-text">${g.failed} terrain tile(s) failed to load; results there are unreliable.</span>`;
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

function renderLegend() {
  const sh = SHADES[state.shade];
  const sw = (c, a = state.opacity) => `<span class="sw" style="background: rgba(${c[0]},${c[1]},${c[2]},${a})"></span>`;
  const clear = '<span class="sw"></span>';
  const ring = '<span class="sw ring"></span>';
  const el = $('#legend');
  if (state.mode === 'dual') {
    el.innerHTML = `
      <div>${sw(BOTH, BOTH_ALPHA).replace('class="sw"', 'class="sw both"')} <strong>Seen by both A and B</strong></div>
      <div>${sw(ONLY_A)} Seen by A only</div>
      <div>${sw(ONLY_B)} Seen by B only</div>
      <div>${sw(sh)} Seen by neither</div>
      <div>${ring} Analysis range</div>`;
  } else {
    el.innerHTML = `
      <div>${clear} Unshaded: in line of sight</div>
      <div>${sw(sh)} Not in line of sight</div>
      <div>${ring} Analysis range</div>`;
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
  $('#shadeSel').value = state.shade;
  $('#opacityIn').value = state.opacity;
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
    if (f > 0) { state.freq = f; writeHash(); updateProfile(); }
  });
  $('#unitsSel').addEventListener('change', (e) => {
    state.units = e.target.value;
    syncAllControls();
    syncMapObjects();
    writeHash();
    recompute();
  });
  $('#shadeSel').addEventListener('change', (e) => {
    state.shade = e.target.value;
    writeHash();
    renderOverlay();
    renderLegend();
  });
  $('#opacityIn').addEventListener('input', (e) => {
    state.opacity = +e.target.value;
    // Alpha is baked into the overlay pixels so the overlap can stay bold; repaint, throttled.
    if (!opacityTimer) opacityTimer = setTimeout(() => { opacityTimer = 0; renderOverlay(); }, 40);
    renderLegend();
    writeHash();
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
