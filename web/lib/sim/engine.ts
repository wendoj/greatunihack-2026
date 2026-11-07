import {
  CELLS,
  type AgentId,
  type ControlMsg,
  type LinkStatus,
  type Metrics,
  type SimEvent,
  type Strategy,
  type SweepTable,
  type Telemetry,
} from "../contract";
import { SimAgent, type Packet, type WireState } from "./agent";
import { canHear } from "./radio";
import { encodeB64, fmtCell, hashStr, mulberry32 } from "./util";
import { generateWorld, SEARCHER_IDS, type WorldFull } from "./world";

export type EngineEvent = Omit<SimEvent, "t">;

const encCache = new WeakMap<Uint8Array, string>();
const enc = (u8: Uint8Array) => {
  let s = encCache.get(u8);
  if (!s) encCache.set(u8, (s = encodeB64(u8)));
  return s;
};

const RANK: Record<LinkStatus, number> = { ok: 5, storm: 4, terrain: 3, range: 2, stale: 1, off: 0 };

export class SimEngine {
  readonly world: WorldFull;
  readonly strategy: Strategy;
  readonly seed: number;
  agents: SimAgent[];
  tick = 0;
  storm = 0;
  blackout = false;
  foundAtTick: number | null = null;
  baseKnewAtTick: number | null = null;
  private outbox: WireState[] = [];
  private rng: () => number;
  private events: EngineEvent[] = [];
  private pairs = new Map<string, { linked: boolean | null; lastOk: number }>();
  private trackEvents: boolean;
  /** Truth-side record of when each cell was last swept by anyone (for duplicate counts). */
  private lastSwept = new Int32Array(CELLS).fill(-9999);

  constructor(opts: { seed: number; strategy: Strategy; agents: number; trackEvents?: boolean; detect?: boolean }) {
    this.seed = opts.seed;
    this.strategy = opts.strategy;
    this.trackEvents = opts.trackEvents ?? true;
    this.world = generateWorld(opts.seed);
    this.rng = mulberry32(opts.seed * 31 + 7);
    const casualty = this.world.casualty;
    const isCasualty = (c: number) => c === casualty;
    const ids = ["BASE", ...SEARCHER_IDS.slice(0, Math.max(3, Math.min(6, opts.agents)))];
    this.agents = ids.map(
      (id) =>
        new SimAgent({
          id,
          role: id === "BASE" ? "base" : "searcher",
          strategy: opts.strategy,
          world: this.world,
          rng: mulberry32(opts.seed ^ hashStr(id)),
          isCasualty,
        }),
    );
    if (opts.detect === false) for (const a of this.agents) a.canDetect = false;
  }

  get(id: AgentId) {
    return this.agents.find((a) => a.id === id);
  }

  private emit(e: EngineEvent) {
    if (this.trackEvents) this.events.push(e);
  }

  drainEvents(): EngineEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  step() {
    const alive = this.agents.filter((a) => a.alive);
    for (const a of alive) a.offline = !a.radioOn || this.blackout;

    // 1. Deliver last tick's messages; each receiver does its own radio check.
    const senders = new Map(alive.map((a) => [a.id, a]));
    for (const r of alive) {
      const packets: Packet[] = [];
      for (const msg of this.outbox) {
        if (msg.from === r.id) continue;
        const s = senders.get(msg.from);
        if (!s) continue;
        const link: LinkStatus =
          r.offline || s.offline ? "off" : canHear(this.world, msg.pos, r.pos, this.storm, this.rng);
        packets.push({ msg, link });
      }
      r.receive(packets);
    }
    if (this.trackEvents) this.trackPairs(alive);

    // 2. Every agent acts on its own private state.
    this.outbox = alive.map((a) => a.act());
    for (const a of alive) {
      const c = a.sweptCell;
      if (c < 0) continue;
      if (this.tick - this.lastSwept[c] <= 30) a.stats.duplicateSweeps++;
      this.lastSwept[c] = this.tick;
    }

    for (const a of alive) {
      if (a.foundSelf && this.foundAtTick === null && a.found?.by === a.id) {
        this.foundAtTick = this.tick;
        this.emit({ kind: "found", agent: a.id, text: `${a.id} FOUND the casualty at ${fmtCell(a.found.cell)}` });
      }
    }
    const base = this.get("BASE");
    if (base && base.baseKnowsFound && this.baseKnewAtTick === null) {
      this.baseKnewAtTick = this.tick;
      const via = base.informedVia;
      this.emit({
        kind: "base_informed",
        agent: via?.from,
        text: via ? `Base informed via ${via.from} (${via.mode})` : "Base informed",
      });
    }
    this.tick++;
  }

