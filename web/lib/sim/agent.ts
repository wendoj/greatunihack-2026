import {
  CELLS,
  GRID,
  type AgentId,
  type CellIdx,
  type Found,
  type IntentEntry,
  type LinkStatus,
  type Mode,
  type Role,
  type Strategy,
  type WorldPublic,
} from "../contract";
import { lineOfSight } from "./radio";
import { cheb, cx, cy, dist, fmtCell } from "./util";

/** Immutable snapshot of one agent's own sweep table. Never mutated once created. */
export interface TableSnap {
  v: number; // owner's sweep count when snapped (monotone)
  data: Uint8Array;
  recent: Int32Array; // owner's last ≤64 swept cells, oldest first
}

/** In-memory analogue of StateMsg (plus a relayed central AssignMsg). */
export interface WireState {
  from: AgentId;
  role: Role;
  tick: number;
  pos: CellIdx;
  mode: Mode;
  tables: Record<AgentId, TableSnap>;
  found: Found | null;
  baseKnowsFound: boolean;
  intents: Record<AgentId, IntentEntry>;
  assign: { assignments: Record<AgentId, CellIdx>; baseTick: number } | null;
}

export interface Packet {
  msg: WireState;
  link: LinkStatus;
}

const LAMBDA = 0.15;
const MU = 0.8;
const MAX_N = 256 * 7;
const missPow = (pod: number) => {
  const t = new Float64Array(MAX_N);
  for (let n = 0; n < MAX_N; n++) t[n] = Math.pow(1 - pod, n);
  return t;
};
let MISS: Float64Array | null = null;
// Planning scratch buffers (planning is synchronous, so sharing them between agents is safe).
const SCRATCH_BELIEF = new Float64Array(CELLS);
const SCRATCH_CLAIM = new Float64Array(CELLS);
const SCRATCH_CLAIMER = new Int8Array(CELLS);

const SCORE_OUT = new Int32Array(2);
/** Hot loop, kept as a plain function so the JIT sees one monomorphic shape. Writes [best, bestUnclaimed]. */
function scoreCells(
  b: Float64Array,
  claim: Float64Array,
  elev: Float64Array,
  e0: number,
  mu: number,
  fx: number,
  fy: number,
  exclude: ((c: number) => boolean) | undefined,
) {
  let best = -1, bestS = -Infinity, raw = -1, rawS = -Infinity;
  for (let y = 0, c = 0; y < GRID; y++) {
    const dy = y > fy ? y - fy : fy - y;
    for (let x = 0; x < GRID; x++, c++) {
      const bc = b[c];
      if (bc <= 0) continue;
      if (exclude !== undefined && exclude(c)) continue;
      const dx = x > fx ? x - fx : fx - x;
      const de = elev[c] - e0;
      const cost = (dx > dy ? dx : dy) + 0.02 * (de < 0 ? -de : de);
      const s0 = bc / (1 + LAMBDA * cost);
      const s = s0 - mu * claim[c];
      if (s > bestS) {
        bestS = s;
        best = c;
      }
      if (s0 > rawS) {
        rawS = s0;
        raw = c;
      }
    }
  }
  SCORE_OUT[0] = best;
  SCORE_OUT[1] = raw;
}

const pct = (b: number) => {
  const p = b * 100;
  return p >= 1 ? `${p.toFixed(1)}%` : p >= 0.1 ? `${p.toFixed(2)}%` : `${p.toFixed(3)}%`;
};

export class SimAgent {
  readonly id: AgentId;
  readonly role: Role;
  readonly strategy: Strategy;
  private w: WorldPublic;
  private elev: Float64Array;
  private rng: () => number;
  private isCasualty: (c: CellIdx) => boolean;

  pos: CellIdx;
  tick = 0;
  alive = true;
  radioOn = true;
  offline = false; // effective: !radioOn || blackout (set by engine)

  own = new Uint8Array(CELLS);
  ownV = 0;
  private ownRecent: number[] = [];
  ownSnap: TableSnap;
  others = new Map<AgentId, TableSnap>();
  private lastSwept = new Int32Array(CELLS).fill(-9999);
  private countsCache: Uint16Array | null = null;
  private countsBuf: Uint16Array | null = null;

  found: Found | null = null;
  baseKnowsFound = false;
  intents = new Map<AgentId, IntentEntry & { heard: number }>();
  lastHeard = new Map<AgentId, number>();
  lastPacket = new Map<AgentId, number>();
  links: Record<AgentId, LinkStatus> = {};
  private heardBaseAt: CellIdx | null = null;
  private ordersHeardAt: CellIdx | null = null;

