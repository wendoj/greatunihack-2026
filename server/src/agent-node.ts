// One search agent = one OS process, connected to peers over a local mesh — no internet,
// no bridge, no central server. This is the "different transport" called out in
// ARCHITECTURE.md: devices discover each other on the local network and gossip state over a
// TCP mesh, while the receiver-side radio model still decides what was actually "heard".
//
//   bun src/agent-node.ts --id A --role searcher --seed 39 --salt <salt> --hash <hash>
//
// Every agent builds the same map from the seed (like carrying the same printed OS map) and
// recognises the casualty only through sha256(cell:salt). Share one seed/salt/hash across all
// devices; generate them once with:
//
//   bun src/agent-node.ts --gen-config --seed 39

import { createHash, randomBytes } from "node:crypto";
import readline from "node:readline";
import type { AgentId, Role, Strategy } from "../../web/lib/contract";
import { SimAgent, type Packet } from "../../web/lib/sim/agent";
import { canHear } from "../../web/lib/sim/radio";
import { hashStr, mulberry32 } from "../../web/lib/sim/util";
import { generateWorld } from "../../web/lib/sim/world";
import { stateFromJson, stateToJson, type JsonState } from "./live/wire";
import { MeshNode, type MeshMessage } from "./mesh";

interface Cfg {
  id: AgentId;
  role: Role;
  strategy: Strategy;
  seed: number;
  runId: number;
  hash: string;
  salt: string;
  tickMs: number;
  storm: number;
  blackout: boolean;
  discoveryPort: number;
  tcpPort: number;
  peers: string[];
  ttl: number;
}

const USAGE = `Ridgeline agent node — one agent, one process, joined to a local mesh.

  bun src/agent-node.ts --id A --role searcher --seed 39 --salt <salt> --hash <hash>
  bun src/agent-node.ts --gen-config --seed 39

Required for a normal run: --id, --role (searcher|base), --seed, --salt, --hash.
Key env equivalents: RIDGELINE_ID, RIDGELINE_ROLE, RIDGELINE_SEED, RIDGELINE_SALT, RIDGELINE_HASH.

Options:
  --id <A|B|C|BASE>       agent id (default: random)
  --role <searcher|base>  default searcher
  --strategy <ridgeline|independent|central>  default ridgeline
  --seed <n>              shared world seed (default 39)
  --salt <hex>            shared casualty salt
  --hash <hex>            shared sha256(cell:salt)
  --run-id <n>            shared run id for message filtering (default 0)
  --tick-ms <n>           seconds-free tick pace (default 250)
  --storm <0..0.9>        radio packet-loss rate (default 0)
  --blackout              start with all radios off
  --tcp-port <n>          fixed TCP listen port (default: ephemeral)
  --discovery-port <n>    UDP beacon port (default 41238)
  --peers <spec,spec>     static "id@host:port" peers (default: auto-discover)
  --ttl <n>               gossip hop budget (default 8)
  --gen-config            print a shared {seed,salt,hash} and exit
  --help`;

