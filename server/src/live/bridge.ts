// The bridge ONLY WATCHES. It launches the agent processes, forwards their telemetry to
// browsers, and relays fault injection (storm, blackout, radio, kill, pause, speed). It never
// sends an agent a target or any state.
//
//   bun src/live/bridge.ts
//
// Env: PORT (4000), RIDGELINE_KEY (presenter key; unset = anyone can control),
//      CORS_ORIGINS (comma list; default http://localhost:3000).

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  CELLS,
  CONTRACT_VERSION,
  type AgentId,
  type ClientCommand,
  type ControlMsg,
  type LinkStatus,
  type Metrics,
  type SimEvent,
  type SimStatus,
  type Strategy,
  type Telemetry,
  type WorldMsg,
} from "../../../web/lib/contract";
import { decodeB64 } from "../../../web/lib/sim/util";
import { generateWorld, SEARCHER_IDS } from "../../../web/lib/sim/world";
import type { AgentConfig, ControlPacket, TelemetryPacket } from "./agent-process";
import { channel, PORTS, unpack } from "./wire";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(here, "agent-process.ts");
const RUNNER_SCRIPT = path.join(here, "runner.ts");
const RESULTS = path.join(here, "../../results.json");
const PORT = Number(process.env.PORT ?? 4000);
const KEY = process.env.RIDGELINE_KEY ?? "";
const ORIGINS = (process.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim());
const STALE_MS = 3000;
const STRATEGIES: Strategy[] = ["ridgeline", "independent", "central"];

// ---------------------------------------------------------------------------- sim state
let cfg = { seed: 39, strategy: "ridgeline" as Strategy, agents: 5 };
let runId = 0;
let running = false;
let storm = 0;
let blackout = false;
let tickMs = 250;
let world: WorldMsg;
const children = new Map<AgentId, ChildProcess>();
const latest = new Map<AgentId, { tel: Telemetry; at: number }>();
const ownTables = new Map<AgentId, string>(); // each searcher's own sweeps; kept after it dies (truth view)
const gone = new Set<AgentId>();
let foundAtTick: number | null = null;
let baseKnewAtTick: number | null = null;
const pairs = new Map<string, { linked: boolean | null; lastOk: number }>();

// ---------------------------------------------------------------------------- transport
const control = await channel(PORTS.control);
const sendControl = (c: ControlMsg) => control.send({ ...c, runId } satisfies ControlPacket);

await channel(PORTS.telemetry, (buf) => {
  const p = unpack<TelemetryPacket>(buf);
  if (!p || p.type !== "telemetry" || p.runId !== runId) return;
  const tel = p.tel;
  if (gone.has(tel.id)) return;
  latest.set(tel.id, { tel, at: Date.now() });
  if (tel.role === "searcher" && tel.sweeps[tel.id]) ownTables.set(tel.id, tel.sweeps[tel.id]);
  if (tel.found && foundAtTick === null && tel.found.by === tel.id) {
    foundAtTick = tel.found.atTick;
    const c = tel.found.cell;
    emitEvent({ kind: "found", agent: tel.id, text: `${tel.id} FOUND the casualty at (${c % 40},${Math.floor(c / 40)})` });
  }
  if (tel.role === "base" && tel.baseKnowsFound && baseKnewAtTick === null) {
    baseKnewAtTick = tel.tick;
    const via = tel.reason.match(/via (\w+)/)?.[1];
    emitEvent({ kind: "base_informed", agent: via, text: via ? `Base informed via ${via}` : "Base informed" });
  }
});

// ---------------------------------------------------------------------------- launcher
function killAll() {
  for (const c of children.values()) c.kill("SIGTERM");
  children.clear();
}

