"use client";

import { useState } from "react";
import { Radio, Skull, WifiOff } from "lucide-react";
import type { AgentId, ClientCommand, Telemetry } from "@/lib/contract";
import { agentColor, LINK_COLORS, MODE_STYLES } from "@/lib/colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface Props {
  agents: Telemetry[];
  lost: Telemetry[];
  selected: AgentId | null;
  missing: Record<AgentId, number>;
  onSelect: (id: AgentId) => void;
  send: (c: ClientCommand) => void;
  enabled: boolean;
}

export function AgentPanel({ agents, lost, selected, missing, onSelect, send, enabled }: Props) {
  const order = (a: Telemetry) => (a.role === "base" ? "~" : a.id);
  const rows = [...agents.map((a) => ({ a, lost: false })), ...lost.map((a) => ({ a, lost: true }))].sort((x, y) =>
    order(x.a) < order(y.a) ? -1 : 1,
  );
  const peers = rows.map((r) => r.a.id);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {rows.map(({ a, lost }) => (
        <AgentRow
          key={a.id}
          a={a}
          lost={lost}
          peers={peers}
          selected={selected === a.id}
          missing={missing[a.id] ?? 0}
          onSelect={() => onSelect(a.id)}
          send={send}
          enabled={enabled}
        />
      ))}
    </div>
  );
}

function AgentRow({
  a,
  lost,
  peers,
  selected,
  missing,
  onSelect,
  send,
  enabled,
}: {
  a: Telemetry;
  lost: boolean;
  peers: AgentId[];
  selected: boolean;
  missing: number;
  onSelect: () => void;
  send: (c: ClientCommand) => void;
  enabled: boolean;
}) {
  const isBase = a.role === "base";
  const mode = MODE_STYLES[a.mode];
  return (
    <div
      className={cn(
        "relative border-b border-border transition-colors",
        selected ? "bg-white/[0.04]" : "hover:bg-white/[0.02]",
        lost && "opacity-40",
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5" style={{ background: agentColor(a.id) }} />}
      <button onClick={onSelect} className="flex w-full flex-col gap-1 px-4 py-2 text-left">
        <div className="flex items-center gap-2">
          {isBase ? (
            <span className="size-2 border-[1.5px]" style={{ borderColor: agentColor(a.id) }} />
          ) : (
            <span className="size-2 rounded-full" style={{ background: agentColor(a.id) }} />
          )}
          <span className="font-mono text-[13px] font-semibold text-foreground">{isBase ? "BASE" : a.id}</span>
          {lost ? (
            <span className="eyebrow">lost</span>
          ) : (
            !isBase &&
            a.mode !== "search" && (
              <span className={cn("rounded px-1.5 font-mono text-[11px] uppercase", mode.className)}>{mode.label}</span>
            )
          )}
          <span className="ml-auto flex items-center gap-2">
            {!lost && missing > 0 && (
              <span className="font-mono text-[11px] text-brand tabular-nums" title="Sweeps this agent hasn't heard about">
                −{missing}
              </span>
            )}
            {!a.radioOn && <WifiOff className="size-3.5 text-foreground/65" aria-label="radio off" />}
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<div />}
            className="line-clamp-2 font-mono text-[12px] leading-snug break-words text-foreground/90"
          >
            {lost ? "No telemetry for 3 s" : a.reason}
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-sm font-mono">
            {a.reason}
          </TooltipContent>
        </Tooltip>
      </button>

      {selected && !lost && (
        <div className="flex flex-col gap-2.5 px-4 pb-3">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {peers
              .filter((p) => p !== a.id)
              .map((p) => {
                const st = a.links[p];
                const ms = a.lastHeard[p];
                return (
                  <span key={p} className="flex items-center gap-1 font-mono text-[11.5px] tabular-nums" title={st ?? "never heard"}>
                    <span className="size-1.5 rounded-full" style={{ background: st ? LINK_COLORS[st] ?? "#3f3f3f" : "#262626" }} />
                    <span className="text-foreground/80">{p === "BASE" ? "Base" : p}</span>
                    <span className="text-foreground/65">
                      {ms === undefined ? "—" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}
                    </span>
                  </span>
                );
              })}
          </div>
          {!isBase && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11.5px] text-foreground/65 tabular-nums">
                {a.stats.sweeps} sweeps · {a.stats.duplicateSweeps} dup
              </span>
              <div className="ml-auto flex gap-1.5">
                <button
                  disabled={!enabled}
                  onClick={() => send({ action: "radio", agent: a.id, value: !a.radioOn })}
                  className="btn-hw h-7 px-2.5"
                >
                  {a.radioOn ? <WifiOff className="size-3" /> : <Radio className="size-3" />}
                  {a.radioOn ? "Radio off" : "Radio on"}
                </button>
                <KillButton id={a.id} send={send} enabled={enabled} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KillButton({ id, send, enabled }: { id: AgentId; send: (c: ClientCommand) => void; enabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={!enabled} className="btn-hw h-7 px-2.5 text-red-300 hover:text-red-200">
        <Skull className="size-3" /> Kill
      </PopoverTrigger>
      <PopoverContent side="left" className="w-60 gap-3 rounded-lg border border-hairline bg-popover p-4 ring-0">
        <div className="text-xs leading-relaxed text-foreground/80">
          Kill <b className="font-medium text-foreground">{id}</b>? Its process stops for good. The others have to
          work out for themselves that its area is no longer covered.
        </div>
        <div className="flex justify-end gap-1.5">
          <button onClick={() => setOpen(false)} className="btn-hw h-7 px-2.5">
            Cancel
          </button>
          <button
            onClick={() => {
              send({ action: "kill", agent: id });
              setOpen(false);
            }}
            className="btn-brand h-7 px-2.5"
          >
            Kill {id}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