function argOf(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  if (process.argv.includes("--gen-config")) {
    const seed = Number(argOf("--seed") ?? process.env.RIDGELINE_SEED ?? 39);
    const { casualty } = generateWorld(seed);
    const salt = randomBytes(8).toString("hex");
    const hash = createHash("sha256").update(`${casualty}:${salt}`).digest("hex");
    console.log(JSON.stringify({ seed, salt, hash, runId: 0 }, null, 2));
    return;
  }

  const id = (argOf("--id") ?? process.env.RIDGELINE_ID ?? `agent-${Math.floor(Math.random() * 10000)}`) as AgentId;
  const role: Role = (argOf("--role") ?? process.env.RIDGELINE_ROLE ?? "searcher") === "base" ? "base" : "searcher";
  const strategy: Strategy =
    ((argOf("--strategy") ?? process.env.RIDGELINE_STRATEGY ?? "ridgeline") as Strategy) ?? "ridgeline";
  const seed = Number(argOf("--seed") ?? process.env.RIDGELINE_SEED ?? 39);
  const salt = argOf("--salt") ?? process.env.RIDGELINE_SALT;
  const hash = argOf("--hash") ?? process.env.RIDGELINE_HASH;
  if (!salt || !hash) {
    console.error("missing --salt/--hash. Generate a shared one with: bun src/agent-node.ts --gen-config --seed " + seed);
    process.exit(1);
  }

  const cfg: Cfg = {
    id,
    role,
    strategy,
    seed,
    runId: Number(argOf("--run-id") ?? process.env.RIDGELINE_RUN_ID ?? 0),
    hash,
    salt,
    tickMs: Math.max(20, Number(argOf("--tick-ms") ?? process.env.RIDGELINE_TICK_MS ?? 250)),
    storm: Math.max(0, Math.min(0.9, Number(argOf("--storm") ?? process.env.RIDGELINE_STORM ?? 0))),
    blackout: process.argv.includes("--blackout") || process.env.RIDGELINE_BLACKOUT === "1",
    discoveryPort: Number(argOf("--discovery-port") ?? process.env.RIDGELINE_DISCOVERY_PORT ?? 41238),
    tcpPort: Number(argOf("--tcp-port") ?? process.env.RIDGELINE_TCP_PORT ?? 0),
    peers: (argOf("--peers") ?? process.env.RIDGELINE_PEERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    ttl: Number(argOf("--ttl") ?? process.env.RIDGELINE_TTL ?? 8),
  };

  run(cfg);
}

function run(cfg: Cfg) {
  const log = (s: string) => console.log(`[${cfg.id}] ${s}`);
  // Every agent builds the same map from the seed; the casualty is never revealed, only its hash.
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

  let { storm, blackout } = cfg;
  let radioOn = true;
  const inbox: Packet[] = [];

  const mesh = new MeshNode({
    id: cfg.id,
    discoveryPort: cfg.discoveryPort,
    tcpPort: cfg.tcpPort,
    peers: cfg.peers,
    ttl: cfg.ttl,
  });

  mesh.onPeer((p) => log(`${p.id} ${p.status}${p.address ? ` @ ${p.address}` : ""}`));
  mesh.onMessage((m: MeshMessage) => {
    if (m.type !== "state" || m.from === cfg.id) return;
    const j = m.body as JsonState;
    if (!j || j.type !== "state" || j.runId !== cfg.runId || j.from === cfg.id) return;
    const msg = stateFromJson(j);
    // The receiver decides whether it heard the packet (range, line of sight, storm).
    inbox.push({ msg, link: agent.offline ? "off" : canHear(world, msg.pos, agent.pos, storm, radioRng) });
  });

  void mesh.start().then((port) => {
    log(`online — ${cfg.id} (${cfg.role}) on TCP :${port} · seed ${cfg.seed} · ${cfg.strategy}`);
    log(`type "off"/"on" to cut/restore radio, "status" for the map, "quit" to exit`);
  });

  let prevFound = false;
  let prevBaseKnew = false;
  function tick() {
    agent.offline = !radioOn || blackout;
    agent.receive(inbox.splice(0));
    // With our own radio off we hear nobody, so every link reads as "off" from where we stand.
    if (agent.offline) for (const p of agent.lastPacket.keys()) agent.links[p] = "off";
    const msg = agent.act();
    if (agent.found && !prevFound) log(`FOUND the casualty at ${fmt(agent.found.cell)} (by ${agent.found.by})`);
    if (agent.baseKnowsFound && !prevBaseKnew && agent.role === "base") log("BASE INFORMED — search complete");
    prevFound = !!agent.found;
    prevBaseKnew = agent.baseKnowsFound;
    if (!agent.offline) mesh.broadcast("state", stateToJson(msg, cfg.runId));
  }
  setInterval(tick, cfg.tickMs);

  // Local radio control + status, matching the original agent.ts demo.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const cmd = line.trim();
    if (cmd === "off") {
      radioOn = false;
      log("radio OFF — searching alone");
    } else if (cmd === "on") {
      radioOn = true;
      log("radio ON");
    } else if (cmd === "status") {
      const swept = agent.counts().reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
      log(
        `tick ${agent.tick} · pos ${fmt(agent.pos)} · ${swept}/1600 swept (own view) · mode ${agent.mode} · ` +
          `peers ${mesh.peerIds().join(",") || "none"} · ${agent.reason}`,
      );
    } else if (cmd === "quit") {
      mesh.stop();
      process.exit(0);
    }
  });

  process.on("SIGINT", () => {
    mesh.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));
}

const GRID = 40;
const fmt = (c: number) => `(${c % GRID},${Math.floor(c / GRID)})`;

main();