  target: CellIdx | null = null;
  private planTick = -999;
  mode: Mode = "search";
  reason = "Starting up";
  private waitTicks = 0;
  path: CellIdx[] = [];
  stats = { sweeps: 0, duplicateSweeps: 0 };
  assign: { assignments: Record<AgentId, CellIdx>; baseTick: number; heard: number } | null = null;

  /** BASE only: who delivered the find, for the event feed. */
  informedVia: { from: AgentId; mode: Mode } | null = null;
  foundSelf = false;
  /** Cell swept this tick, or -1. Read by the engine for truth-based duplicate counts. */
  sweptCell = -1;
  /** Engine-side flag: when false, the casualty can't be detected (coverage-only runs). */
  canDetect = true;
  /**
   * Live processes have no all-seeing engine, so they count duplicates from their own
   * merged knowledge. The in-memory engine leaves this off and counts against truth.
   */
  countOwnDuplicates = false;

  constructor(opts: {
    id: AgentId;
    role: Role;
    strategy: Strategy;
    world: WorldPublic;
    rng: () => number;
    isCasualty: (c: CellIdx) => boolean;
  }) {
    this.id = opts.id;
    this.role = opts.role;
    this.strategy = opts.strategy;
    this.w = opts.world;
    this.elev = Float64Array.from(opts.world.elevation);
    this.rng = opts.rng;
    this.isCasualty = opts.isCasualty;
    this.pos = opts.world.starts[opts.id] ?? opts.world.base;
    this.path = [this.pos];
    this.ownSnap = { v: 0, data: new Uint8Array(CELLS), recent: new Int32Array(0) };
    MISS ??= missPow(opts.world.pod);
    if (this.role === "base") this.reason = "Listening for teammates";
  }

  // ------------------------------------------------------------------ receive
  receive(packets: Packet[]) {
    const ignoreState = this.strategy === "independent" && this.role === "searcher";
    for (const { msg, link } of packets) {
      this.lastPacket.set(msg.from, this.tick);
      this.links[msg.from] = link;
      if (link !== "ok") continue;
      this.lastHeard.set(msg.from, this.tick);
      if (msg.from === "BASE") this.heardBaseAt = this.pos;

      if (ignoreState) {
        // Independent agents ignore teammates; they only accept base's confirmation of their own find.
        if (msg.from === "BASE" && msg.baseKnowsFound && this.found) this.baseKnowsFound = true;
        continue;
      }

      for (const j in msg.tables) {
        if (j === this.id) continue;
        const snap = msg.tables[j];
        const cur = this.others.get(j);
        if (cur && snap.v <= cur.v) continue;
        const delta = snap.v - (cur?.v ?? 0);
        const r = snap.recent;
        for (let k = Math.max(0, r.length - delta); k < r.length; k++) this.lastSwept[r[k]] = this.tick;
        this.others.set(j, snap);
        // Keep the summed counts current incrementally: a newer snapshot differs from the old one
        // by exactly the owner's last `delta` sweeps, which `recent` lists.
        const n = this.countsCache;
        if (n) {
          if (cur && delta <= r.length) for (let k = r.length - delta; k < r.length; k++) n[r[k]]++;
          else if (!cur) for (let c = 0; c < CELLS; c++) n[c] += snap.data[c];
          else this.countsCache = null;
        }
      }

      if (msg.found) {
        const f = msg.found;
        if (!this.found || f.atTick < this.found.atTick || (f.atTick === this.found.atTick && f.by < this.found.by)) {
          if (!this.found && this.role === "base") this.informedVia = { from: msg.from, mode: msg.mode };
          this.found = f;
        }
      }
      this.baseKnowsFound ||= msg.baseKnowsFound;

      for (const j in msg.intents) {
        if (j === this.id) continue;
        const e = msg.intents[j];
        const cur = this.intents.get(j);
        if (!cur || e.originTick > cur.originTick) this.intents.set(j, { ...e, heard: this.tick });
      }

      if (msg.assign && (!this.assign || msg.assign.baseTick > this.assign.baseTick)) {
        this.assign = { ...msg.assign, heard: this.tick };
        this.ordersHeardAt = this.pos;
      }
    }
    for (const [peer, t] of this.lastPacket) if (this.tick - t > 16) this.links[peer] = "stale";
  }

