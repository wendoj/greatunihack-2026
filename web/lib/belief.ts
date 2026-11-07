import { CELLS, type AgentId, type Found, type SweepTable, type Telemetry, type WorldPublic } from "./contract";
import { decodeB64 } from "./sim/util";

// Snapshots arrive ~5×/s and mostly repeat the same strings, so decode by string identity.
const cache = new Map<string, Uint8Array>();
export function decodeSweeps(b64: string): Uint8Array {
  let u8 = cache.get(b64);
  if (!u8) {
    if (cache.size > 600) cache.clear();
    u8 = decodeB64(b64, CELLS);
    cache.set(b64, u8);
  }
  return u8;
}

export function totalCounts(table: SweepTable): Uint16Array {
  const n = new Uint16Array(CELLS);
  for (const id in table) {
    const d = decodeSweeps(table[id]);
    for (let c = 0; c < CELLS; c++) n[c] += d[c];
  }
  return n;
}

/** Elementwise max per agent id across several agents' views — the all-seeing "truth" view. */
export function unionTable(tables: SweepTable[]): Record<AgentId, Uint8Array> {
  const out: Record<AgentId, Uint8Array> = {};
  for (const t of tables)
    for (const id in t) {
      const d = decodeSweeps(t[id]);
      const cur = out[id];
      if (!cur) out[id] = d;
      else {
        let merged: Uint8Array | null = null;
        for (let c = 0; c < CELLS; c++)
          if (d[c] > cur[c]) {
            merged ??= cur.slice();
            merged[c] = d[c];
          }
        if (merged) {
          for (let c = 0; c < CELLS; c++) if (cur[c] > merged[c]) merged[c] = cur[c];
          out[id] = merged;
        }
      }
    }
  return out;
}

export function sumDecoded(tables: Record<AgentId, Uint8Array>): Uint16Array {
  const n = new Uint16Array(CELLS);
  for (const id in tables) {
    const d = tables[id];
    for (let c = 0; c < CELLS; c++) n[c] += d[c];
  }
  return n;
}

export function belief(world: WorldPublic, counts: Uint16Array, found: Found | null): { b: Float32Array; max: number } {
  const b = new Float32Array(CELLS);
  if (found) {
    b[found.cell] = 1;
    return { b, max: 1 };
  }
  const miss = 1 - world.pod;
  let sum = 0;
  for (let c = 0; c < CELLS; c++) sum += b[c] = world.prior[c] * Math.pow(miss, counts[c]);
  let max = 0;
  for (let c = 0; c < CELLS; c++) if ((b[c] /= sum) > max) max = b[c];
  return { b, max };
}

export function probSearched(world: WorldPublic, counts: Uint16Array): number {
  const miss = 1 - world.pod;
  let p = 0;
  for (let c = 0; c < CELLS; c++) if (counts[c]) p += world.prior[c] * (1 - Math.pow(miss, counts[c]));
  return p;
}

export type ViewKey = "truth" | "base" | AgentId;

export interface ViewData {
  counts: Uint16Array;
  found: Found | null;
  b: Float32Array;
  max: number;
}

const earliest = (fs: (Found | null)[]) =>
  fs.reduce<Found | null>((a, f) => (!f ? a : !a || f.atTick < a.atTick ? f : a), null);

/** Compute every view for a snapshot once (truth, base, each agent) plus each agent's gap vs truth. */
export function computeViews(world: WorldPublic, agents: Telemetry[]) {
  const truthTables = unionTable(agents.map((a) => a.sweeps));
  const truthCounts = sumDecoded(truthTables);
  const views = new Map<ViewKey, ViewData>();
  const truthFound = earliest(agents.map((a) => a.found));
  views.set("truth", { counts: truthCounts, found: truthFound, ...belief(world, truthCounts, truthFound) });
  const missing: Record<AgentId, number> = {};
  for (const a of agents) {
    const counts = totalCounts(a.sweeps);
    const key: ViewKey = a.role === "base" ? "base" : a.id;
    views.set(key, { counts, found: a.found, ...belief(world, counts, a.found) });
    let gap = 0;
    for (let c = 0; c < CELLS; c++) if (truthCounts[c] > counts[c]) gap += truthCounts[c] - counts[c];
    missing[a.id] = gap;
  }
  return { views, missing };
}
