// Launch a full decentralized team as separate processes on this machine — no bridge, no
// central server. Each child runs agent-node.ts and joins the mesh on its own; discovery
// connects them (and would connect them to agents on other devices on the same network).
//
//   bun src/main.ts [--seed 39] [--agents 5] [--strategy ridgeline] [--tick-ms 250]
//
// This is the local-demo convenience for the decentralized backend. Across real devices,
// run `bun src/agent-node.ts …` directly on each one with the same --seed/--salt/--hash.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, Strategy } from "../../web/lib/contract";
import { SEARCHER_IDS, generateWorld } from "../../web/lib/sim/world";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(here, "agent-node.ts");

function argOf(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const seed = Number(argOf("--seed", process.env.RIDGELINE_SEED ?? "39"));
const agents = Math.max(3, Math.min(6, Number(argOf("--agents", process.env.RIDGELINE_AGENTS ?? "5"))));
const strategy = argOf("--strategy", process.env.RIDGELINE_STRATEGY ?? "ridgeline") as Strategy;
const tickMs = Number(argOf("--tick-ms", process.env.RIDGELINE_TICK_MS ?? "250"));
const storm = Number(argOf("--storm", process.env.RIDGELINE_STORM ?? "0"));

// One shared casualty secret, generated here and handed to every child. Agents never see the
// casualty cell — only sha256(cell:salt) — so no node is "in charge" of directing the search.
const { casualty } = generateWorld(seed);
const salt = randomBytes(8).toString("hex");
const hash = createHash("sha256").update(`${casualty}:${salt}`).digest("hex");

const ids: AgentId[] = ["BASE", ...SEARCHER_IDS.slice(0, agents)];
const children = new Map<AgentId, ChildProcess>();

console.log(`[mesh] launching ${ids.length} agent processes · seed ${seed} · ${strategy} · storm ${Math.round(storm * 100)}%`);
console.log(`[mesh] shared secret → --salt ${salt} --hash ${hash}`);

for (const id of ids) {
  const args = [
    AGENT_SCRIPT,
    "--id", id,
    "--role", id === "BASE" ? "base" : "searcher",
    "--strategy", strategy,
    "--seed", String(seed),
    "--salt", salt,
    "--hash", hash,
    "--tick-ms", String(tickMs),
    "--storm", String(storm),
    "--run-id", "0",
  ];
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  children.set(id, child);
  child.on("exit", () => children.delete(id));
}

const shutdown = () => {
  for (const c of children.values()) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