  // ------------------------------------------------------------------ helpers
  counts(): Uint16Array {
    if (this.countsCache) return this.countsCache;
    const n = (this.countsBuf ??= new Uint16Array(CELLS));
    n.set(this.own);
    for (const s of this.others.values()) {
      const d = s.data;
      for (let c = 0; c < CELLS; c++) n[c] += d[c];
    }
    this.countsCache = n;
    return n;
  }

  private belief(): { b: Float64Array; max: number } {
    const b = SCRATCH_BELIEF.fill(0);
    if (this.found) {
      b[this.found.cell] = 1;
      return { b, max: 1 };
    }
    const n = this.counts();
    const prior = this.w.prior;
    let sum = 0;
    for (let c = 0; c < CELLS; c++) sum += b[c] = prior[c] * MISS![n[c]];
    let max = 0;
    if (sum > 0) for (let c = 0; c < CELLS; c++) if ((b[c] /= sum) > max) max = b[c];
    return { b, max };
  }

  private fade(heard: number): number {
    const age = this.tick - heard;
    if (age <= 30) return 1;
    return Math.max(0, 1 - (age - 30) / 60);
  }

  private sinceHeard(id: AgentId): number {
    const t = this.lastHeard.get(id);
    return t === undefined ? Infinity : this.tick - t;
  }

  private sinceHeardAnyone(): number {
    let best = Infinity;
    for (const t of this.lastHeard.values()) best = Math.min(best, this.tick - t);
    return best;
  }

  /** Best-scoring search cell. With claims (ridgeline), avoids teammates' intended areas. */
  private chooseSearch(useClaims: boolean, from: CellIdx = this.pos, exclude?: (c: number) => boolean) {
    const { b, max } = this.belief();
    const claim = SCRATCH_CLAIM.fill(0);
    const claimer = SCRATCH_CLAIMER;
    const claimIds: AgentId[] = [];
    if (useClaims) {
      for (const [j, e] of this.intents) {
        if (j === "BASE") continue;
        const f = this.fade(e.heard);
        if (f <= 0) continue;
        const k = claimIds.push(j) - 1;
        const tx = cx(e.target), ty = cy(e.target);
        for (let y = Math.max(0, ty - 3); y <= Math.min(GRID - 1, ty + 3); y++)
          for (let x = Math.max(0, tx - 3); x <= Math.min(GRID - 1, tx + 3); x++) {
            const c = y * GRID + x;
            if (f > claim[c]) {
              claim[c] = f;
              claimer[c] = k;
            }
          }
      }
    }
    const elev = this.elev;
    const e0 = elev[from];
    const mu = MU * max;
    scoreCells(b, claim, elev, e0, mu, cx(from), cy(from), exclude);
    const best = SCORE_OUT[0], raw = SCORE_OUT[1];
    let avoiding: string | null = null;
    if (useClaims && raw >= 0 && raw !== best && claim[raw] > 0) {
      const j = claimIds[claimer[raw]];
      avoiding = `avoiding ${j} near ${fmtCell(this.intents.get(j)!.target)}`;
    }
    return { cell: best, belief: best >= 0 ? b[best] : 0, avoiding };
  }

  // ------------------------------------------------------------------ mode
  private nextMode(): Mode {
    if (this.role === "base") return "search";
    if (this.mode === "done") return "done";
    if (this.found && this.baseKnowsFound) return this.pos === this.found.cell ? "done" : "converge";
    // Only the finder carries the news home, unless it has gone quiet (killed or cut off) for 20 ticks.
    if (
      this.found &&
      !this.baseKnowsFound &&
      this.sinceHeard("BASE") > 20 &&
      (this.found.by === this.id || this.mode === "messenger" || this.sinceHeard(this.found.by) > 20)
    )
      return "messenger";
    if (this.found) return "search";
    if (this.strategy === "central") {
      // Follow orders; when they go stale, finish the last order, then hold until new ones arrive.
      const t = this.assign?.assignments[this.id];
      if (t === undefined) return "hold";
      const fresh = this.tick - this.assign!.heard <= 15;
      if (fresh) return "search";
      if (this.mode === "hold" || this.pos === t) return "hold";
      return "search";
    }
    if (this.strategy === "ridgeline" && !this.offline) {
      if (this.mode === "relay") return this.sinceHeardAnyone() <= 1 ? "search" : this.relayPeer() ? "relay" : "search";
      if (this.tick > 40 && this.sinceHeardAnyone() > 40 && this.relayPeer()) return "relay";
    }
    return "search";
  }

  private relayPeer(): { id: AgentId; target: CellIdx } | null {
    for (const [j, e] of this.intents) {
      if (j === "BASE" || this.fade(e.heard) <= 0) continue;
      if (!lineOfSight(this.w, this.pos, e.target)) return { id: j, target: e.target };
    }
    return null;
  }

