// Point-to-point path profile between stations A and B: terrain (with Earth
// bulge), the direct line of sight, and the first Fresnel zone.

import { EARTH_R } from './geo.js';
import { sampleElevation } from './terrain.js';

/**
 * @param grid  elevation grid
 * @param A, B  { gx, gy, h }  grid position and antenna height (m)
 * @param opts  { distM, k, freqMHz }
 */
export function computeProfile(grid, A, B, { distM, k, freqMHz }) {
  const dpx = Math.hypot(B.gx - A.gx, B.gy - A.gy);
  const n = Math.max(2, Math.min(1200, Math.ceil(dpx)));
  const D = distM;
  const lambda = 299792458 / (freqMHz * 1e6);
  const curv = k > 0 ? 1 / (2 * k * EARTH_R) : 0;
  const eA = sampleElevation(grid, A.gx, A.gy), eB = sampleElevation(grid, B.gx, B.gy);
  const hA = eA + A.h, hB = eB + B.h;

  const pts = [];
  let blockAt = null, minRatio = Infinity, worst = -1;
  for (let i = 0; i <= n; i++) {
    const t = i / n, d = t * D;
    const e = sampleElevation(grid, A.gx + (B.gx - A.gx) * t, A.gy + (B.gy - A.gy) * t);
    const ground = e + d * (D - d) * curv; // terrain raised by Earth bulge
    const los = hA + (hB - hA) * t;
    const f1 = D > 0 ? Math.sqrt((lambda * d * (D - d)) / D) : 0;
    pts.push({ d, e, ground, los, f1 });
    if (i > 0 && i < n) {
      const clear = los - ground;
      if (clear < 0 && blockAt === null) blockAt = d;
      const ratio = f1 > 0 ? clear / f1 : Infinity;
      if (ratio < minRatio) { minRatio = ratio; worst = i; }
    }
  }

  let verdict;
  if (blockAt !== null) verdict = 'blocked';
  else if (minRatio < 0.6) verdict = 'marginal';
  else verdict = 'clear';

  return { pts, D, eA, eB, hA, hB, blockAt, minRatio, worst, verdict };
}

export function drawProfile(canvas, prof, fmt) {
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 46, r: 10, t: 10, b: 20 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const { pts, D } = prof;

  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.ground);
    hi = Math.max(hi, p.ground, p.los + p.f1);
  }
  const span = Math.max(20, hi - lo);
  lo -= span * 0.08; hi += span * 0.08;
  const X = (d) => pad.l + (D > 0 ? d / D : 0) * pw;
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

  // Fresnel zone band
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.d), Y(p.los + p.f1)));
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(pts[i].d), Y(pts[i].los - pts[i].f1));
  ctx.closePath();
  ctx.fillStyle = col('--fresnel');
  ctx.fill();

  // Terrain
  ctx.beginPath();
  ctx.moveTo(X(0), Y(lo));
  for (const p of pts) ctx.lineTo(X(p.d), Y(p.ground));
  ctx.lineTo(X(D), Y(lo));
  ctx.closePath();
  ctx.fillStyle = col('--terrain');
  ctx.fill();
  ctx.strokeStyle = col('--terrain-line');
  ctx.lineWidth = 1;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p.d), Y(p.ground)));
  ctx.stroke();

  // Line of sight
  const losColor = col(prof.verdict === 'blocked' ? '--bad' : prof.verdict === 'marginal' ? '--warn' : '--good');
  ctx.strokeStyle = losColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(prof.hA));
  ctx.lineTo(X(D), Y(prof.hB));
  ctx.stroke();

  // Worst point marker
  if (prof.worst > 0) {
    const p = pts[prof.worst];
    ctx.fillStyle = losColor;
    ctx.beginPath();
    ctx.arc(X(p.d), Y(p.ground), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Axes labels
  ctx.fillStyle = col('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const v of [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1]) {
    ctx.fillText(fmt.elev(v), pad.l - 5, Y(v));
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('A', X(0) + 2, h - 5);
  ctx.textAlign = 'right';
  ctx.fillText(`B · ${fmt.dist(D)}`, X(D), h - 5);
}
