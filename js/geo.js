// Geographic helpers: Web Mercator pixel math, distances, Maidenhead grid
// squares, coordinate parsing and place-name geocoding.

export const EARTH_R = 6371008.8; // mean Earth radius, meters
const WEB_R = 6378137; // Web Mercator sphere radius, meters
const D2R = Math.PI / 180;
const MAX_LAT = 85.05112878;

const worldPx = (z) => 256 * Math.pow(2, z);

export const lonToX = (lon, z) => ((lon + 180) / 360) * worldPx(z);

export function latToY(lat, z) {
  const s = Math.sin(Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * D2R);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z);
}

export const xToLon = (x, z) => (x / worldPx(z)) * 360 - 180;

export function yToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / worldPx(z);
  return Math.atan(Math.sinh(n)) / D2R;
}

// Ground meters covered by one Web Mercator pixel at this latitude and zoom.
export const metersPerPixel = (lat, z) =>
  (Math.cos(lat * D2R) * 2 * Math.PI * WEB_R) / worldPx(z);

export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDeg(a, b) {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R, Δλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}

export function compassPoint(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(deg / 22.5) % 16];
}

// 6-character Maidenhead locator, e.g. DM79lr.
export function toMaidenhead(lat, lon) {
  const U = 'ABCDEFGHIJKLMNOPQR', l = 'abcdefghijklmnopqrstuvwx';
  let x = lon + 180, y = lat + 90;
  const f1 = Math.min(17, Math.floor(x / 20)), f2 = Math.min(17, Math.floor(y / 10));
  x -= f1 * 20; y -= f2 * 10;
  const s1 = Math.floor(x / 2), s2 = Math.floor(y);
  x -= s1 * 2; y -= s2;
  return U[f1] + U[f2] + s1 + s2 + l[Math.min(23, Math.floor(x * 12))] + l[Math.min(23, Math.floor(y * 24))];
}

// Center of a 4-, 6- or 8-character Maidenhead locator, or null.
export function fromMaidenhead(s) {
  const m = /^([A-R]{2})(\d{2})(?:([A-X]{2})(\d{2})?)?$/i.exec(s.trim());
  if (!m) return null;
  const F = m[1].toUpperCase();
  let lon = (F.charCodeAt(0) - 65) * 20 - 180;
  let lat = (F.charCodeAt(1) - 65) * 10 - 90;
  lon += +m[2][0] * 2; lat += +m[2][1];
  let w = 2, h = 1;
  if (m[3]) {
    const S = m[3].toLowerCase();
    w = 2 / 24; h = 1 / 24;
    lon += (S.charCodeAt(0) - 97) * w; lat += (S.charCodeAt(1) - 97) * h;
    if (m[4]) {
      w /= 10; h /= 10;
      lon += +m[4][0] * w; lat += +m[4][1] * h;
    }
  }
  return { lat: lat + h / 2, lon: lon + w / 2 };
}

// "39.74, -104.98", "39.74N 104.98W", "39.74° N, 104.98° W"
export function parseLatLon(s) {
  const m = /^\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,\s]\s*([-+]?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i.exec(s);
  if (!m) return null;
  let lat = parseFloat(m[1]), lon = parseFloat(m[3]);
  if (m[2] && m[2].toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4] && m[4].toUpperCase() === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ---------- Geocoding (Nominatim first, Photon as fallback) ----------
// Nominatim allows 1 request/second, so every Nominatim call goes through one queue.
let nominatimChain = Promise.resolve();
let lastNominatim = 0;
function nominatim(path) {
  const run = async () => {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    const r = await fetch(`https://nominatim.openstreetmap.org/${path}`);
    if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`);
    return r.json();
  };
  const p = nominatimChain.then(run, run);
  nominatimChain = p.catch(() => {});
  return p;
}

// OSM "suburb" usually holds a city's well-known neighborhood (Capitol Hill, Belltown);
// "neighbourhood" is often a smaller unit (a historic district), so it comes second.
const HOOD_KEYS = ['suburb', 'neighbourhood', 'quarter', 'hamlet', 'residential', 'city_district'];
const CITY_KEYS = ['city', 'town', 'village', 'municipality'];
const pick = (a, keys) => keys.map((k) => a[k]).find(Boolean);

// "CO" for US states (from ISO 3166-2 "US-CO"), otherwise the state/region name.
function region(a) {
  const iso = a['ISO3166-2-lvl4'];
  if (iso && iso.startsWith('US-')) return iso.slice(3);
  return a.state || a.country || '';
}

function join(parts) {
  const out = [];
  for (const p of parts) if (p && !out.includes(p)) out.push(p);
  return out.join(', ');
}

// Label for a searched place: the street address when there is one, else the place name.
function searchLabel(name, a) {
  const city = pick(a, CITY_KEYS);
  const locality = city || a.county;
  const st = region(a);
  if (a.house_number && a.road) {
    return join([`${a.house_number} ${a.road}`, locality, [st, a.postcode].filter(Boolean).join(' ')]);
  }
  if (a.road && !name) return join([a.road, locality, st]);
  return join([name, locality, st]);
}

// Label for a clicked point: neighborhood and city (county when rural).
function areaLabel(a) {
  const hood = pick(a, HOOD_KEYS);
  const city = pick(a, CITY_KEYS);
  if (hood && city) return join([hood, city]);
  const place = hood || city || a.county;
  return place ? join([place, region(a)]) : join([a.state, a.country]);
}

// Returns up to 5 matches as [{ name, label, lat, lon }].
export async function geocode(q) {
  const enc = encodeURIComponent(q);
  try {
    const j = await nominatim(`search?format=jsonv2&addressdetails=1&limit=5&q=${enc}`);
    return j.map((x) => ({
      name: x.display_name,
      label: searchLabel(x.name, x.address || {}) || x.display_name,
      lat: +x.lat,
      lon: +x.lon,
    }));
  } catch (err) {
    console.warn('Nominatim failed, trying Photon', err);
    const r = await fetch(`https://photon.komoot.io/api/?limit=5&q=${enc}`);
    if (!r.ok) throw new Error(`Photon HTTP ${r.status}`);
    const j = await r.json();
    return j.features.map((f) => {
      const p = f.properties;
      const a = { house_number: p.housenumber, road: p.street, city: p.city, county: p.county, state: p.state, postcode: p.postcode };
      return {
        name: [p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
        label: searchLabel(p.name, a),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
      };
    });
  }
}

// Neighborhood + city for a point, e.g. "Civic Center, Denver"; null if unknown.
export async function reverseGeocode(lat, lon) {
  try {
    const j = await nominatim(`reverse?format=jsonv2&addressdetails=1&zoom=16&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`);
    if (j.error || !j.address) return null;
    return areaLabel(j.address) || null;
  } catch (err) {
    console.warn('Nominatim reverse failed, trying Photon', err);
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}`);
    if (!r.ok) return null;
    const p = ((await r.json()).features[0] || {}).properties;
    if (!p) return null;
    return areaLabel({ neighbourhood: p.district || p.locality, city: p.city, county: p.county, state: p.state }) || null;
  }
}