  // ------------------------------------------------------------------ decide
  private decide(modeChanged: boolean) {
    const reached = this.target !== null && this.pos === this.target;
    let conflict = false;
    if (this.strategy === "ridgeline" && this.mode === "search" && this.target !== null && !this.found) {
      for (const [j, e] of this.intents)
        if (j !== "BASE" && j < this.id && this.tick - e.heard <= 2 && cheb(e.target, this.target) <= 3) conflict = true;
    }
    const central = this.strategy === "central" && (this.mode === "search" || this.mode === "hold") && !this.found;
    if (!central && !modeChanged && !reached && !conflict && this.target !== null && this.tick - this.planTick < 10) return;
    this.planTick = this.tick;

    switch (this.mode) {
      case "hold": {
        const since = this.assign ? this.tick - this.assign.heard : this.tick;
        const back = this.ordersHeardAt ?? this.w.base;
        if (since > 30 && this.pos !== back) {
          this.target = back;
          this.reason = `HOLD: no orders for ${since} ticks · falling back to ${fmtCell(back)}`;
        } else {
          this.target = null;
          this.reason = `HOLD: no orders from base for ${since} ticks`;
        }
        return;
      }
      case "messenger": {
        const f = this.found!;
        let t = this.w.base;
        if (this.heardBaseAt !== null && dist(this.pos, this.heardBaseAt) < dist(this.pos, t)) t = this.heardBaseAt;
        this.target = t;
        const since = this.sinceHeard("BASE");
        this.reason = `MESSENGER → base: found at ${fmtCell(f.cell)}, base not heard ${
          since === Infinity ? "yet" : `for ${since} ticks`
        }`;
        return;
      }
      case "converge":
        this.target = this.found!.cell;
        this.reason = `CONVERGE → casualty at ${fmtCell(this.found!.cell)} · base confirmed`;
        return;
      case "done":
        this.target = null;
        this.reason = `ON SCENE at ${fmtCell(this.pos)}`;
        return;
      case "relay": {
        const peer = this.relayPeer()!;
        let best = this.pos, bestS = -Infinity, fallback = this.pos, fallbackE = -Infinity;
        const px = cx(this.pos), py = cy(this.pos);
        for (let y = Math.max(0, py - 6); y <= Math.min(GRID - 1, py + 6); y++)
          for (let x = Math.max(0, px - 6); x <= Math.min(GRID - 1, px + 6); x++) {
            const c = y * GRID + x;
            const e = this.w.elevation[c];
            if (e > fallbackE) {
              fallbackE = e;
              fallback = c;
            }
            if (!lineOfSight(this.w, c, peer.target)) continue;
            const s = e - 3 * cheb(this.pos, c);
            if (s > bestS) {
              bestS = s;
              best = c;
            }
          }
        this.target = bestS > -Infinity ? best : fallback;
        this.reason = `RELAY → ridge ${fmtCell(this.target)}: restoring link to ${peer.id}`;
        return;
      }
    }

    // search
    if (this.role === "base") {
      this.target = null;
      if (this.strategy === "central") return; // planner sets reason
      const heard = [...this.lastHeard.values()].filter((t) => this.tick - t <= 20).length;
      this.reason = this.found
        ? `CASUALTY CONFIRMED at ${fmtCell(this.found.cell)}${this.informedVia ? ` via ${this.informedVia.from}` : ""}`
        : `LISTENING · ${heard} teammate${heard === 1 ? "" : "s"} in contact`;
      return;
    }
    if (this.found) {
      this.target = this.found.cell;
      this.reason = `→ casualty at ${fmtCell(this.found.cell)} · waiting for base to confirm`;
      return;
    }
    if (this.strategy === "central") {
      const t = this.assign!.assignments[this.id];
      this.target = t;
      const age = this.tick - this.assign!.heard;
      this.reason = `ORDERS → ${fmtCell(t)} from base · ${age > 15 ? `no update for ${age} ticks` : `${age} ticks old`}`;
      return;
    }
    const pick = this.chooseSearch(this.strategy === "ridgeline");
    this.target = pick.cell >= 0 ? pick.cell : this.pos;
    const parts = [`→ ${fmtCell(this.target)} belief ${pct(pick.belief)}`, `${cheb(this.pos, this.target)} cells`];
    if (pick.avoiding) parts.push(pick.avoiding);
    this.reason = parts.join(" · ").slice(0, 90);
  }

