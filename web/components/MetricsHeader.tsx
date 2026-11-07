"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { Found, Metrics } from "@/lib/contract";
import { GRID } from "@/lib/contract";
import { Explainer } from "./Explainer";

interface Props {
  metrics: Metrics | null;
  found: Found | null;
  mock: boolean;
  connected: boolean;
  connecting: boolean;
  agentCount: number;
}

const cell = (c: number) => `(${c % GRID},${Math.floor(c / GRID)})`;

export function MetricsHeader({ metrics, found, mock, connected, connecting, agentCount }: Props) {
  const p = metrics?.probSearched ?? 0;
  const link = connecting ? "connecting" : connected ? (mock ? "mock data" : "live") : "offline";
  return (
    <header className="flex flex-col border-b border-border">
      <div className="flex h-12 items-center gap-4 border-b border-border px-5">
        <span className="font-pixel text-xl leading-none tracking-tight text-foreground">Ridgeline</span>
        <p className="truncate text-[13px] text-foreground/55">
          {agentCount} agents search for a missing hiker. No one is in charge, and ridges block their radios.
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-4">
          <Explainer />
          <span className="eyebrow flex items-center gap-1.5" title={mock ? "Running the in-browser simulation" : undefined}>
            <span
              className={`size-1.5 ${connecting ? "animate-pulse bg-foreground/50" : connected ? (mock ? "bg-brand" : "bg-emerald-500") : "bg-red-500"}`}
            />
            {link}
          </span>
          <Link href="/compare" className="btn-hw h-8 px-3">
            Compare <ArrowUpRight className="size-3.5" />
          </Link>
        </div>
      </div>

      <div className="flex items-end gap-8 px-5 pt-3 pb-3.5">
        <div className="shrink-0">
          <div className="eyebrow mb-1.5 flex items-center gap-1.5">
            <span className="size-1.5 bg-brand" />
            Probability searched
          </div>
          <div className="font-pixel text-[44px] leading-none text-foreground tabular-nums">
            {(p * 100).toFixed(1)}
            <span className="text-2xl text-foreground/50">%</span>
          </div>
        </div>
        <div className="mb-2 h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${Math.min(100, p * 100)}%`,
              backgroundImage: "linear-gradient(90deg, #dd520c, #f7732b)",
            }}
          />
        </div>
        <Stat label="Tick" value={metrics ? String(metrics.tick) : "—"} />
        <Stat
          label="Found"
          value={found ? `${cell(found.cell)} · ${found.by}` : "—"}
          tone={found ? "text-red-300" : undefined}
        />
        <Stat
          label="Base"
          value={metrics?.baseKnewAtTick != null ? `t${metrics.baseKnewAtTick}` : "—"}
          tone={metrics?.baseKnewAtTick != null ? "text-emerald-300" : undefined}
        />
        <Stat label="Duplicates" value={metrics ? String(metrics.duplicateSweeps) : "—"} />
      </div>
    </header>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="mb-0.5 shrink-0">
      <div className="eyebrow mb-1">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
}