function launch() {
  killAll();
  runId++;
  latest.clear();
  ownTables.clear();
  gone.clear();
  pairs.clear();
  foundAtTick = baseKnewAtTick = null;
  for (const s of io?.sockets.sockets.values() ?? []) s.data.sent = new Map();

  const w = generateWorld(cfg.seed);
  world = { ...w, runId, contractVersion: CONTRACT_VERSION };
  const salt = randomBytes(8).toString("hex");
  const hash = createHash("sha256").update(`${w.casualty}:${salt}`).digest("hex");
  const ids: AgentId[] = ["BASE", ...SEARCHER_IDS.slice(0, cfg.agents)];
  for (const id of ids) {
    const ac: AgentConfig = {
      id,
      role: id === "BASE" ? "base" : "searcher",
      strategy: cfg.strategy,
      seed: cfg.seed,
      runId,
      hash,
      salt,
      tickMs,
      storm,
      blackout,
      running,
    };
    const child = spawn(process.execPath, [AGENT_SCRIPT, JSON.stringify(ac)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    children.set(id, child);
    child.on("exit", () => {
      if (children.get(id) === child) children.delete(id);
    });
  }
  io?.emit("world", world);
  emitEvent({ kind: "reset", text: `Reset · seed ${cfg.seed} · ${cfg.strategy} · ${cfg.agents} agents` });
}

// ---------------------------------------------------------------------------- observer metrics
function liveAgents(now = Date.now()): Telemetry[] {
  const out: Telemetry[] = [];
  for (const [id, v] of latest) {
    if (now - v.at > STALE_MS) {
      latest.delete(id);
      if (!gone.has(id)) {
        gone.add(id);
        emitEvent({ kind: "agent_killed", agent: id, text: `${id} went silent — no telemetry for 3 s` });
      }
      continue;
    }
    out.push(v.tel);
  }
  return out;
}

function metrics(agents: Telemetry[]): Metrics {
  const n = new Uint16Array(CELLS);
  for (const b64 of ownTables.values()) {
    const d = decodeB64(b64, CELLS);
    for (let c = 0; c < CELLS; c++) n[c] += d[c];
  }
  let prob = 0, cells = 0;
  for (let c = 0; c < CELLS; c++)
    if (n[c]) {
      cells++;
      prob += world.prior[c] * (1 - Math.pow(1 - world.pod, n[c]));
    }
  return {
    tick: agents.reduce((m, a) => Math.max(m, a.tick), 0),
    probSearched: prob,
    cellsSwept: cells,
    duplicateSweeps: agents.reduce((s, a) => s + a.stats.duplicateSweeps, 0),
    foundAtTick,
    baseKnewAtTick,
  };
}

const RANK: Record<LinkStatus, number> = { ok: 5, storm: 4, terrain: 3, range: 2, stale: 1, off: 0 };
/** Pair-level link events, debounced 1 s. */
function trackLinks(agents: Telemetry[], now: number) {
  for (let i = 0; i < agents.length; i++)
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j];
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const key = `${x}|${y}`;
      let p = pairs.get(key);
      if (!p) pairs.set(key, (p = { linked: null, lastOk: 0 }));
      const la = a.links[b.id], lb = b.links[a.id];
      const ok = la === "ok" || lb === "ok";
      if (ok) p.lastOk = now;
      const name = (id: string) => (id === "BASE" ? "Base" : id);
      if (p.linked === null) p.linked = ok;
      else if (p.linked && now - p.lastOk > 1000) {
        p.linked = false;
        const why = [la, lb].filter(Boolean).sort((m, n) => RANK[n!] - RANK[m!])[0] ?? "stale";
        emitEvent({ kind: "peer_lost", agent: x, peer: y, text: `${name(x)} ⇄ ${name(y)} link lost (${why})` });
      } else if (!p.linked && ok) {
        p.linked = true;
        emitEvent({ kind: "peer_joined", agent: x, peer: y, text: `${name(x)} ⇄ ${name(y)} link restored` });
      }
    }
}

function status(): SimStatus {
  return { runId, running, strategy: cfg.strategy, seed: cfg.seed, agentCount: cfg.agents, storm, blackout, tickMs };
}

function emitEvent(e: Omit<SimEvent, "t" | "runId">) {
  io?.emit("event", { ...e, t: Date.now(), runId } satisfies SimEvent);
}

// ---------------------------------------------------------------------------- commands
function isPresenter(s: Socket) {
  return !KEY || s.data.presenter === true;
}

