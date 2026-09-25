// KMZ export for Google Earth: coverage layers as GroundOverlays (each in its own
// toggleable folder), station pins, range circles and the A→B path, zipped with the images.

import { EARTH_R } from './geo.js';

// ---------- Minimal ZIP writer (store only; PNGs are already compressed) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// files: [{ name, data: Uint8Array }] → Blob. The first file must be doc.kml for KMZ.
export function zip(files) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true); // version needed
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.google-earth.kmz' });
}

// ---------- KML helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const cdata = (html) => `<![CDATA[${String(html).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

// KML colors are aabbggrr.
export function kmlColor([r, g, b], alpha = 1) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return h(alpha * 255) + h(b) + h(g) + h(r);
}

// Points on a circle of radius m around (lat, lon), as KML "lon,lat,0" coordinates.
export function circleCoords(lat, lon, m, n = 144) {
  const δ = m / EARTH_R, φ1 = (lat * Math.PI) / 180, λ1 = (lon * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const θ = (2 * Math.PI * i) / n;
    const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
    const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
    pts.push(`${((λ2 * 180) / Math.PI).toFixed(6)},${((φ2 * 180) / Math.PI).toFixed(6)},0`);
  }
  return pts.join(' ');
}

// Round pin icon with a letter, as PNG bytes (embedded so the KMZ works offline).
export async function pinIcon(letter, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.beginPath();
  x.arc(32, 32, 27, 0, Math.PI * 2);
  x.fillStyle = color;
  x.fill();
  x.lineWidth = 6;
  x.strokeStyle = '#fff';
  x.stroke();
  x.fillStyle = '#fff';
  x.font = 'bold 30px system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(letter, 32, 34);
  return canvasBytes(c);
}

export async function canvasBytes(canvas) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * @param doc {
 *   name, description (HTML),
 *   lookAt: { lat, lon, range },
 *   bounds: { north, south, east, west },
 *   layers: [{ name, file, png: Uint8Array, color: [r,g,b], alpha, visible, drawOrder, description }],
 *   stations: [{ key, name, lat, lon, color, icon: Uint8Array, description }],
 *   circles: [{ name, coords, color }],
 *   path: { name, coords, color, description } | null,
 * }
 */
export function buildKmz(doc) {
  const styles = [
    ...doc.stations.map((s) => `
    <Style id="st-${s.key}">
      <IconStyle><scale>1.1</scale><Icon><href>files/pin-${s.key}.png</href></Icon><hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle>
      <LabelStyle><scale>1.0</scale></LabelStyle>
    </Style>`),
    ...doc.circles.map((c, i) => `
    <Style id="ring-${i}"><LineStyle><color>${kmlColor(c.color, 1)}</color><width>2.5</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`),
    doc.path ? `
    <Style id="path"><LineStyle><color>${kmlColor(doc.path.color, 1)}</color><width>3</width></LineStyle></Style>` : '',
  ].join('');

  const b = doc.bounds;
  const overlays = doc.layers.map((l) => `
    <Folder>
      <name>${esc(l.name)}</name>
      <visibility>${l.visible ? 1 : 0}</visibility>
      <GroundOverlay>
        <name>${esc(l.name)}</name>
        <visibility>${l.visible ? 1 : 0}</visibility>
        ${l.description ? `<description>${cdata(l.description)}</description>` : ''}
        <color>${kmlColor([255, 255, 255], l.alpha)}</color>
        <drawOrder>${l.drawOrder}</drawOrder>
        <Icon><href>${esc(l.file)}</href></Icon>
        <LatLonBox>
          <north>${b.north.toFixed(7)}</north><south>${b.south.toFixed(7)}</south>
          <east>${b.east.toFixed(7)}</east><west>${b.west.toFixed(7)}</west>
        </LatLonBox>
      </GroundOverlay>
    </Folder>`).join('');

  const pins = doc.stations.map((s) => `
      <Placemark>
        <name>${esc(s.name)}</name>
        <description>${cdata(s.description)}</description>
        <styleUrl>#st-${s.key}</styleUrl>
        <Point><coordinates>${s.lon.toFixed(6)},${s.lat.toFixed(6)},0</coordinates></Point>
      </Placemark>`).join('');

  const path = doc.path ? `
      <Placemark>
        <name>${esc(doc.path.name)}</name>
        <description>${cdata(doc.path.description)}</description>
        <styleUrl>#path</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${doc.path.coords}</coordinates></LineString>
      </Placemark>` : '';

  const rings = doc.circles.map((c, i) => `
      <Placemark>
        <name>${esc(c.name)}</name>
        <styleUrl>#ring-${i}</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${c.coords}</coordinates></LineString>
      </Placemark>`).join('');

  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(doc.name)}</name>
    <open>1</open>
    <description>${cdata(doc.description)}</description>
    <LookAt>
      <longitude>${doc.lookAt.lon.toFixed(6)}</longitude><latitude>${doc.lookAt.lat.toFixed(6)}</latitude>
      <altitude>0</altitude><heading>0</heading><tilt>0</tilt><range>${Math.round(doc.lookAt.range)}</range>
      <altitudeMode>relativeToGround</altitudeMode>
    </LookAt>${styles}
    <Folder>
      <name>Stations</name>
      <open>1</open>${pins}${path}
    </Folder>
    <Folder>
      <name>Line-of-sight coverage</name>
      <open>1</open>
      <description>Each layer can be turned on and off. Transparency can be changed in the layer's properties.</description>${overlays}
    </Folder>
    <Folder>
      <name>Analysis range</name>${rings}
    </Folder>
  </Document>
</kml>
`;

  const files = [
    { name: 'doc.kml', data: new TextEncoder().encode(kml) },
    ...doc.stations.map((s) => ({ name: `files/pin-${s.key}.png`, data: s.icon })),
    ...doc.layers.map((l) => ({ name: l.file, data: l.png })),
  ];
  return zip(files);
}
