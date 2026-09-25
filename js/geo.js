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
// preferName: the user searched by name (e.g. "Red Rocks Amphitheatre"), so show the name.
function searchLabel(name, a, preferName = false) {
  const city = pick(a, CITY_KEYS);
  const locality = city || a.county;
  const st = region(a);
  if (a.house_number && a.road && !(preferName && name)) {
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

// ---------- Place search ----------
// Each provider returns [{ name, label, lat, lon, exact, source }], where `exact` means the
// match is a specific street address (not just the street, ZIP or town).

const withTimeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// Esri World Geocoder: strongest on street addresses (rooftop points, typo-tolerant).
// Anonymous use for search (results not stored in a database) needs no API key.
const ESRI_GEOCODE = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const ESRI_FIELDS = 'Addr_type,StAddr,City,Subregion,Region,RegionAbbr,Postal,PlaceName,CntryName';
const ESRI_EXACT = new Set(['PointAddress', 'Subaddress', 'StreetAddress', 'StreetAddressExt', 'StreetInt']);

async function esriSearch(q, near) {
  let url = `${ESRI_GEOCODE}?f=json&maxLocations=5&outFields=${ESRI_FIELDS}&SingleLine=${encodeURIComponent(q)}`;
  if (near) url += `&location=${near.lon.toFixed(4)},${near.lat.toFixed(4)}`;
  const r = await fetch(url, { signal: withTimeout(10000) });
  if (!r.ok) throw new Error(`Esri HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Esri: ${j.error.message}`);
  return (j.candidates || []).filter((c) => c.score >= 80).map((c) => {
    const a = c.attributes;
    const exact = ESRI_EXACT.has(a.Addr_type) && !!a.StAddr;
    const locality = a.City || a.Subregion;
    const label = exact
      ? join([a.StAddr, locality, [a.RegionAbbr, a.Postal].filter(Boolean).join(' ')])
      : join([a.PlaceName || a.StAddr, locality, a.RegionAbbr || a.Region || a.CntryName]);
    return { name: c.address, label: label || c.address, lat: c.location.y, lon: c.location.x, exact, source: 'Esri' };
  });
}

// Nominatim (OpenStreetMap): strongest on landmarks, peaks, parks and towns.
async function nominatimSearch(q, near) {
  let path = `search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`;
  if (near) path += `&viewbox=${near.lon - 1},${near.lat + 1},${near.lon + 1},${near.lat - 1}`; // bias, not a limit
  const j = await nominatim(path);
  const byName = !looksLikeAddress(q);
  return j.map((x) => {
    const a = x.address || {};
    return {
      name: x.display_name,
      label: searchLabel(x.name, a, byName) || x.display_name,
      lat: +x.lat,
      lon: +x.lon,
      exact: !!a.house_number,
      source: 'OpenStreetMap',
    };
  });
}

// Photon (komoot, also OpenStreetMap data): last-resort fallback.
async function photonSearch(q, near) {
  let url = `https://photon.komoot.io/api/?limit=5&q=${encodeURIComponent(q)}`;
  if (near) url += `&lat=${near.lat.toFixed(4)}&lon=${near.lon.toFixed(4)}`;
  const r = await fetch(url, { signal: withTimeout(10000) });
  if (!r.ok) throw new Error(`Photon HTTP ${r.status}`);
  const j = await r.json();
  return j.features.map((f) => {
    const p = f.properties;
    const a = { house_number: p.housenumber, road: p.street, city: p.city, county: p.county, state: p.state, postcode: p.postcode };
    return {
      name: [p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.name, p.city, p.state, p.country].filter(Boolean).join(', '),
      label: searchLabel(p.name, a),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      exact: !!p.housenumber,
      source: 'Photon',
    };
  });
}

// "4500 W 38th Ave", "12-B Main St", "N123 County Rd K" (Wisconsin style).
const looksLikeAddress = (q) => /^\s*([NSEW]?\d+[A-Z]?(-\d+[A-Z]?)?)\s+\S/i.test(q);

// Remove what geocoders commonly choke on: unit numbers and ZIP+4 extensions.
export function cleanAddress(q) {
  return q
    .replace(/\b(apt|apartment|unit|ste|suite|lot|bldg|building|fl|floor|rm|room|spc|space|trlr|dept)\b\.?\s*#?\s*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    .replace(/\b(\d{5})-\d{4}\b/g, '$1')
    .replace(/\s+,/g, ',')
    .replace(/,\s*(,\s*)+/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

const streetOnly = (q) => q.replace(/^\s*[NSEW]?\d+[A-Z]?(-\d+[A-Z]?)?\s+/i, '');

function dedupe(list) {
  const out = [];
  for (const r of list) {
    if (!out.some((o) => Math.abs(o.lat - r.lat) < 0.0005 && Math.abs(o.lon - r.lon) < 0.0005)) out.push(r);
  }
  return out.slice(0, 6);
}

/**
 * Search with several geocoders and query variants.
 * @param near  optional { lat, lon } to prefer nearby matches (e.g. the map view)
 * @returns { results, note }  note explains an approximate match; results may be empty.
 * Throws only if every service failed to respond.
 */
export async function searchPlaces(q, { near = null } = {}) {
  const cleaned = cleanAddress(q);
  const isAddr = looksLikeAddress(q) || looksLikeAddress(cleaned);
  const tries = isAddr
    ? [[esriSearch, q], [nominatimSearch, q], [esriSearch, cleaned], [nominatimSearch, cleaned], [photonSearch, cleaned]]
    : [[nominatimSearch, q], [esriSearch, q], [photonSearch, q]];

  const seen = new Set();
  const loose = []; // non-exact matches collected along the way
  let answered = false;
  for (const [fn, text] of tries) {
    const key = `${fn.name}|${text}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    let hits;
    try {
      hits = await fn(text, near);
      answered = true;
    } catch (err) {
      console.warn('Geocoder failed', fn.name, err);
      continue;
    }
    if (!hits.length) continue;
    if (!isAddr) return { results: dedupe(hits), note: '' };
    const exact = hits.filter((h) => h.exact);
    if (exact.length) {
      // e.g. "1600 Pennsylvania Ave" without NW/SE matches two real addresses far apart.
      const ambiguous = exact.length > 1 && distanceM(exact[0], exact[1]) > 1000;
      let note = text !== q ? `Matched after ignoring the unit/apartment number: ${cleaned}` : '';
      if (ambiguous) note = 'More than one address matches. Check that the marker is on the right one, or pick another below.';
      return { results: dedupe([...exact, ...hits.filter((h) => !h.exact)]), note };
    }
    loose.push(...hits);
  }

  // No exact house match anywhere: fall back to the street itself, then whatever was close.
  if (isAddr) {
    try {
      const street = await esriSearch(streetOnly(cleaned), near);
      answered = true;
      if (street.length) {
        return { results: dedupe([...street, ...loose]), note: 'That house number wasn’t found, so this is the street or area. Drag the marker to the exact spot.' };
      }
    } catch (err) {
      console.warn('Geocoder failed', err);
    }
    if (loose.length) {
      return { results: dedupe(loose), note: 'That exact address wasn’t found, so this is the closest match. Check the marker.' };
    }
  }
  if (!answered) throw new Error('The search services didn’t respond. Check your internet connection and try again.');
  return { results: [], note: '' };
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