  /** Central BASE planner: greedy assignment every 5 ticks. */
  private planCentral() {
    if (this.tick % 5 !== 0) return;
    const fresh = [...this.intents.entries()]
      .filter(([j, e]) => j !== "BASE" && this.tick - e.heard <= 20)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const assignments: Record<AgentId, CellIdx> = {};
    const chosen: CellIdx[] = [];
    for (const [j, e] of fresh) {
      const pick = this.chooseSearch(false, e.target, (c) => chosen.some((a) => cheb(a, c) <= 3));
      if (pick.cell < 0) continue;
      assignments[j] = pick.cell;
      chosen.push(pick.cell);
    }
    this.assign = { assignments, baseTick: this.tick, heard: this.tick };
    const total = new Set([...this.intents.keys()].filter((j) => j !== "BASE")).size;
    this.reason = this.found
      ? `PLANNER: casualty confirmed at ${fmtCell(this.found.cell)}`
      : `PLANNER: assigned ${fresh.length} searcher${fresh.length === 1 ? "" : "s"} · ${total - fresh.length} out of contact`;
  }

  // ------------------------------------------------------------------ act
  private move() {
    if (this.waitTicks > 0) {
      this.waitTicks--;
      return false;
    }
    if (this.target === null || this.target === this.pos) return false;
    const px = cx(this.pos), py = cy(this.pos);
    const e0 = this.w.elevation[this.pos];
    let best = this.pos, bestD = Infinity, bestDe = Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = px + dx, y = py + dy;
        if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
        const c = y * GRID + x;
        const d = Math.round(dist(c, this.target) * 100);
        const de = Math.abs(this.w.elevation[c] - e0);
        if (d < bestD || (d === bestD && de < bestDe)) {
          best = c;
          bestD = d;
          bestDe = de;
        }
      }
    this.pos = best;
    if (bestDe > 30) this.waitTicks = 1;
    return true;
  }

  private sweep() {
    const c = this.pos;
    if (this.own[c] < 255) this.own[c]++;
    else this.countsCache = null;
    this.ownV++;
    this.ownRecent.push(c);
    if (this.ownRecent.length > 64) this.ownRecent.shift();
    this.stats.sweeps++;
    if (this.countOwnDuplicates && this.tick - this.lastSwept[c] <= 30) this.stats.duplicateSweeps++;
    this.sweptCell = c;
    this.lastSwept[c] = this.tick;
    if (this.countsCache) this.countsCache[c]++;
    if (this.canDetect && !this.found && this.isCasualty(c) && this.rng() < this.w.pod) {
      this.found = { cell: c, by: this.id, atTick: this.tick };
      this.foundSelf = true;
    }
  }

  /** One tick after receive(): mode → decide → move → sweep. Returns the outgoing message. */
  act(): WireState {
    const prev = this.mode;
    this.sweptCell = -1;
    this.mode = this.nextMode();
    if (this.role === "base" && this.strategy === "central") this.planCentral();
    this.decide(this.mode !== prev);

    if (this.role === "searcher") {
      const waiting = this.waitTicks > 0;
      this.move();
      if (this.mode === "converge" && this.found && this.pos === this.found.cell) {
        this.mode = "done";
        this.reason = `ON SCENE at ${fmtCell(this.pos)}`;
        this.target = null;
      }
      if (!waiting && this.mode !== "hold" && this.mode !== "done") this.sweep();
    } else if (this.found) {
      this.baseKnowsFound = true;
    }

    this.path.push(this.pos);
    if (this.path.length > 30) this.path.shift();

    if (this.ownSnap.v !== this.ownV)
      this.ownSnap = { v: this.ownV, data: this.own.slice(), recent: Int32Array.from(this.ownRecent) };

    const tables: Record<AgentId, TableSnap> = {};
    if (this.role === "searcher") tables[this.id] = this.ownSnap;
    for (const [j, s] of this.others) tables[j] = s;
    const intents: Record<AgentId, IntentEntry> = {};
    for (const [j, e] of this.intents) intents[j] = { target: e.target, originTick: e.originTick };
    intents[this.id] = { target: this.target ?? this.pos, originTick: this.tick };

    const msg: WireState = {
      from: this.id,
      role: this.role,
      tick: this.tick,
      pos: this.pos,
      mode: this.mode,
      tables,
      found: this.found,
      baseKnowsFound: this.baseKnowsFound,
      intents,
      assign: this.assign ? { assignments: this.assign.assignments, baseTick: this.assign.baseTick } : null,
    };
    this.tick++;
    return msg;
  }
}
