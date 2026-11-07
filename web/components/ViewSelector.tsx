"use client";

import type { AgentId, Telemetry } from "@/lib/contract";
import type { ViewKey } from "@/lib/belief";
import { agentColor } from "@/lib/colors";

interface Props {
  view: ViewKey;
  agents: Telemetry[];
  missing: Record<AgentId, number>;
  onView: (v: ViewKey) => void;
}

/** Whose map is drawn. The agent views are the key demo: cut an agent off and its map falls behind. */
export function ViewSelector({ view, agents, missing, onView }: Props) {
  const searchers = agents.filter((a) => a.role === "searcher").sort((x, y) => (x.id < y.id ? -1 : 1));
  const focus: AgentId | null = view === "truth" ? null : view === "base" ? "BASE" : view;
  const gap = focus ? missing[focus] ?? 0 : 0;
  const name = focus === "BASE" ? "Base" : focus;
  return (
    <div className="flex flex-col gap-2.5 border-b border-border px-4 pt-3.5 pb-3">
      <div className="flex flex-wrap gap-0.5">
        <Chip active={view === "truth"} onClick={() => onView("truth")} title="Truth: everything any agent has searched (T)">
          Truth
        </Chip>
        <Chip active={view === "base"} onClick={() => onView("base")} title="What the base station knows (0)">
          Base
        </Chip>
        {searchers.map((a, i) => (
          <Chip key={a.id} active={view === a.id} onClick={() => onView(a.id)} title={`${a.id}'s own map (${i + 1})`}>
            <span className="size-1.5 rounded-full" style={{ background: agentColor(a.id) }} />
            {a.id}
          </Chip>
        ))}
      </div>
      {focus && (
        <div className="font-mono text-[11px] tabular-nums">
          {gap > 0 ? (
            <span className="text-brand">
              {name} is missing {gap} sweep{gap === 1 ? "" : "s"}
            </span>
          ) : (
            <span className="text-emerald-400">{name} is up to date</span>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({
  active,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean }) {
  return (
    <button {...rest} data-active={active} className="btn-hw h-7 gap-1 rounded-md px-2">
      {children}
    </button>
  );
}