function handle(cmd: ClientCommand) {
  switch (cmd.action) {
    case "start":
      running = true;
      if (!children.size) launch();
      sendControl({ type: "resume" });
      break;
    case "pause":
      running = false;
      sendControl({ type: "pause" });
      break;
    case "reset":
      if (cmd.seed !== undefined && Number.isFinite(cmd.seed)) cfg.seed = Math.trunc(cmd.seed);
      if (cmd.strategy && STRATEGIES.includes(cmd.strategy)) cfg.strategy = cmd.strategy;
      if (cmd.agents !== undefined) cfg.agents = Math.max(3, Math.min(6, Math.trunc(cmd.agents)));
      running = false;
      blackout = false; // like the mock: a reset clears the blackout but keeps the storm
      launch();
      break;
    case "storm":
      storm = Math.max(0, Math.min(0.9, Number(cmd.value) || 0));
      sendControl({ type: "storm", value: storm });
      emitEvent({ kind: "storm", text: `Storm set to ${Math.round(storm * 100)}% radio packet loss` });
      break;
    case "blackout":
      if (blackout === !!cmd.value) break;
      blackout = !!cmd.value;
      sendControl({ type: "blackout", value: blackout });
      emitEvent({ kind: "blackout", text: blackout ? "RADIO BLACKOUT — every agent is on its own" : "Blackout lifted — radios back on" });
      break;
    case "radio":
      if (!latest.has(cmd.agent)) break;
      sendControl({ type: "radio", agent: cmd.agent, value: !!cmd.value });
      emitEvent({ kind: "radio", agent: cmd.agent, text: `${cmd.agent} radio switched ${cmd.value ? "on" : "off"}` });
      break;
    case "kill": {
      if (cmd.agent === "BASE" || !latest.has(cmd.agent)) break;
      sendControl({ type: "kill", agent: cmd.agent });
      children.get(cmd.agent)?.kill("SIGTERM");
      gone.add(cmd.agent);
      latest.delete(cmd.agent);
      emitEvent({ kind: "agent_killed", agent: cmd.agent, text: `${cmd.agent} lost — agent killed` });
      break;
    }
    case "speed":
      tickMs = Math.max(50, Math.min(1000, Math.trunc(Number(cmd.tickMs) || 250)));
      sendControl({ type: "speed", tickMs });
      break;
  }
}

// ---------------------------------------------------------------------------- HTTP + Socket.IO
let compareJob: ChildProcess | null = null;

const server = http.createServer((req, res) => {
  const origin = req.headers.origin ?? "";
  if (ORIGINS.includes(origin) || ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-ridgeline-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  const json = (code: number, body: unknown) =>
    res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  const url = (req.url ?? "/").split("?")[0];

  if (url === "/health") return json(200, { ok: true, runId, agents: latest.size, running });
  if (url === "/api/world") return json(200, world);
  if (url === "/api/results" && req.method === "GET") {
    if (!existsSync(RESULTS)) return json(404, { error: "no results yet" });
    return res.writeHead(200, { "content-type": "application/json" }).end(readFileSync(RESULTS));
  }
  if (url === "/api/compare" && req.method === "POST") {
    if (KEY && req.headers["x-ridgeline-key"] !== KEY) return json(403, { error: "presenter key required" });
    if (compareJob) return json(409, { error: "already running" });
    compareJob = spawn(process.execPath, [RUNNER_SCRIPT, RESULTS], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    compareJob.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines)
        try {
          io.emit("compare:progress", JSON.parse(l));
        } catch {}
    });
    compareJob.on("exit", () => (compareJob = null));
    return json(202, { started: true });
  }
  json(404, { error: "not found" });
});

const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ["GET", "POST"] },
  perMessageDeflate: { threshold: 1024 },
});

io.on("connection", (socket) => {
  socket.data.presenter = !KEY || socket.handshake.auth?.key === KEY;
  socket.data.sent = new Map<string, string>();
  socket.emit("role", { presenter: socket.data.presenter });
  socket.emit("world", world);
  socket.on("command", (cmd: ClientCommand) => {
    if (!isPresenter(socket)) return socket.emit("role", { presenter: false });
    if (!cmd || typeof cmd !== "object" || typeof cmd.action !== "string") return;
    handle(cmd);
  });
});

// Snapshot loop, 5 Hz. Sweep tables are sent per socket only when they changed (delta).
setInterval(() => {
  const now = Date.now();
  const agents = liveAgents(now);
  trackLinks(agents, now);
  const m = metrics(agents);
  const st = status();
  for (const socket of io.sockets.sockets.values()) {
    const sent: Map<string, string> = socket.data.sent;
    const out = agents.map((a) => {
      const sweeps: Record<AgentId, string> = {};
      for (const t in a.sweeps) {
        const k = `${a.id}/${t}`;
        if (sent.get(k) !== a.sweeps[t]) {
          sweeps[t] = a.sweeps[t];
          sent.set(k, a.sweeps[t]);
        }
      }
      return { ...a, sweeps };
    });
    socket.emit("snapshot", { t: now, status: st, agents: out, metrics: m });
  }
}, 200);

launch(); // boot paused at tick 0
server.listen(PORT, () => console.log(`[bridge] listening on :${PORT} · presenter key ${KEY ? "required" : "off"}`));

const shutdown = () => {
  killAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
