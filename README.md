# Line of Sight

A browser-based line-of-sight planner for VHF/UHF simplex radio. Pick a spot on a satellite map
and see what your radio can "see": areas **not** in line of sight are shaded, and everything
in line of sight is left as-is.

**Use it:** https://fractalated.github.io/line-of-sight/

## Features

- **Find a location** by street address (apartment numbers and typos are OK), place name, `lat, lon`, or Maidenhead grid square (e.g. `DM79lr`), or use your device's location.
- **Click anywhere** on the map to move the station there and redraw. You can also drag the marker.
- **Place names** in the sidebar: the street address you searched for, or the neighborhood and city of a point you clicked.
- **Antenna height** for your station and for the radio you want to reach, from on-the-ground to tower height, with presets (handheld, mast, tower).
- **Two-station mode**: place A and B to see where both have coverage (**hot pink**), A only (blue), B only (orange), or neither (shaded). You also get an A↔B terrain profile with the Fresnel zone and a plain-language verdict.
- **Map choices**: Esri satellite, USGS satellite, OpenTopoMap, USGS topo, OpenStreetMap, with optional place-name and road labels.
- Earth curvature with radio refraction (4/3 Earth), adjustable range, feet/miles or meters/km.
- **Shading on/off** button on the map to compare against the plain imagery. Shading strength and color are under More settings.
- **Crosshair & copy lat/long**: turn on the crosshair and drag the map (or click a spot) to aim. The coordinates show at the side with a Copy button. They're copied as `latitude, longitude`, with an on-screen confirmation. Right-click (long-press on a phone) copies any spot directly.
- Shareable links: the URL holds your stations and settings.
- Works on desktop and phone browsers. No install, no account.

## How it works

The satellite map is only for display. The calculation uses elevation data from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/), a free public dataset built
from SRTM, USGS 3DEP and others. For each station, the app loads the elevation around it and
casts rays outward in every direction. It keeps track of the highest terrain angle so far and
marks each point as visible or hidden, accounting for Earth curvature.

**Limitations:** terrain only. Trees, buildings and other clutter aren't modeled, so real
coverage is usually smaller. VHF can reach a little past geometric line of sight by bending
over ridges (diffraction), which this doesn't model.

## Run locally

```bash
python3 -m http.server 8123
```

Then open http://localhost:8123. There is no build step.

## Credits

Imagery © Esri, Maxar, Earthstar Geographics · USGS The National Map · © OpenStreetMap contributors ·
OpenTopoMap (CC-BY-SA) · Elevation: AWS Terrain Tiles · Geocoding: Esri World Geocoder, Nominatim, Photon · Map: Leaflet.
