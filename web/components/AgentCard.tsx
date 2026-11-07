"use client";

import { useState } from "react";
import { Radio, Skull, WifiOff, X } from "lucide-react";
import type { ClientCommand, AgentId, Telemetry } from "@/lib/contract";
import { agentColor, MODE_STYLES } from "@/lib/colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Props {
  agent: Telemetry;
  lost: boolean;
  missing: number;
  onClose: () => void;
  send: (c: ClientCommand) => void;
  enabled: boolean;
}

/** The selected agent, floating over the map: what it's doing and why. */
export function AgentCard({ agent: a, lost, missing, onClose, send, enabled }: Props) {
  const isBase = a.role === "base";
  const mode = MODE_STYLES[a.mode];
  return (
    <div className="absolute top-3 left-3 z-10 flex w-72 flex-col gap-2 rounded-lg border border-hairline bg-black/80 p-3 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2">
        {isBase ? (
          <span className="size-2 border-[1.5px]" style={{ borderColor: agentColor(a.id) }} />
        ) : (
          <span className="size-2 rounded-full" style={{ background: agentColor(a.id) }} />
        )}
        <span className="font-mono text-[13px] font-semibold">{isBase ? "Base" : a.id}</span>
        {lost ? (
          <span className="eyebrow">lost</span>
        ) : (
          !isBase &&
          a.mode !== "search" && (
            <span className={cn("rounded px-1.5 font-mono text-[11px] uppercase", mode.className)}>{mode.label}</span>
          )
        )}
        <button onClick={onClose} className="ml-auto text-foreground/60 hover:text-foreground" aria-label="Close">
          <X className="size-4" />
        </button>
      </div>
      <p className="font-mono text-[12px] leading-snug text-foreground/90">{lost ? "No telemetry for 3 s" : a.reason}</p>
      {!lost && missing > 0 && (
        <p className="font-mono text-[12px] text-brand tabular-nums">Missing {missing} sweeps from teammates</p>
      )}
      {!isBase && !lost && (
        <div className="flex gap-1.5">
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
      <PopoverContent side="bottom" align="start" className="w-60 gap-3 rounded-lg border border-hairline bg-popover p-4 ring-0">
        <div className="text-xs leading-relaxed text-foreground/80">
          Stop <b className="font-medium text-foreground">{id}</b> for good? The others have to work out for themselves
          that its area is no longer covered.
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
