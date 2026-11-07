/// <reference lib="webworker" />
import type { Strategy } from "../contract";
import { runOne, summarize, type CompareRun } from "./headless";

export interface CompareJob {
  seeds: number[];
  storms: number[];
  strategies: Strategy[];
  maxTicks: number;
}

self.onmessage = (e: MessageEvent<CompareJob>) => {
  const { seeds, storms, strategies, maxTicks } = e.data;
  const total = seeds.length * storms.length * strategies.length;
  const runs: CompareRun[] = [];
  for (const strategy of strategies)
    for (const storm of storms)
      for (const seed of seeds) {
        runs.push(runOne(seed, strategy, storm, maxTicks));
        self.postMessage({ type: "progress", done: runs.length, total });
      }
  self.postMessage({ type: "done", results: summarize(runs, seeds, storms, strategies, maxTicks) });
};
