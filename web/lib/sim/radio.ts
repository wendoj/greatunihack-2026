import { GRID, type CellIdx, type LinkStatus, type WorldPublic } from "../contract";
import { cx, cy, dist } from "./util";

/** Terrain must poke this far above the sight line to block it (rough diffraction allowance). */
const CLEARANCE_M = 12;

export function lineOfSight(w: WorldPublic, a: CellIdx, b: CellIdx): boolean {
  const ax = cx(a), ay = cy(a), bx = cx(b), by = cy(b);
  const hA = w.elevation[a] + w.radio.antennaM;
  const hB = w.elevation[b] + w.radio.antennaM;
  for (let k = 1; k <= 24; k++) {
    const f = k / 25;
    const c = Math.round(ay + (by - ay) * f) * GRID + Math.round(ax + (bx - ax) * f);
    if (c === a || c === b) continue;
    if (w.elevation[c] > hA * (1 - f) + hB * f + CLEARANCE_M) return false;
  }
  return true;
}

/** Receiver-side radio check (backend.md §5). */
export function canHear(
  w: WorldPublic,
  from: CellIdx,
  to: CellIdx,
  storm: number,
  rng: () => number,
): Exclude<LinkStatus, "off" | "stale"> {
  if (dist(from, to) > w.radio.rangeCells) return "range";
  if (!lineOfSight(w, from, to)) return "terrain";
  if (rng() < storm) return "storm";
  return "ok";
}
