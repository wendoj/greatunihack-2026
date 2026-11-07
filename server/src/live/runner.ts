// Headless comparison: every strategy × storm level × seed, using the in-memory transport
// (same agent code, same radio model, no sockets). Prints {done,total} per run; writes JSON.
//
//   bun src/live/runner.ts [out=results.json] [seeds=20]

import { writeFileSync } from "node:fs";
import type { Strategy } from "../../../web/lib/contract";
import { runOne, summarize, type CompareRun } from "../../../web/lib/sim/headless";

const out = process.argv[2] ?? "results.json";
const nSeeds = Number(process.argv[3] ?? 20);
const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
const storms = [0, 0.3, 0.6, 0.9];
const strategies: Strategy[] = ["central", "independent", "ridgeline"];
const maxTicks = 1500;

const total = seeds.length * storms.length * strategies.length;
const runs: CompareRun[] = [];
for (const strategy of strategies)
  for (const storm of storms)
    for (const seed of seeds) {
      runs.push(runOne(seed, strategy, storm, maxTicks));
      console.log(JSON.stringify({ done: runs.length, total }));
    }
writeFileSync(out, JSON.stringify(summarize(runs, seeds, storms, strategies, maxTicks)));
