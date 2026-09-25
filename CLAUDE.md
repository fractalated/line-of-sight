# Line of Sight — project notes for Claude

VHF/UHF **simplex line-of-sight planner** that runs entirely in the browser.
The user sees a satellite map; areas **not** in line of sight are shaded,
areas in line of sight are left unchanged. Built for amateur-radio / simplex
planning by the repo owner (GitHub: `fractalated`).

- Live site: https://fractalated.github.io/line-of-sight/
- Repo: https://github.com/fractalated/line-of-sight
- Hosting: GitHub Pages, deployed from the `main` branch root. Pushing to `main` deploys (takes ~1 minute).

## Picking this up on another computer

Everything needed lives in this repo. There is no build step, backend, or secret.

```bash
gh repo clone fractalated/line-of-sight ~/code/line-of-sight
```

Open that folder in the Claude desktop app (Code tab) and continue. Preview locally with
`python3 -m http.server 8123` (also defined in `.claude/launch.json` as `site`). A local server
is needed because the app uses ES modules. Commit and push when done so the other machine can
`git pull`.

Keep this file up to date when decisions change. It is how context moves between machines.

**Releasing: bump the version.** `index.html` stamps every CSS/JS URL with `?v=YYYYMMDD-N`
(the module script, the stylesheet, and an import map that versions the inner imports). Bump
it, replacing every occurrence, on any change to `css/` or `js/`. GitHub Pages lets browsers
cache files for 10 minutes. Without the bump, visitors get a mix of old and new modules, which
breaks the page (e.g. a missing export). When adding a new JS module, add it to the import map.
One-liner: `sed -i '' 's/v=OLD/v=NEW/g' index.html`.

## Requirements (from the owner)

1. Enter a location (place name, address, `lat, lon`, or Maidenhead grid square) **or** use the device's location.
2. Satellite imagery as the main view (easier to recognize landmarks). Offer other map choices (topo, street).
3. Shade what is NOT in line of sight; leave visible areas untouched.
4. Click anywhere on the map to move the station there and redraw.
5. Two-station mode: enter/click two locations and show the areas both can see.
6. Radio at "ground level" by default, with an adjustable antenna/tower height that updates the map.
7. Runs in a browser on any platform (desktop + phone).

## Architecture

Static site: plain HTML/CSS/ES modules, no bundler, no npm. Leaflet 1.9.4 from cdnjs.

| File | Role |
|---|---|
| `index.html` | Layout: full-screen map plus control panel (bottom sheet on phones ≤700px). |
| `css/style.css` | Styling; light/dark via CSS variables and `prefers-color-scheme`. |
| `js/app.js` | State, Leaflet map and layers, UI wiring, recompute pipeline, overlay painting, URL-hash persistence. |
| `js/terrain.js` | Fetches and decodes elevation tiles into a `Float32Array` grid (LRU tile cache). |
| `js/viewshed.js` | R2 radial-sweep viewshed with Earth curvature/refraction. |
| `js/profile.js` | A→B path profile: terrain + Earth bulge, LOS line, first Fresnel zone, verdict, canvas chart. |
| `js/kmz.js` | KMZ export: store-only ZIP writer (CRC32), KML builder (GroundOverlays, pins, rings, path), pin icons. |
| `js/geo.js` | Web Mercator math, distance/bearing, Maidenhead, lat/lon parsing, multi-geocoder search, reverse geocoding. |

**Recompute pipeline** (`recompute()` in app.js):
stations + radius → `chooseZoom()` picks the highest DEM zoom (≤14) where the union of the
analysis circles fits in `MAX_GRID` (2048) pixels → load the tile range → `computeViewshed()` per
station on the shared grid → `renderOverlay()` paints a canvas (cropped to the circles) →
`toBlob` → `L.imageOverlay`. The DEM grid is in Web Mercator pixels, so the image lines up
linearly with Leaflet's map. A `runId` token discards stale async results.
Height changes reuse the cached grid, so only the viewshed runs again (fast).

**Viewshed** (`viewshed.js`): rays from the observer to every cell on the perimeter of the
bounding square, stopped at the radius. Track the max terrain slope `(e − drop − h0)/d`, where
`drop = d²/(2kR)`. A cell is visible if the slope to the *target antenna*
`(e − drop + tgtH − h0)/d ≥ maxSlope`. Result codes: 0 = outside radius, 1 = hidden,
2 = visible. Multiple rays can hit a cell, and visible wins. A final pass fills skipped cells.
Distances use meters-per-pixel at the observer's latitude (fine for ≤100 km).

**Two-station mode**: both viewsheds use the same "other radio" target height. Colors:
**hot pink (#FF1493) with a white outline = both see it** (owner asked for the overlap to be
very noticeable), blue = A only, orange = B only, shade color = neither. The pink is drawn at a
fixed 60% (`BOTH_ALPHA`, white outline at 85%) whatever the shade-strength slider says. That means alpha is baked
into the overlay pixels (the image overlay itself is at opacity 1), so moving the slider
repaints the overlay. Single-station mode still leaves visible areas unshaded. The A↔B
profile gives the direct simplex verdict: blocked / marginal (<60% of Fresnel zone 1 clear) / clear.

