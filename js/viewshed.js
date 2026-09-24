// Radial-sweep viewshed (the "R2" algorithm): cast a ray from the observer to
// every cell on the perimeter of the analysis square, walk outward, and keep
// the steepest terrain slope seen so far. A cell is visible when the line from
// the observer's antenna to the target antenna above that cell clears that slope.
//
// Earth curvature with atmospheric refraction is modeled with an effective
// Earth radius k·R (k = 4/3 is the standard VHF/UHF radio value).

import { EARTH_R } from './geo.js';

export const HIDDEN = 1;
export const VISIBLE = 2;

/**
 * @param grid  { elev: Float32Array, W, H }
 * @param o     { gx, gy }   observer position in grid pixels
 *              mpp          meters per grid pixel at the observer
 *              obsH         observer antenna height above ground, m
 *              tgtH         remote antenna height above ground, m
 *              radiusPx     analysis radius in grid pixels
 *              k            effective Earth radius factor (0 = flat Earth)
 * @returns { out: Uint8Array (0 = outside radius, 1 = hidden, 2 = visible), groundElev }
 */
export function computeViewshed(grid, o) {
  const { elev, W, H } = grid;
  const out = new Uint8Array(W * H);
  const ox = Math.max(0, Math.min(W - 1, Math.round(o.gx)));
  const oy = Math.max(0, Math.min(H - 1, Math.round(o.gy)));
  const groundElev = elev[oy * W + ox];
  const h0 = groundElev + o.obsH;
  const tgtH = o.tgtH;
  const mpp = o.mpp;
  const R = o.radiusPx;
  const r2 = R * R;
  const curv = o.k > 0 ? 1 / (2 * o.k * EARTH_R) : 0;

  const rc = Math.ceil(R);
  const xmin = Math.max(0, ox - rc), xmax = Math.min(W - 1, ox + rc);
  const ymin = Math.max(0, oy - rc), ymax = Math.min(H - 1, oy + rc);

  function ray(ex, ey) {
    const dx = ex - ox, dy = ey - oy;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps === 0) return;
    const sx = dx / steps, sy = dy / steps;
    let maxSlope = -Infinity;
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(ox + sx * i), y = Math.round(oy + sy * i);
      const px = x - ox, py = y - oy;
      const dp2 = px * px + py * py;
      if (dp2 > r2) break;
      const d = Math.sqrt(dp2) * mpp;
      const e = elev[y * W + x] - d * d * curv; // terrain dropped by curvature
      const idx = y * W + x;
      if ((e + tgtH - h0) / d >= maxSlope) out[idx] = VISIBLE;
      else if (out[idx] === 0) out[idx] = HIDDEN;
      const s = (e - h0) / d;
      if (s > maxSlope) maxSlope = s;
    }
  }

  for (let x = xmin; x <= xmax; x++) { ray(x, ymin); ray(x, ymax); }
  for (let y = ymin + 1; y < ymax; y++) { ray(xmin, y); ray(xmax, y); }
  out[oy * W + ox] = VISIBLE;

  // Fill any in-radius cells the rays skipped from their neighbor toward the observer.
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      const idx = y * W + x;
      if (out[idx] !== 0) continue;
      const px = x - ox, py = y - oy, dp2 = px * px + py * py;
      if (dp2 > r2) continue;
      const len = Math.sqrt(dp2);
      const nx = x - Math.round(px / len), ny = y - Math.round(py / len);
      out[idx] = out[ny * W + nx] || HIDDEN;
    }
  }

  return { out, groundElev };
}
