"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ZapOff } from "lucide-react";
import { GRID, type AgentId, type Found } from "@/lib/contract";
import { computeViews, type ViewKey } from "@/lib/belief";
import { useSim } from "@/lib/socket";
import { AgentPanel } from "@/components/AgentPanel";
import { ControlBar, type ResetConfig } from "@/components/ControlBar";
import { EventFeed } from "@/components/EventFeed";
import { Legend } from "@/components/Legend";
import { MapCanvas } from "@/components/MapCanvas";
import { MetricsHeader } from "@/components/MetricsHeader";
import { ViewSelector } from "@/components/ViewSelector";

const cellStr = (c: number) => `(${c % GRID},${Math.floor(c / GRID)})`;

export default function LivePage() {
  const { world, snapshot, events, lost, send, frames, mock, connected, connecting } = useSim();
  const [chosenView, setView] = useState<ViewKey>("truth");
  const [reveal, setReveal] = useState(false);
  const [edited, setConfig] = useState<ResetConfig | null>(null);
  const enabled = connected || mock;

  const status = snapshot?.status ?? null;
  const agents = useMemo(() => snapshot?.agents ?? [], [snapshot]);
  // Reset inputs mirror the running sim until the user edits them.
  const config: ResetConfig = edited ??
    (status ? { strategy: status.strategy, seed: status.seed, agents: status.agentCount } : { strategy: "ridgeline", seed: 39, agents: 5 });

  const computed = useMemo(
    () => (world && snapshot ? computeViews(world, [...snapshot.agents, ...lost]) : null),
    [world, snapshot, lost],
  );
  const found: Found | null = computed?.views.get("truth")?.found ?? null;

  // If the chosen agent no longer exists (e.g. after a reset with fewer agents), show Truth.
  const view: ViewKey =
    chosenView === "truth" || chosenView === "base" || !snapshot || agents.some((a) => a.id === chosenView) || lost.some((a) => a.id === chosenView)
      ? chosenView
      : "truth";
  const selected: AgentId | null = view === "truth" ? null : view === "base" ? "BASE" : view;

  const select = (id: AgentId) => {
    const key: ViewKey = id === "BASE" ? "base" : id;
    setView((v) => (v === key ? "truth" : key));
  };

  // Find / base-informed banner: derived from metrics, hidden 8 s after it appears.
  const foundAt = snapshot?.metrics.foundAtTick ?? null;
  const baseAt = snapshot?.metrics.baseKnewAtTick ?? null;
  const bannerData: { text: string; tone: "red" | "green" } | null =
    baseAt !== null
      ? { text: `Base informed at tick ${baseAt}. All teams converging on the casualty.`, tone: "green" }
      : foundAt !== null && found
        ? { text: `${found.by} found the casualty at ${cellStr(found.cell)}`, tone: "red" }
        : null;
  const bannerKey = bannerData ? `${world?.seed}:${foundAt}:${baseAt}` : null;
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  useEffect(() => {
    if (!bannerKey) return;
    const t = setTimeout(() => setHiddenKey(bannerKey), 8000);
    return () => clearTimeout(t);
  }, [bannerKey]);
  const banner = bannerKey && bannerKey !== hiddenKey ? bannerData : null;

  // Keyboard shortcuts for recording the demo.
  const live = useRef({ status, config, enabled, agents });
  useLayoutEffect(() => {
    live.current = { status, config, enabled, agents };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=listbox], [role=option]")) return;
      const { status, config, enabled, agents } = live.current;
      const k = e.key.toLowerCase();
      if (k === "v") return setReveal((r) => !r);
      if (k === "t") return setView("truth");
      if (k === "0") return setView("base");
      if (/^[1-6]$/.test(k)) {
        const id = "ABCDEF"[Number(k) - 1];
        if (agents.some((a) => a.id === id)) setView(id);
        return;
      }
      if (!enabled) return;
      if (k === " ") {
        e.preventDefault();
        send({ action: status?.running ? "pause" : "start" });
      } else if (k === "b") send({ action: "blackout", value: !status?.blackout });
      else if (k === "r") send({ action: "reset", seed: config.seed, strategy: config.strategy, agents: config.agents });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  const searcherCount = agents.filter((a) => a.role === "searcher").length || status?.agentCount || 5;

  return (
    <div className="flex h-dvh min-h-[640px] flex-col overflow-hidden">
      <MetricsHeader
        metrics={snapshot?.metrics ?? null}
        found={found}
        mock={mock}
        connected={connected}
        connecting={connecting}
        agentCount={searcherCount}
      />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 gap-6 px-5 py-4">
          <Legend />
          <div className="min-w-0 flex-1">
            {world ? (
              <MapCanvas
                world={world}
                frames={frames}
                views={computed?.views ?? null}
                view={view}
                selected={selected}
                reveal={reveal}
                onSelect={select}
              >
                {status?.blackout && (
                  <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center">
                    <div className="flex items-center gap-2 rounded-lg border border-red-400/50 bg-black/80 px-4 py-2 font-mono text-[11px] tracking-wider text-red-200 uppercase shadow-lg backdrop-blur">
                      <ZapOff className="size-3.5" /> Radio blackout · agents are on their own
                    </div>
                  </div>
                )}
                {banner && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                    <div
                      className={`animate-in fade-in slide-in-from-bottom-2 flex items-center gap-2 rounded-lg border bg-black/80 px-4 py-2 text-sm text-foreground shadow-lg backdrop-blur ${
                        banner.tone === "red" ? "border-red-400/50" : "border-emerald-400/50"
                      }`}
                    >
                      <span className={`size-1.5 ${banner.tone === "red" ? "bg-red-500" : "bg-emerald-500"}`} />
                      {banner.text}
                    </div>
                  </div>
                )}
                {status && !status.running && snapshot && snapshot.metrics.tick === 0 && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-hairline bg-black/80 px-6 py-4 text-center shadow-xl backdrop-blur">
                      <div className="font-pixel text-2xl leading-none">Last seen at the pin.</div>
                      <div className="eyebrow">Press space to send the team out</div>
                    </div>
                  </div>
                )}
              </MapCanvas>
            ) : (
              <div className="eyebrow flex h-full items-center justify-center">
                {connecting ? "Looking for the simulation bridge…" : "Waiting for the world…"}
              </div>
            )}
          </div>
        </main>
        <aside className="flex w-[360px] shrink-0 flex-col border-l border-border">
          <ViewSelector view={view} agents={agents} missing={computed?.missing ?? {}} onView={setView} />
          <AgentPanel
            agents={agents}
            lost={lost}
            selected={selected}
            missing={computed?.missing ?? {}}
            onSelect={select}
            send={send}
            enabled={enabled}
          />
          <EventFeed events={events} />
        </aside>
      </div>
      <ControlBar
        status={status}
        send={send}
        enabled={enabled}
        reveal={reveal}
        setReveal={setReveal}
        config={config}
        setConfig={setConfig}
      />
    </div>
  );
}
