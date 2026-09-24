// Elevation data: AWS Terrain Tiles ("Terrarium" PNG encoding), a free public
// dataset (SRTM, USGS 3DEP/NED, ETOPO1 and others) on the Registry of Open Data.
// Each 256x256 tile is decoded to a Float32Array of meters above sea level.
// https://registry.opendata.aws/terrain-tiles/

const TILE = 256;
const MAX_CACHE = 160; // tiles (~256 KB each decoded)
const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const cache = new Map(); // "z/x/y" -> Promise<Float32Array|null>
let ctx = null;

function decoder() {
  if (!ctx) {
    const c = document.createElement('canvas');
    c.width = c.height = TILE;
    ctx = c.getContext('2d', { willReadFrequently: true });
  }
  return ctx;
}

async function fetchTile(z, x, y) {
  const res = await fetch(tileUrl(z, x, y));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  // drawImage + getImageData run synchronously, so the shared canvas is safe.
  const c = decoder();
  c.clearRect(0, 0, TILE, TILE);
  c.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const px = c.getImageData(0, 0, TILE, TILE).data;
  const out = new Float32Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const e = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    // Oceans carry bathymetry; the water surface is what radio sees.
    out[i] = e < 0 ? 0 : e;
  }
  return out;
}

function getTile(z, x, y) {
  const n = Math.pow(2, z);
  if (y < 0 || y >= n) return Promise.resolve(null);
  x = ((x % n) + n) % n;
  const key = `${z}/${x}/${y}`;
  let p = cache.get(key);
  if (p) {
    cache.delete(key); // refresh LRU position
  } else {
    p = fetchTile(z, x, y).catch((err) => {
      console.warn('Terrain tile failed', key, err);
      cache.delete(key);
      return null;
    });
    while (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  }
  cache.set(key, p);
  return p;
}

// Assemble tiles tx0..tx1 × ty0..ty1 at zoom z into one elevation grid.
// Grid pixel (0,0) is global Web Mercator pixel (x0, y0) at zoom z.
export async function loadElevationGrid(z, tx0, ty0, tx1, ty1, onProgress) {
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const W = cols * TILE, H = rows * TILE;
  const elev = new Float32Array(W * H);
  const total = cols * rows;
  let done = 0, failed = 0;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        getTile(z, tx, ty).then((t) => {
          if (t) {
            const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
            for (let r = 0; r < TILE; r++) elev.set(t.subarray(r * TILE, (r + 1) * TILE), (oy + r) * W + ox);
          } else {
            failed++;
          }
          done++;
          if (onProgress) onProgress(done, total);
        })
      );
    }
  }
  await Promise.all(jobs);
  return { z, x0: tx0 * TILE, y0: ty0 * TILE, W, H, elev, failed };
}

// Bilinear elevation at fractional grid coordinates.
export function sampleElevation(grid, gx, gy) {
  const { W, H, elev } = grid;
  const x = Math.max(0, Math.min(W - 1.001, gx)), y = Math.max(0, Math.min(H - 1.001, gy));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i = y0 * W + x0;
  const top = elev[i] * (1 - fx) + elev[i + 1] * fx;
  const bot = elev[i + W] * (1 - fx) + elev[i + W + 1] * fx;
  return top * (1 - fy) + bot * fy;
}