**State** lives in the URL hash (shareable links): `m` mode (1/2), `a`,`b` lat,lon, `la`,`lb` place labels, `ha`,`hb`,`ht`
heights in **meters**, `r` radius in meters, `k`, `f` MHz, `u` units, `s` shade, `o` opacity.
localStorage keeps only the chosen base layer and label toggles (wrapped in try/catch).

## Data sources (all free, no API keys, CORS-enabled)

| Use | Source | URL template | Notes |
|---|---|---|---|
| **Elevation (calculation)** | AWS Terrain Tiles (Terrarium) | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Public dataset (SRTM, USGS 3DEP, ETOPO1…). `elev = R*256 + G + B/256 − 32768`. Max z15; we cap at z14. Bare earth: no trees/buildings. |
| Satellite (default) | Esri World Imagery | `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | Attribution required. Note y/x order. |
| Satellite (US) | USGS National Map imagery | `basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}` | Public domain. Native to z16. |
| Topo | OpenTopoMap | `{s}.tile.opentopomap.org/{z}/{x}/{y}.png` | CC-BY-SA. Native to z17. |
| Topo (US) | USGS Topo | `basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}` | Public domain. |
| Street | OpenStreetMap | `tile.openstreetmap.org/{z}/{x}/{y}.png` | Light use only per OSM tile policy. |
| Labels overlays | Esri Reference (Boundaries & Places, Transportation) | `…/Reference/World_Boundaries_and_Places/…` | Drawn in a `labels` pane above the shading. |
| Geocoding: addresses | Esri World Geocoder | `geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?f=json&SingleLine=` | No key needed for search (results not stored). CORS OK. Rooftop US addresses, typo-tolerant. Weak on landmarks ("pikes peak" → villages). |
| Geocoding: places, reverse | Nominatim (OSM), Photon (komoot) as last fallback | `nominatim.openstreetmap.org/search?format=jsonv2` | Nominatim: 1 request/sec (shared queue in geo.js), needs a Referer (browsers send one; bare curl gets 403). Poor US house-number coverage. |
| (not used) | US Census geocoder | `geocoding.geo.census.gov/geocoder/locations/onelineaddress` | Excellent US addresses, but **no CORS**. Would need a proxy (e.g. a Cloudflare Worker) if Esri ever stops working anonymously. |

The display map and the elevation data are separate on purpose: the user sees imagery, and the
math uses the DEM.

## Decisions and gotchas

- **Default antenna heights are 5 ft (handheld), not 0.** The owner asked for "ground level".
  At a literal 0 ft, DEM bumps a few meters away block nearly everything, so we read "ground
  level" as a person standing with a handheld. "On the dirt 0" is a preset. Constant: `DEFAULT_H`.
- Broad summits (e.g. Pikes Peak) show little coverage from the middle of the plateau. This is
  geometrically correct: the plateau edge hides the terrain below. The status line shows a tip
  when coverage is under 3%.
- Negative elevations are clamped to 0 (ocean bathymetry → sea surface). Side effect: land below
  sea level (Death Valley, Salton Sea) is flattened to 0.
- Pure geometric line of sight: no diffraction, clutter, or signal-strength model. VHF often
  reaches a bit past geometric LOS through diffraction; the UI notes that clutter isn't modeled.
- Shading is deliberately light, so the map shows through (owner found it too dark): default
  strength 0.3 (owner then asked for all colors to be more transparent), and the "dark" shade is a slate `[20, 24, 40]` rather than near-black.
- A "Shading on/off" button on the map (top right, `ShadingToggle` control) hides or shows
  `losLayer`, including the pink overlap. It stays in sync with the layers-menu checkbox. It is
  not persisted: shading is always on at page load.
- **Crosshair / copy lat/long**: the "Crosshair" map button (`CrosshairToggle`) shows a fixed
  reticle at the center of the part of the map the panel doesn't cover (`crosshairPoint()`), plus
  a side box under the button (`CrosshairReadout`) with the live `lat, lon` and a Copy button.
  The owner first had a click-to-copy mode button and rejected it as unclear about *which*
  point was copied. Then they asked for the coordinates at the side, not under the crosshair.
  While the crosshair is on, a map click pans that spot under the crosshair (it doesn't move a
  station). Esc turns it off. Right-click (long-press on touch) still copies the clicked point
  at any time. Format: 6 decimals, `39.801151, -105.062256`. Uses
  `navigator.clipboard.writeText`, falling back to `execCommand('copy')`. Confirmation: the
  Copy button turns green ("Copied ✓"), a green banner drops down at the top, and a ring
  ripples at the spot. On failure, a red banner shows the text to copy by hand.
- **Search** (`searchPlaces()` in geo.js). The owner reported known-good addresses returning
  "not found": Nominatim alone misses many US house numbers and chokes on unit numbers. The
  pipeline now picks by query type:
  - Address-like (starts with a house number, `looksLikeAddress`): Esri → Nominatim → both again
    with `cleanAddress()` (drops Apt/Unit/Suite/#, ZIP+4) → Photon. Still no exact house match →
    the street alone (Esri) with a "house number wasn't found" note → any loose match.
  - Everything else (landmarks, towns): Nominatim → Esri → Photon.
  - Results near the map center are preferred when zoomed in (zoom ≥ 7).
  - Exact matches far apart (e.g. 1600 Pennsylvania Ave NW vs SE) → "more than one address
    matches" note.
  - Other matches appear in a list under the search box.
  - Search messages (errors, warnings, "Searching…", location errors) show **directly under the
    search box** (`searchMsg()`), not in the status line at the bottom. The owner couldn't see
    errors that needed scrolling.
- **Station place labels** (sidebar, above the coordinates). A searched place shows its
  address from the geocoder (`searchLabel()` in geo.js). A street address shows as
  `1437 Bannock Street, Denver, CO 80202`, and other places as name + city/county + state.
  Points placed by map click, marker drag, "use my location", or typed lat/lon or grid square
  are reverse-geocoded to **neighborhood + city** (`areaLabel()`): e.g. `Capitol Hill, Denver`.
  Neighborhood order is suburb → neighbourhood → quarter → hamlet (OSM `suburb` holds the
  well-known names; `neighbourhood` is often a historic district). No neighborhood → `City, ST`;
  rural → `County, ST`. Owner's rule: a typed street address shows that address; a clicked
  point shows neighborhood and city, never a street address. Lookups are debounced (400 ms), and
  results for a station that has since moved are dropped. All Nominatim calls share a 1.1 s
  queue (usage policy). Labels are saved in the hash as `la`/`lb`; a link without them gets
  looked up on load.
- **Coverage numbers live in the legend**, one row per color: area (sq mi / km², one
  decimal) and share of the total, then a "Total analyzed" row. `renderOverlay()` fills
  `lastStats` from the same per-pixel classes it paints, so numbers and map can't disagree. The
  owner doubted the math when the sidebar said 0% beside visible pink. It was whole-number
  rounding of a 0.1% overlap, and the numbers were in a sentence away from the colors. Verified
  on 2026-09-25: pixel counts read back from the rendered overlay matched the legend, and the
  total matched two-circle geometry within 0.2%. Shares under 10% keep one decimal ("<0.1%",
  "0%" only when truly zero). The status line now holds only tips and warnings (hidden when
  empty). The hilltop tip shows only in one-station mode.
- **KMZ export** ("Export KMZ for Google Earth" button under the legend; `exportKmz()` in
  app.js, `buildKmz()` in kmz.js). Each coverage class is its own GroundOverlay in its own
  folder, so it can be toggled in Google Earth: two-station = both (pink with white outline) /
  A only / B only / neither; one-station = not in line of sight, plus a green "in line of sight"
  highlight that is off by default. Layer names carry the area and share. Also in the file: A/B
  pins (embedded PNG icons, so it works offline) with label, coordinates, grid square, ground
  elevation and antenna height; the A→B path with the profile verdict; the range circles; a
  description with settings and a link that reopens the analysis. Pixels are fully opaque, and
  transparency comes from each overlay's KML `<color>` alpha, so Google Earth's transparency
  slider can go either way. **Reprojection:** a KML LatLonBox assumes rows are evenly spaced in
  *latitude*, but our grid rows are Web Mercator, so `classLayerCanvas()` resamples each row by
  latitude. Verified 2026-09-25: 100% of pink pixels land on the same lat/lon as the app's
  overlay, against 59% without reprojection. Uses `lastPaint` (the per-pixel classes from the
  last `renderOverlay`). Validated with `unzip -t` and Python `zipfile`. Not yet opened in real
  Google Earth. If something looks off there, check drawOrder and LatLonBox first.
- Earth curvature options: k = 4/3 (radio, default), 1 (optical), 0 (flat).
- Default frequency: 146.52 MHz (national 2 m simplex). Used only for the Fresnel zone in the profile.
- No backend. The owner also has Cloudflare and a Claude API key available if a backend is
  ever needed (e.g. a tile proxy or AI features). Not currently used.

## Ideas / possible next steps

- Web Worker for the viewshed, so big radii don't block the UI.
- Signal-strength mode (free-space path loss + knife-edge diffraction), with ERP and receiver sensitivity.
- Repeater mode: pick a repeater site and show the areas that can reach it.
- Tap-to-profile in single mode (profile from A to any tapped point).
- GeoTIFF export; save named locations.
- PWA / offline caching of tiles for field use.
