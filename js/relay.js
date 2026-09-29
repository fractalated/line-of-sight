// Relay-site search: where could a repeater / Meshtastic node link stations A and B?
//
// Line of sight is reciprocal, so a cell with LOS from A (to an antenna of height hR on that
// cell) also has LOS back to A. That makes:
//   one relay  = any cell visible from both A and B          → pick the shortest A→R→B
//   two relays = R1 visible from A, R2 visible from B, R1↔R2 → shortest A→R1→R2→B
// Checking every R1/R2 pair is far too slow, so two-relay search seeds from the most promising
// cells (closest to the direct line, and the high ground on each side), runs a viewshed from
// each seed, and joins it with the other station's viewshed. It's a heuristic, not exhaustive.

import { computeViewshed, VISIBLE } from './viewshed.js';

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// Keep the best items (list sorted best-first) that are at least minSep apart.
function spread(list, minSep, max, pts = (it) => [it]) {
  const out = [];
  for (const it of list) {
    const p = pts(it);
    const far = out.every((o) => {
      const q = pts(o);
      // Routes are "different" when their relays aren't all near the same spots.
      return p.some((a, i) => Math.hypot(a.x - q[i].x, a.y - q[i].y) >= minSep);
    });
    if (far) out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * @param grid  elevation grid { elev, W, H }
 * @param o     { a: {gx, gy, h}, b: {gx, gy, h}, hR, radiusPx, mpp, k, maxRoutes }
 * @param onProgress (done, total) during the two-relay search
 * @returns { hops: 0 | 1 | 2, routes: [{ relays: [{x, y}], costPx }] }  hops 0 = nothing found
 */
export async function findRelays(grid, o, onProgress) {
  const { W, H, elev } = grid;
  const { a, b, hR, radiusPx, mpp, k } = o;
  const maxRoutes = o.maxRoutes || 3;
  const view = (gx, gy, obsH) => computeViewshed(grid, { gx, gy, mpp, obsH, tgtH: hR, radiusPx, k }).out;
  const visA = view(a.gx, a.gy, a.h);
  const visB = view(b.gx, b.gy, b.h);
  await yieldUI();

  const ax = Math.round(a.gx), ay = Math.round(a.gy), bx = Math.round(b.gx), by = Math.round(b.gy);
  const dA = (x, y) => Math.hypot(x - ax, y - ay);
  const dB = (x, y) => Math.hypot(x - bx, y - by);
  const bin = Math.max(2, Math.round(400 / mpp)); // ~400 m bins keep the candidate lists small
  const minSep = Math.max(bin * 2, 1500 / mpp); // alternatives at least ~1.5 km apart
  const bw = Math.ceil(W / bin), bh = Math.ceil(H / bin);

  // Per bin: the shortest one-relay cell, and the highest cell each station can see.
  const one = new Array(bw * bh).fill(null);
  const fromA = new Array(bw * bh).fill(null);
  const fromB = new Array(bw * bh).fill(null);
  for (let y = 0; y < H; y++) {
    const row = y * W, br = Math.floor(y / bin) * bw;
    for (let x = 0; x < W; x++) {
      const i = row + x, sa = visA[i] === VISIBLE, sb = visB[i] === VISIBLE;
      if (!sa && !sb) continue;
      if ((x === ax && y === ay) || (x === bx && y === by)) continue;
      const j = br + Math.floor(x / bin), e = elev[i];
      if (sa && sb) {
        const cost = dA(x, y) + dB(x, y);
        if (!one[j] || cost < one[j].cost) one[j] = { x, y, cost };
      }
      if (sa && (!fromA[j] || e > fromA[j].e)) fromA[j] = { x, y, e };
      if (sb && (!fromB[j] || e > fromB[j].e)) fromB[j] = { x, y, e };
    }
  }

  const oneList = one.filter(Boolean).sort((p, q) => p.cost - q.cost);
  if (oneList.length) {
    const best = spread(oneList, minSep, maxRoutes);
    return { hops: 1, routes: best.map((c) => ({ relays: [{ x: c.x, y: c.y }], costPx: c.cost })) };
  }

  // ---- Two relays ----
  const candA = fromA.filter(Boolean);
  const candB = fromB.filter(Boolean);
  if (!candA.length || !candB.length) return { hops: 0, routes: [] };
  // Lower bound on any route through a cell: straight to it, then straight to the far station.
  const lbA = (c) => dA(c.x, c.y) + dB(c.x, c.y);
  const pickSeeds = (cands) => {
    const byLine = spread([...cands].sort((p, q) => lbA(p) - lbA(q)), minSep, 7);
    const byHigh = spread([...cands].sort((p, q) => q.e - p.e), minSep, 5)
      .filter((c) => !byLine.includes(c));
    return [...byLine, ...byHigh];
  };
  const seedsA = pickSeeds(candA); // candidate R1s: A sees them
  const seedsB = pickSeeds(candB); // candidate R2s: B sees them
  const total = seedsA.length + seedsB.length;
  const routes = [];
  let done = 0;

  for (const s of seedsA) {
    const vs = view(s.x, s.y, hR);
    const base = dA(s.x, s.y);
    for (const c of candB) {
      if (vs[c.y * W + c.x] !== VISIBLE) continue;
      routes.push({ relays: [{ x: s.x, y: s.y }, { x: c.x, y: c.y }], costPx: base + Math.hypot(c.x - s.x, c.y - s.y) + dB(c.x, c.y) });
    }
    if (onProgress) onProgress(++done, total);
    await yieldUI();
  }
  for (const s of seedsB) {
    const vs = view(s.x, s.y, hR);
    const base = dB(s.x, s.y);
    for (const c of candA) {
      if (vs[c.y * W + c.x] !== VISIBLE) continue;
      routes.push({ relays: [{ x: c.x, y: c.y }, { x: s.x, y: s.y }], costPx: dA(c.x, c.y) + Math.hypot(s.x - c.x, s.y - c.y) + base });
    }
    if (onProgress) onProgress(++done, total);
    await yieldUI();
  }
  if (!routes.length) return { hops: 0, routes: [] };
  routes.sort((p, q) => p.costPx - q.costPx);
  return { hops: 2, routes: spread(routes, minSep, maxRoutes, (r) => r.relays) };
}
