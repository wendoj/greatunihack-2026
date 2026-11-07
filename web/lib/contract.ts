// Shared contract — must match the backend exactly (frontend.md §2). Do not edit casually.
/** Bump on any breaking change. The bridge sends it in `world`; the client warns on mismatch. */
export const CONTRACT_VERSION = 2;

export const GRID = 40;                       // 40×40 cells
export const CELLS = GRID * GRID;             // 1600
export type CellIdx = number;                 // y * GRID + x
export const idx = (x: number, y: number): CellIdx => y * GRID + x;
export const xy = (i: CellIdx): [number, number] => [i % GRID, Math.floor(i / GRID)];

export type AgentId = string;                 // 'A'..'F' for searchers, 'BASE' for the base station
export type Role = 'searcher' | 'base';
export type Strategy = 'ridgeline' | 'independent' | 'central';
export type Mode = 'search' | 'messenger' | 'relay' | 'hold' | 'converge' | 'done';
export type LinkStatus = 'ok' | 'terrain' | 'range' | 'storm' | 'off' | 'stale';

export interface WorldPublic {
  seed: number;
  size: number;                 // GRID
  cellMetres: number;           // 50
  elevation: number[];          // CELLS values, metres (≈ 250–650)
  isPath: boolean[];            // CELLS
  isStream: boolean[];          // CELLS
  prior: number[];              // CELLS, sums to 1
  lkp: CellIdx;                 // last known position
  base: CellIdx;                // base station cell (map edge)
  starts: Record<AgentId, CellIdx>;
  radio: { rangeCells: number; antennaM: number };   // 12, 2
  pod: number;                  // probability of detection per sweep, 0.8
}

export interface Found { cell: CellIdx; by: AgentId; atTick: number }

/** Sweep counts: for each agent, a base64-encoded Uint8Array(CELLS) of how many times that agent swept each cell (capped at 255). */
export type SweepTable = Record<AgentId, string>;

export interface IntentEntry { target: CellIdx; originTick: number }   // originTick = the planning agent's own tick counter

/** Peer-to-peer gossip message (UDP, state channel). */
export interface StateMsg {
  type: 'state';
  from: AgentId;
  role: Role;
  tick: number;                 // sender's own tick counter
  pos: CellIdx;                 // used by the RECEIVER's radio check
  sweeps: SweepTable;           // sender's merged view, including relayed knowledge
  found: Found | null;
  baseKnowsFound: boolean;      // true once BASE has confirmed the find
  intents: Record<AgentId, IntentEntry>;
}

/** Central strategy only: BASE → searchers. */
export interface AssignMsg {
  type: 'assign';
  from: 'BASE';
  pos: CellIdx;
  tick: number;
  assignments: Record<AgentId, CellIdx>;
}

/** Fault injection (UDP control channel; never radio-filtered). Environment only, never goals. */
export type ControlMsg =
  | { type: 'storm'; value: number }                 // 0..0.9 packet-loss probability
  | { type: 'blackout'; value: boolean }             // all radios off
  | { type: 'radio'; agent: AgentId; value: boolean } // one agent's radio on/off
  | { type: 'kill'; agent: AgentId }
  | { type: 'pause' } | { type: 'resume' }
  | { type: 'speed'; tickMs: number };               // 50..1000

/** Agent → bridge (UDP telemetry channel). Observation only: no agent ever reads these. */
export interface Telemetry {
  id: AgentId;
  role: Role;
  strategy: Strategy;
  tick: number;
  pos: CellIdx;
  target: CellIdx | null;
  path: CellIdx[];              // last 30 positions, for trails
  mode: Mode;
  reason: string;               // e.g. "→ (12,7): belief 4.1%, 6 cells; avoiding C's area near (20,9)"
  radioOn: boolean;
  links: Record<AgentId, LinkStatus>;   // result of the last packet from each peer
  lastHeard: Record<AgentId, number>;   // ms since that peer was last heard
  /** This agent's merged view. Bridge → browser only: a missing key means "unchanged since your last snapshot". */
  sweeps: SweepTable;
  found: Found | null;
  baseKnowsFound: boolean;
  stats: { sweeps: number; duplicateSweeps: number };
}

// ---------- Bridge ↔ browser (Socket.IO) ----------
export interface Metrics {
  tick: number;                  // max tick seen
  probSearched: number;          // 0..1, from the union of all agents' sweeps (truth view)
  cellsSwept: number;
  duplicateSweeps: number;
  foundAtTick: number | null;
  baseKnewAtTick: number | null;
}
export interface SimStatus {
  runId: number;                 // changes on every reset; drop data from other runs
  running: boolean;
  strategy: Strategy;
  seed: number;
  agentCount: number;
  storm: number;
  blackout: boolean;
  tickMs: number;
}
export interface Snapshot { t: number; status: SimStatus; agents: Telemetry[]; metrics: Metrics }
export interface SimEvent { t: number; runId?: number; kind: 'found' | 'base_informed' | 'peer_lost' | 'peer_joined' | 'agent_killed' | 'radio' | 'storm' | 'blackout' | 'reset'; agent?: AgentId; peer?: AgentId; text: string }

export type ClientCommand =
  | { action: 'start' } | { action: 'pause' }
  | { action: 'reset'; seed?: number; strategy?: Strategy; agents?: number }   // agents 3..6
  | { action: 'storm'; value: number }
  | { action: 'blackout'; value: boolean }
  | { action: 'radio'; agent: AgentId; value: boolean }
  | { action: 'kill'; agent: AgentId }
  | { action: 'speed'; tickMs: number };

/** Payload of the 'world' Socket.IO event. */
export type WorldMsg = WorldPublic & { casualty: CellIdx; runId: number; contractVersion: number };

// Socket.IO event names
//   server → client: 'world' (WorldMsg), 'role' ({ presenter: boolean }), 'snapshot' (Snapshot, ~5 Hz), 'event' (SimEvent), 'compare:progress' ({done,total})
//   client → server: 'command' (ClientCommand)

export interface CompareResults {
  generatedAt: string;
  seeds: number[];
  storms: number[];              // [0, 0.3, 0.6, 0.9]
  maxTicks: number;              // 1500
  runs: Array<{
    strategy: Strategy; storm: number; seed: number;
    foundAtTick: number | null; baseKnewAtTick: number | null;
    duplicateSweeps: number; totalSweeps: number;
    probSearched: number[];      // sampled every 10 ticks, length maxTicks/10
  }>;
  summary: Array<{
    strategy: Strategy; storm: number;
    medianTimeToFind: number;    // capped runs count as maxTicks
    medianTimeToBase: number;
    foundRate: number;           // 0..1
    meanDuplicateRate: number;   // duplicate / total
    meanProbSearched: number[];  // mean curve, every 10 ticks
  }>;
}
