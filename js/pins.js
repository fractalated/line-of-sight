// Pins-only export: the station and relay pins where they are now (after any dragging),
// as GPX (GPS units, phone map apps), CSV (spreadsheets) or a small KML (Google Earth).
//
// pin   = { name, type: 'Station' | 'Relay', lat, lon, groundM, antennaM, place, option, notes }
// route = { name, points: [pin, ...] }   (A → relay(s) → B for each relay option)

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const f6 = (v) => v.toFixed(6);

export function toGpx({ title, pins, routes }) {
  const wpts = pins.map((p) => `
  <wpt lat="${f6(p.lat)}" lon="${f6(p.lon)}">${p.groundM != null ? `
    <ele>${p.groundM.toFixed(1)}</ele>` : ''}
    <name>${xml(p.name)}</name>
    <desc>${xml([p.place, p.notes].filter(Boolean).join(' · '))}</desc>
    <sym>${p.type === 'Relay' ? 'Radio Beacon' : 'Flag, Blue'}</sym>
    <type>${xml(p.type)}</type>
  </wpt>`).join('');
  const rtes = routes.map((r) => `
  <rte>
    <name>${xml(r.name)}</name>${r.points.map((p) => `
    <rtept lat="${f6(p.lat)}" lon="${f6(p.lon)}"><name>${xml(p.name)}</name></rtept>`).join('')}
  </rte>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Line of Sight (https://fractalated.github.io/line-of-sight/)" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xml(title)}</name>
    <time>${new Date().toISOString()}</time>
  </metadata>${wpts}${rtes}
</gpx>
`;
}

// units: { elevLabel, toElev(m) } so the columns match the app's feet/meters setting.
export function toCsv({ pins }, units) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['name', 'type', 'latitude', 'longitude', `ground_elevation_${units.elevLabel}`,
    `antenna_height_${units.elevLabel}`, 'place', 'relay_option', 'notes'];
  const rows = pins.map((p) => [
    p.name, p.type, f6(p.lat), f6(p.lon),
    p.groundM != null ? units.toElev(p.groundM).toFixed(0) : '',
    p.antennaM != null ? units.toElev(p.antennaM).toFixed(1) : '',
    p.place, p.option, p.notes,
  ].map(cell).join(','));
  // BOM so Excel reads UTF-8 (place names, "→") correctly.
  return '﻿' + [header.join(','), ...rows].join('\r\n') + '\r\n';
}

export function toKml({ title, pins, routes }) {
  const color = { Station: 'ffff782b', Relay: 'ffff309b' }; // aabbggrr: blue, purple
  const placemark = (p) => `
      <Placemark>
        <name>${xml(p.name)}</name>
        <description>${xml([p.place, `${f6(p.lat)}, ${f6(p.lon)}`, p.notes].filter(Boolean).join('\n'))}</description>
        <styleUrl>#${p.type === 'Relay' ? 'relay' : 'station'}</styleUrl>
        <Point><coordinates>${f6(p.lon)},${f6(p.lat)},0</coordinates></Point>
      </Placemark>`;
  const stations = pins.filter((p) => p.type === 'Station');
  const relayFolders = routes.map((r, i) => `
    <Folder>
      <name>${xml(r.name)}</name>
      <visibility>${i === 0 ? 1 : 0}</visibility>
      <Placemark>
        <name>${xml(r.name)} route</name>
        <visibility>${i === 0 ? 1 : 0}</visibility>
        <styleUrl>#route</styleUrl>
        <LineString><tessellate>1</tessellate><coordinates>${r.points.map((p) => `${f6(p.lon)},${f6(p.lat)},0`).join(' ')}</coordinates></LineString>
      </Placemark>${r.points.filter((p) => p.type === 'Relay').map(placemark).join('')}
    </Folder>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${xml(title)}</name>
    <open>1</open>
    <Style id="station"><IconStyle><color>${color.Station}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-blank.png</href></Icon></IconStyle></Style>
    <Style id="relay"><IconStyle><color>${color.Relay}</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-diamond.png</href></Icon></IconStyle></Style>
    <Style id="route"><LineStyle><color>ffff309b</color><width>3</width></LineStyle></Style>
    <Folder>
      <name>Stations</name>${stations.map(placemark).join('')}
    </Folder>${routes.length ? `
    <Folder>
      <name>Relay sites</name>${relayFolders}
    </Folder>` : ''}
  </Document>
</kml>
`;
}