  private trackPairs(alive: SimAgent[]) {
    for (let i = 0; i < alive.length; i++)
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        let p = this.pairs.get(key);
        if (!p) this.pairs.set(key, (p = { linked: null, lastOk: -999 }));
        const la = a.links[b.id], lb = b.links[a.id];
        const ok = la === "ok" || lb === "ok";
        if (ok) p.lastOk = this.tick;
        const [x, y] = key.split("|");
        const name = (id: string) => (id === "BASE" ? "Base" : id);
        if (p.linked === null) {
          p.linked = ok;
        } else if (p.linked && this.tick - p.lastOk > 5) {
          p.linked = false;
          const why = [la, lb].filter(Boolean).sort((m, n) => RANK[n!] - RANK[m!])[0] ?? "stale";
          if (!this.blackout)
            this.emit({ kind: "peer_lost", agent: x, peer: y, text: `${name(x)} ⇄ ${name(y)} link lost (${why})` });
        } else if (!p.linked && ok) {
          p.linked = true;
          this.emit({ kind: "peer_joined", agent: x, peer: y, text: `${name(x)} ⇄ ${name(y)} link restored` });
        }
      }
  }

  control(cmd: ControlMsg) {
    switch (cmd.type) {
      case "storm":
        this.storm = Math.max(0, Math.min(0.9, cmd.value));
        this.emit({ kind: "storm", text: `Storm set to ${Math.round(this.storm * 100)}% radio packet loss` });
        break;
      case "blackout":
        if (this.blackout === cmd.value) break;
        this.blackout = cmd.value;
        this.emit({
          kind: "blackout",
          text: cmd.value ? "RADIO BLACKOUT — every agent is on its own" : "Blackout lifted — radios back on",
        });
        break;
      case "radio": {
        const a = this.get(cmd.agent);
        if (!a || a.radioOn === cmd.value) break;
        a.radioOn = cmd.value;
        this.emit({ kind: "radio", agent: a.id, text: `${a.id} radio switched ${cmd.value ? "on" : "off"}` });
        break;
      }
      case "kill": {
        const a = this.get(cmd.agent);
        if (!a || !a.alive || a.role === "base") break;
        a.alive = false;
        this.emit({ kind: "agent_killed", agent: a.id, text: `${a.id} lost — agent killed` });
        break;
      }
    }
  }

  telemetry(tickMs: number): Telemetry[] {
    return this.agents.filter((a) => a.alive).map((a) => agentTelemetry(a, tickMs));
  }

  /** Truth view: every searcher's own table, alive or not. */
  probSearched(): { prob: number; cells: number } {
    const n = new Uint16Array(CELLS);
    for (const a of this.agents) if (a.role === "searcher") for (let c = 0; c < CELLS; c++) n[c] += a.own[c];
    const miss = 1 - this.world.pod;
    let prob = 0, cells = 0;
    for (let c = 0; c < CELLS; c++) {
      if (!n[c]) continue;
      cells++;
      prob += this.world.prior[c] * (1 - Math.pow(miss, n[c]));
    }
    return { prob, cells };
  }

  metrics(): Metrics {
    const { prob, cells } = this.probSearched();
    return {
      tick: this.tick,
      probSearched: prob,
      cellsSwept: cells,
      duplicateSweeps: this.agents.reduce((s, a) => s + a.stats.duplicateSweeps, 0),
      foundAtTick: this.foundAtTick,
      baseKnewAtTick: this.baseKnewAtTick,
    };
  }

  totals() {
    return this.agents.reduce(
      (s, a) => ({ sweeps: s.sweeps + a.stats.sweeps, dup: s.dup + a.stats.duplicateSweeps }),
      { sweeps: 0, dup: 0 },
    );
  }
}

/** Telemetry for one agent. Shared by the in-memory engine and the live agent process. */
export function agentTelemetry(a: SimAgent, tickMs: number, encode: (u8: Uint8Array) => string = enc): Telemetry {
  const sweeps: SweepTable = {};
  if (a.role === "searcher") sweeps[a.id] = encode(a.ownSnap.data);
  for (const [j, s] of a.others) sweeps[j] = encode(s.data);
  const lastHeard: Record<AgentId, number> = {};
  for (const [j, t] of a.lastHeard) lastHeard[j] = Math.max(0, (a.tick - 1 - t) * tickMs);
  return {
    id: a.id,
    role: a.role,
    strategy: a.strategy,
    tick: a.tick,
    pos: a.pos,
    target: a.target,
    path: a.path.slice(),
    mode: a.mode,
    reason: a.reason,
    radioOn: !a.offline,
    links: { ...a.links },
    lastHeard,
    sweeps,
    found: a.found,
    baseKnowsFound: a.baseKnowsFound,
    stats: { ...a.stats },
  };
}
