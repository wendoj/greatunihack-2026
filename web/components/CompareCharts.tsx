"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend as RLegend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CompareResults, Strategy } from "@/lib/contract";
import { STRATEGY_COLORS, STRATEGY_LABELS } from "@/lib/colors";

const ORDER: Strategy[] = ["ridgeline", "independent", "central"];
const AXIS = { stroke: "#262626", tick: { fill: "#8b8f91", fontSize: 11, fontFamily: "var(--font-geist-mono)" }, tickLine: false };
const GRIDC = <CartesianGrid stroke="#161616" vertical={false} />;
const TIP = {
  contentStyle: { background: "rgba(0,0,0,0.9)", border: "1px solid rgba(242,241,236,0.12)", borderRadius: 8, fontSize: 12 },
  labelStyle: { color: "#e8edef", fontFamily: "var(--font-geist-mono)", textTransform: "uppercase", fontSize: 11 },
  itemStyle: { padding: 0 },
};
function Title({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="eyebrow flex items-center gap-1.5 text-foreground/80">
        <span className="size-1.5 bg-brand" />
        {children}
      </h2>
      {note && <span className="font-mono text-[10.5px] text-foreground/35 uppercase">{note}</span>}
    </div>
  );
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-GB");

export function summaryParts(r: CompareResults, storm = 0.6): [string, string] {
  const full = summarySentence(r, storm);
  const i = full.indexOf(" vs ");
  return i < 0 ? [full, ""] : [full.slice(0, i), full.slice(i)];
}

export function summarySentence(r: CompareResults, storm = 0.6): string {
  const get = (s: Strategy) => r.summary.find((x) => x.strategy === s && Math.abs(x.storm - storm) < 1e-6);
  const show = (s: Strategy) => {
    const v = get(s);
    if (!v) return "n/a";
    return v.medianTimeToFind >= r.maxTicks ? `${fmt(r.maxTicks)}+` : fmt(v.medianTimeToFind);
  };
  return `At ${Math.round(storm * 100)}% packet loss, Ridgeline finds the casualty in a median ${show("ridgeline")} ticks vs ${show("central")} for Central and ${show("independent")} for Independent.`;
}

export function CompareCharts({ results }: { results: CompareResults }) {
  const storms = results.storms;
  const [storm, setStorm] = useState(storms.includes(0.6) ? 0.6 : storms[0]);
  const present = ORDER.filter((s) => results.summary.some((x) => x.strategy === s));

  const curve = useMemo(() => {
    const rows: Record<string, number>[] = [];
    const series = present.map((s) => results.summary.find((x) => x.strategy === s && x.storm === storm));
    const len = Math.max(0, ...series.map((x) => x?.meanProbSearched.length ?? 0));
    for (let i = 0; i < len; i++) {
      const row: Record<string, number> = { tick: (i + 1) * 10 };
      present.forEach((s, k) => {
        const v = series[k]?.meanProbSearched[i];
        if (v !== undefined) row[s] = Math.round(v * 1000) / 10;
      });
      rows.push(row);
    }
    return rows;
  }, [results, storm, present]);

  const byStorm = useMemo(
    () =>
      storms.map((st) => {
        const row: Record<string, number> = { storm: Math.round(st * 100) };
        for (const s of present) {
          const v = results.summary.find((x) => x.strategy === s && x.storm === st);
          if (!v) continue;
          row[s] = v.medianTimeToFind;
          row[`${s}_dup`] = Math.round(v.meanDuplicateRate * 1000) / 10;
          row[`${s}_rate`] = v.foundRate;
        }
        return row;
      }),
    [results, storms, present],
  );

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
      <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-5 xl:col-span-3">
        <div className="flex items-start justify-between gap-4">
          <Title>Probability searched over time</Title>
          <div className="flex shrink-0 items-center gap-0.5">
            <span className="eyebrow mr-2">packet loss</span>
            {storms.map((s) => (
              <button key={s} onClick={() => setStorm(s)} data-active={s === storm} className="btn-hw h-7 rounded-md px-2.5">
                {Math.round(s * 100)}%
              </button>
            ))}
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={curve} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              {GRIDC}
              <XAxis dataKey="tick" {...AXIS} type="number" domain={[0, results.maxTicks]}  />
              <YAxis {...AXIS} domain={[0, 100]} unit="%" width={44} />
              <Tooltip {...TIP} formatter={(v, n) => [`${v}%`, STRATEGY_LABELS[n as Strategy] ?? n]} labelFormatter={(t) => `tick ${t}`} />
              <RLegend formatter={(v) => <span className="font-mono text-[11px] text-foreground/70 uppercase">{STRATEGY_LABELS[v as Strategy]}</span>} />
              {present.map((s) => (
                <Line
                  key={s}
                  dataKey={s}
                  stroke={STRATEGY_COLORS[s]}
                  strokeWidth={s === "ridgeline" ? 3.5 : 1.75}
                  strokeOpacity={s === "ridgeline" ? 1 : 0.85}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-5 xl:col-span-2">
        <Title note="ticks · lower is better · hollow = not found">Median time to find vs packet loss</Title>
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={byStorm} margin={{ top: 16, right: 16, bottom: 4, left: 0 }}>
              {GRIDC}
              <XAxis dataKey="storm" {...AXIS} unit="%" />
              <YAxis {...AXIS} domain={[0, results.maxTicks]} width={48} />
              <ReferenceLine
                y={results.maxTicks}
                stroke="#3f3f3f"
                strokeDasharray="4 4"
                label={{ value: `not found within ${fmt(results.maxTicks)} ticks`, fill: "#9ca3af", fontSize: 10, position: "insideTopLeft" }}
              />
              <Tooltip
                {...TIP}
                labelFormatter={(s) => `${s}% packet loss`}
                formatter={(v, n) => [Number(v) >= results.maxTicks ? `${fmt(results.maxTicks)}+ ticks` : `${fmt(Number(v))} ticks`, STRATEGY_LABELS[n as Strategy] ?? n]}
              />
              {present.map((s) => (
                <Line
                  key={s}
                  dataKey={s}
                  stroke={STRATEGY_COLORS[s]}
                  strokeWidth={s === "ridgeline" ? 3.5 : 1.75}
                  isAnimationActive={false}
                  dot={(p: { cx?: number; cy?: number; value?: number; index?: number }) => {
                    const capped = (p.value ?? 0) >= results.maxTicks;
                    return (
                      <circle
                        key={`${s}-${p.index}`}
                        cx={p.cx}
                        cy={p.cy}
                        r={capped ? 5 : 4}
                        fill={capped ? "#000" : STRATEGY_COLORS[s]}
                        stroke={STRATEGY_COLORS[s]}
                        strokeWidth={2}
                      />
                    );
                  }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-hairline bg-card p-5">
        <Title note="lower is better">Duplicate sweeps</Title>
        <div className="h-64">
          <ResponsiveContainer>
            <BarChart data={byStorm} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              {GRIDC}
              <XAxis dataKey="storm" {...AXIS} unit="%" />
              <YAxis {...AXIS} unit="%" width={40} domain={[0, 100]} />
              <Tooltip {...TIP} cursor={{ fill: "#111" }} labelFormatter={(s) => `${s}% packet loss`} formatter={(v, n) => [`${v}%`, STRATEGY_LABELS[String(n).replace("_dup", "") as Strategy]]} />
              {present.map((s) => (
                <Bar key={s} dataKey={`${s}_dup`} fill={STRATEGY_COLORS[s]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
