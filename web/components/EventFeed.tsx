"use client";

import { useEffect, useState } from "react";
import { CloudLightning, Crosshair, Link2, Radio, RotateCcw, Skull, Tent, Unlink, ZapOff } from "lucide-react";
import type { SimEvent } from "@/lib/contract";
import { agentColor } from "@/lib/colors";

const ICONS: Record<SimEvent["kind"], { icon: React.ElementType; className: string }> = {
  found: { icon: Crosshair, className: "text-red-400" },
  base_informed: { icon: Tent, className: "text-emerald-400" },
  peer_lost: { icon: Unlink, className: "text-red-400/70" },
  peer_joined: { icon: Link2, className: "text-emerald-400/70" },
  agent_killed: { icon: Skull, className: "text-foreground/78" },
  radio: { icon: Radio, className: "text-foreground/78" },
  storm: { icon: CloudLightning, className: "text-foreground/78" },
  blackout: { icon: ZapOff, className: "text-brand" },
  reset: { icon: RotateCcw, className: "text-foreground/65" },
};

const ago = (ms: number) => (ms < 5000 ? "now" : ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m`);

export function EventFeed({ events }: { events: SimEvent[] }) {
  const [now, setNow] = useState(0); // 0 until mounted: no wall-clock reads during prerender
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const first = setTimeout(() => setNow(Date.now()), 0);
    return () => {
      clearInterval(t);
      clearTimeout(first);
    };
  }, []);
  return (
    <ol className="flex h-32 shrink-0 flex-col overflow-y-auto border-t border-border px-3 py-2 [@media(min-height:860px)]:h-52">
      {events.length === 0 && <li className="eyebrow px-1 py-1">Press space to start</li>}
      {events.slice(0, 20).map((e, i) => {
        const { icon: Icon, className } = ICONS[e.kind];
        const big = e.kind === "found" || e.kind === "base_informed" || e.kind === "blackout";
        return (
          <li key={`${e.t}-${i}-${e.text}`} className="flex items-start gap-2 px-1 py-[3px] text-[13px] leading-snug">
            <Icon className={`mt-0.5 size-3 shrink-0 ${className}`} />
            <span className={big ? "font-medium text-foreground" : "text-foreground/82"}>
              {e.agent && (
                <span className="mr-1.5 inline-block size-1.5 -translate-y-px rounded-full" style={{ background: agentColor(e.agent) }} />
              )}
              {e.text}
            </span>
            <span className="ml-auto shrink-0 font-mono text-[11px] text-foreground/60 tabular-nums">
              {now ? ago(now - e.t) : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
