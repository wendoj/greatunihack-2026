// One search agent = one OS process. Private state, its own clock, its own decisions.
//
//   bun src/live/agent-process.ts '<AgentConfig JSON>'
//
// It hears teammates only over the multicast state channel, and decides for ITSELF whether it
// heard each packet (range, line of sight over its own copy of the terrain, storm draw).
// The bridge never sends it a target: the control channel carries environment faults only.

import { createHash } from "node:crypto";
import type { AgentId, ControlMsg, Role, Strategy, Telemetry } from "../../../web/lib/contract";
import { SimAgent, type Packet } from "../../../web/lib/sim/agent";
import { agentTelemetry } from "../../../web/lib/sim/engine";
import { canHear } from "../../../web/lib/sim/radio";
import { hashStr, mulberry32 } from "../../../web/lib/sim/util";
import { generateWorld } from "../../../web/lib/sim/world";
import { channel, encodeTable, PORTS, stateFromJson, stateToJson, unpack, type JsonState } from "./wire";

export interface AgentConfig {
  id: AgentId;
  role: Role;
  strategy: Strategy;
  seed: number;
  runId: number;
  /** sha256(`${casualtyCell}:${salt}`). The agent can recognise the casualty but never knows where it is. */
  hash: string;
  salt: string;
  tickMs: number;
  storm: number;
  blackout: boolean;
  running: boolean;
}

export type ControlPacket = ControlMsg & { runId: number };
export type TelemetryPacket = { type: "telemetry"; runId: number; tel: Telemetry };

const cfg = JSON.parse(process.argv[2]) as AgentConfig;

// Every agent builds the same map from the seed, like carrying the same printed OS map.
const { casualty: _neverUsed, ...world } = generateWorld(cfg.seed);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const isCasualty = (c: number) => sha(`${c}:${cfg.salt}`) === cfg.hash;

const agent = new SimAgent({
  id: cfg.id,
  role: cfg.role,
  strategy: cfg.strategy,
  world,
  rng: mulberry32(cfg.seed ^ hashStr(cfg.id) ^ (cfg.runId * 7919)),
  isCasualty,
});
agent.countOwnDuplicates = true;
const radioRng = mulberry32(hashStr(cfg.id) ^ (cfg.runId * 104729) ^ cfg.seed);

let { tickMs, storm, blackout, running } = cfg;
let radioOn = true;
const inbox: Packet[] = [];

const state = await channel(PORTS.state, (buf) => {
  const j = unpack<JsonState>(buf);
  if (!j || j.type !== "state" || j.runId !== cfg.runId || j.from === cfg.id) return;
  const msg = stateFromJson(j);
  // The receiver decides whether it heard the packet.
  inbox.push({ msg, link: agent.offline ? "off" : canHear(world, msg.pos, agent.pos, storm, radioRng) });
});
const telemetry = await channel(PORTS.telemetry);
await channel(PORTS.control, (buf) => {
  const c = unpack<ControlPacket>(buf);
  if (!c || c.runId !== cfg.runId) return;
  switch (c.type) {
    case "storm":
      storm = c.value;
      break;
    case "blackout":
      blackout = c.value;
      break;
    case "radio":
      if (c.agent === cfg.id) radioOn = c.value;
      break;
    case "kill":
      if (c.agent === cfg.id) process.exit(0);
      break;
    case "pause":
      running = false;
      break;
    case "resume":
      running = true;
      break;
    case "speed":
      tickMs = Math.max(50, Math.min(1000, c.tickMs));
      break;
  }
});

function sendTelemetry() {
  const tel = agentTelemetry(agent, tickMs, encodeTable);
  telemetry.send({ type: "telemetry", runId: cfg.runId, tel } satisfies TelemetryPacket);
}

function tick() {
  agent.offline = !radioOn || blackout;
  agent.receive(inbox.splice(0));
  // With our own radio off we hear nobody, so every link reads as "off" from where we stand.
  if (agent.offline) for (const p of agent.lastPacket.keys()) agent.links[p] = "off";
  const msg = agent.act();
  if (!agent.offline) state.send(stateToJson(msg, cfg.runId));
  sendTelemetry();
}

// Self-paced loop. While paused, keep a telemetry heartbeat so the bridge knows we're alive.
function loop() {
  if (running) tick();
  else sendTelemetry();
  setTimeout(loop, running ? tickMs : 500);
}
loop();

process.on("SIGTERM", () => process.exit(0));
// If the bridge dies, don't linger as an orphan.
process.on("disconnect", () => process.exit(0));
