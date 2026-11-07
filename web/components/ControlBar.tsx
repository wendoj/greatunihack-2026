"use client";

import { useState } from "react";
import Link from "next/link";
import { Eye, EyeOff, ArrowUpRight, Gauge, Pause, Play, RotateCcw, Users, Zap, ZapOff } from "lucide-react";
import type { ClientCommand, SimStatus, Strategy } from "@/lib/contract";
import { STRATEGY_COLORS, STRATEGY_LABELS, STRATEGY_TIPS } from "@/lib/colors";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ResetConfig {
  strategy: Strategy;
  seed: number;
  agents: number;
}

interface Props {
  status: SimStatus | null;
  send: (c: ClientCommand) => void;
  enabled: boolean;
  reveal: boolean;
  setReveal: (v: boolean) => void;
  config: ResetConfig;
  setConfig: (c: ResetConfig) => void;
}

const STRATEGIES: Strategy[] = ["ridgeline", "independent", "central"];

/** An icon that names a control on hover, instead of a visible label. */
function Hint({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex text-foreground/70" />}>{children}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** Explains why a control is disabled. */
function Gate({ enabled, children }: { enabled: boolean; children: React.ReactElement }) {
  if (enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent>Not connected to the simulation</TooltipContent>
    </Tooltip>
  );
}

const Sep = () => <span className="h-6 w-px bg-border" aria-hidden />;
const first = (v: number | readonly number[]) => (Array.isArray(v) ? v[0] : (v as number));

export function ControlBar({ status, send, enabled, reveal, setReveal, config, setConfig }: Props) {
  const running = status?.running ?? false;
  const blackout = status?.blackout ?? false;
  // While dragging, show the local value; otherwise show what the sim reports.
    const [dragSpeed, setDragSpeed] = useState<number | null>(null);
    const speed = dragSpeed ?? status?.tickMs ?? 250;
  const dirty =
    !!status && (status.strategy !== config.strategy || status.seed !== config.seed || status.agentCount !== config.agents);

  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-5 py-3">
      <Gate enabled={enabled}>
        <button
          disabled={!enabled}
          onClick={() => send({ action: running ? "pause" : "start" })}
          className={cn("h-9 w-24", running ? "btn-hw" : "btn-brand")}
        >
          {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {running ? "Pause" : "Start"}
        </button>
      </Gate>
      <Gate enabled={enabled}>
        <button
          disabled={!enabled}
          onClick={() => send({ action: "reset", seed: config.seed, strategy: config.strategy, agents: config.agents })}
          className={cn("btn-hw h-9 px-3", dirty && "border-brand/70 text-brand")}
          title={dirty ? "Reset to apply the new settings" : "Reset"}
        >
          <RotateCcw className="size-3.5" /> Reset
        </button>
      </Gate>

      <Sep />

      <Select
        value={config.strategy}
        onValueChange={(v) => v && setConfig({ ...config, strategy: v as Strategy })}
        items={STRATEGIES.map((s) => ({ value: s, label: STRATEGY_LABELS[s] }))}
        disabled={!enabled}
      >
        <SelectTrigger size="sm" className="btn-hw h-9 w-40 justify-between normal-case">
          <span className="size-1.5 rounded-full" style={{ background: STRATEGY_COLORS[config.strategy] }} />
          <SelectValue className="font-sans text-[13px]" />
        </SelectTrigger>
        <SelectContent className="bg-popover ring-hairline">
          {STRATEGIES.map((s) => (
            <Tooltip key={s}>
              <TooltipTrigger render={<SelectItem value={s} />}>
                <span className="size-1.5 rounded-full" style={{ background: STRATEGY_COLORS[s] }} />
                {STRATEGY_LABELS[s]}
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-64">
                {STRATEGY_TIPS[s]}
              </TooltipContent>
            </Tooltip>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2">
        <Hint tip="Number of search agents">
          <Users className="size-4" />
        </Hint>
        <span className="eyebrow">Agents</span>
        <div className="flex gap-0.5">
          {[3, 4, 5, 6].map((n) => (
            <button
              key={n}
              disabled={!enabled}
              data-active={config.agents === n}
              onClick={() => setConfig({ ...config, agents: n })}
              className="btn-hw h-9 w-8 rounded-md"
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <Sep />

      <div className="flex items-center gap-2.5">
        <Hint tip="Simulation speed">
          <Gauge className="size-4" />
        </Hint>
        <span className="eyebrow">Speed</span>
        <div className="w-20 shrink-0">
          <Slider
            min={50}
            max={1000}
            disabled={!enabled}
            value={[1050 - speed]}
            onValueChange={(v) => setDragSpeed(1050 - first(v))}
            onValueCommitted={(v) => {
              send({ action: "speed", tickMs: 1050 - first(v) });
              setDragSpeed(null);
            }}
          />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                onClick={() => setReveal(!reveal)}
                data-active={reveal}
                className="btn-hw size-9 px-0"
                aria-label="Reveal the hiker"
              />
            }
          >
            {reveal ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </TooltipTrigger>
          <TooltipContent>{reveal ? "Hide the hiker" : "Reveal the hiker"}</TooltipContent>
        </Tooltip>
        <Gate enabled={enabled}>
          <button
            disabled={!enabled}
            onClick={() => send({ action: "blackout", value: !blackout })}
            className={cn(
              "h-9 px-4 tracking-[0.2em]",
              blackout ? "btn-brand animate-pulse !border-red-300 !bg-red-600 !bg-none" : "btn-hw text-red-300 hover:text-red-200",
            )}
          >
            {blackout ? <ZapOff className="size-3.5" /> : <Zap className="size-3.5" />}
            {blackout ? "End blackout" : "Blackout"}
          </button>
        </Gate>
        <Link href="/compare" className="btn-hw h-9 px-3">
          Compare <ArrowUpRight className="size-3.5" />
        </Link>
      </div>
    </footer>
  );
}
