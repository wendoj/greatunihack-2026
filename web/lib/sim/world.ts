import { CELLS, GRID, idx, type AgentId, type CellIdx, type WorldPublic } from "../contract";
import { cx, cy, mulberry32 } from "./util";

export const SEARCHER_IDS: AgentId[] = ["A", "B", "C", "D", "E", "F"];
export type WorldFull = WorldPublic & { casualty: CellIdx };

function valueNoise(rng: () => number, cell: number) {
  const n = Math.ceil(GRID / cell) + 2;
  const lat = new Float32Array(n * n).map(() => rng());
  return (x: number, y: number) => {
    const gx = x / cell, gy = y / cell;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const v = (i: number, j: number) => lat[j * n + i];
    const a = v(ix, iy) * (1 - fx) + v(ix + 1, iy) * fx;
    const b = v(ix, iy + 1) * (1 - fx) + v(ix + 1, iy + 1) * fx;
    return a * (1 - fy) + b * fy;
  };
}

/** Deterministic mock world. Mirrors backend.md §4, simplified. */
export function generateWorld(seed: number): WorldFull {
  const rng = mulberry32(seed * 9973 + 17);
  const o1 = valueNoise(rng, 12), o2 = valueNoise(rng, 6), o3 = valueNoise(rng, 3);

  const raw = new Float32Array(CELLS);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < CELLS; i++) {
    const x = cx(i), y = cy(i);
    const v = o1(x, y) + 0.5 * o2(x, y) + 0.25 * o3(x, y);
    raw[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }

  // Ridge: a diagonal line through the middle, top-left → bottom-right-ish.
  const theta = ((35 + rng() * 20) * Math.PI) / 180;
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const nx = -uy, ny = ux; // normal; d > 0 is the lower-left half
  const ox = 19.5 + (rng() - 0.5) * 4, oy = 19.5 + (rng() - 0.5) * 4;
  const cols = [-9 + rng() * 4, 5 + rng() * 6];
  const sd = (i: number) => (cx(i) - ox) * nx + (cy(i) - oy) * ny;
  const st = (i: number) => (cx(i) - ox) * ux + (cy(i) - oy) * uy;

  const elevation = new Array<number>(CELLS);
  for (let i = 0; i < CELLS; i++) {
    const d = sd(i), t = st(i);
    let dip = 0;
    for (const c of cols) dip = Math.max(dip, Math.exp(-((t - c) ** 2) / (2 * 1.8 ** 2)));
    const ridge = 150 * Math.exp(-(d * d) / (2 * 2.5 * 2.5)) * (1 - 0.5 * dip);
    elevation[i] = Math.round(250 + 250 * ((raw[i] - lo) / (hi - lo)) + ridge);
  }

  const inGrid = (x: number, y: number) => x >= 0 && y >= 0 && x < GRID && y < GRID;
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];

  // Base on the left edge (lower-left side of the ridge), LKP on the far side near the ridge.
  let baseCands: number[] = [];
  for (let y = 0; y < GRID; y++) if (sd(idx(0, y)) > 9) baseCands.push(idx(0, y));
  if (!baseCands.length)
    for (let i = 0; i < CELLS; i++) {
      const x = cx(i), y = cy(i);
      if ((x === 0 || y === GRID - 1) && sd(i) > 6) baseCands.push(i);
    }
  if (!baseCands.length) baseCands = [idx(0, GRID - 1)];
  const base = pick(baseCands);

  const lkpCands: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    const x = cx(i), y = cy(i), d = sd(i);
    if (d < -3 && d > -8 && x >= 4 && y >= 4 && x < GRID - 4 && y < GRID - 4 && Math.abs(st(i)) < 13)
      lkpCands.push(i);
  }
  const lkp = lkpCands.length ? pick(lkpCands) : idx(30, 10);

  // Streams: steepest descent from 3 high cells.
  const isStream = new Array<boolean>(CELLS).fill(false);
  const streams: CellIdx[][] = [];
  const sorted = [...Array(CELLS).keys()].sort((a, b) => elevation[b] - elevation[a]);
  for (let s = 0; s < 3; s++) {
    let c = sorted[Math.floor(rng() * CELLS * 0.25)];
    const line: CellIdx[] = [];
    streams.push(line);
    for (let k = 0; k < 80; k++) {
      isStream[c] = true;
      line.push(c);
      let best = c;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx(c) + dx, y = cy(c) + dy;
          if (!inGrid(x, y)) continue;
          const j = idx(x, y);
          if (elevation[j] < elevation[best]) best = j;
        }
      if (best === c) break;
      const bx = cx(best), by = cy(best);
      if (bx === 0 || by === 0 || bx === GRID - 1 || by === GRID - 1) {
        isStream[best] = true;
        line.push(best);
        break;
      }
      c = best;
    }
  }

  // Paths: from base towards each col, with a little wobble.
  const isPath = new Array<boolean>(CELLS).fill(false);
  const paths: CellIdx[][] = [];
  for (const t of cols) {
    const tx = Math.round(ox + ux * t), ty = Math.round(oy + uy * t);
    let x = cx(base), y = cy(base);
    const line: CellIdx[] = [];
    paths.push(line);
    for (let k = 0; k < 80 && (x !== tx || y !== ty); k++) {
      isPath[idx(x, y)] = true;
      line.push(idx(x, y));
      const sx = Math.sign(tx - x), sy = Math.sign(ty - y);
      const r = rng();
      if (r < 0.15 && sy !== 0) y += sy;
      else if (r < 0.3 && sx !== 0) x += sx;
      else {
        x += sx;
        y += sy;
      }
      x = Math.max(0, Math.min(GRID - 1, x));
      y = Math.max(0, Math.min(GRID - 1, y));
    }
    if (inGrid(tx, ty)) {
      isPath[idx(tx, ty)] = true;
      if (line.at(-1) !== idx(tx, ty)) line.push(idx(tx, ty));
    }
  }

  // Prior: Gaussian around the LKP, nudged downhill and onto paths/streams.
  const prior = new Array<number>(CELLS);
  let sum = 0;
  for (let i = 0; i < CELLS; i++) {
    const d2 = (cx(i) - cx(lkp)) ** 2 + (cy(i) - cy(lkp)) ** 2;
    let p = Math.exp(-d2 / (2 * 36));
    if (elevation[i] < elevation[lkp]) p *= 1.5;
    if (isPath[i] || isStream[i]) p *= 1.5;
    prior[i] = p;
    sum += p;
  }
  for (let i = 0; i < CELLS; i++) prior[i] /= sum;

  // Starts: searchers within 3 cells of base.
  const starts: Record<AgentId, CellIdx> = { BASE: base };
  const taken = new Set<number>([base]);
  for (const id of SEARCHER_IDS) {
    for (let tries = 0; tries < 50; tries++) {
      const x = cx(base) + Math.round((rng() - 0.3) * 6);
      const y = cy(base) + Math.round((rng() - 0.5) * 6);
      if (!inGrid(x, y) || taken.has(idx(x, y))) continue;
      starts[id] = idx(x, y);
      taken.add(idx(x, y));
      break;
    }
    starts[id] ??= base;
  }

  // Casualty: sampled from the prior (never given to agents directly).
  const crng = mulberry32(seed ^ 0x9e3779b9);
  let r = crng(), casualty = lkp;
  for (let i = 0; i < CELLS; i++) {
    r -= prior[i];
    if (r <= 0) {
      casualty = i;
      break;
    }
  }

  return {
    seed,
    size: GRID,
    cellMetres: 50,
    elevation,
    isPath,
    isStream,
    paths,
    streams,
    prior,
    lkp,
    base,
    starts,
    radio: { rangeCells: 12, antennaM: 2 },
    pod: 0.8,
    casualty,
  };
}
