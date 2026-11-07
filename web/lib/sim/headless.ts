import type { CompareResults, Strategy } from "../contract";
import { SimEngine } from "./engine";

export type CompareRun = CompareResults["runs"][number];

/**
 * Two passes per config:
 *  1. find run — stops when base confirms the find; gives time-to-find / time-to-base / duplicates.
 *  2. coverage run — same seed with detection disabled, so "probability searched" isn't cut short
 *     (or bent by everyone converging) when the casualty is found.
 */
export function runOne(seed: number, strategy: Strategy, storm: number, maxTicks = 1500, agents = 5): CompareRun {
  const e = new SimEngine({ seed, strategy, agents, trackEvents: false });
  e.control({ type: "storm", value: storm });
  while (e.tick < maxTicks && e.baseKnewAtTick === null) e.step();
  const t = e.totals();

  const cov = new SimEngine({ seed, strategy, agents, trackEvents: false, detect: false });
  cov.control({ type: "storm", value: storm });
  const samples: number[] = [];
  while (cov.tick < maxTicks) {
    cov.step();
    if (cov.tick % 10 === 0) samples.push(cov.probSearched().prob);
  }
  return {
    strategy,
    storm,
    seed,
    foundAtTick: e.foundAtTick,
    baseKnewAtTick: e.baseKnewAtTick,
    duplicateSweeps: t.dup,
    totalSweeps: t.sweeps,
    probSearched: samples,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(
  runs: CompareRun[],
  seeds: number[],
  storms: number[],
  strategies: Strategy[],
  maxTicks: number,
): CompareResults {
  const summary: CompareResults["summary"] = [];
  for (const strategy of strategies)
    for (const storm of storms) {
      const rs = runs.filter((r) => r.strategy === strategy && r.storm === storm);
      if (!rs.length) continue;
      const len = rs[0].probSearched.length;
      const mean = Array.from({ length: len }, (_, i) => rs.reduce((s, r) => s + r.probSearched[i], 0) / rs.length);
      summary.push({
        strategy,
        storm,
        medianTimeToFind: median(rs.map((r) => r.foundAtTick ?? maxTicks)),
        medianTimeToBase: median(rs.map((r) => r.baseKnewAtTick ?? maxTicks)),
        foundRate: rs.filter((r) => r.foundAtTick !== null).length / rs.length,
        meanDuplicateRate: rs.reduce((s, r) => s + (r.totalSweeps ? r.duplicateSweeps / r.totalSweeps : 0), 0) / rs.length,
        meanProbSearched: mean,
      });
    }
  return { generatedAt: new Date().toISOString(), seeds, storms, maxTicks, runs, summary };
}
