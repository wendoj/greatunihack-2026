"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, RefreshCw, Radio, ZapOff } from "lucide-react";
import { GRID, type AgentId, type Found } from "@/lib/contract";
import { computeViews, type ViewKey } from "@/lib/belief";
import { useSim } from "@/lib/socket";
import { AgentCard } from "@/components/AgentCard";
import { ControlBar, randomSeed, type ResetConfig } from "@/components/ControlBar";
import { Legend } from "@/components/Legend";
import { MapCanvas } from "@/components/MapCanvas";
import { MetricsHeader } from "@/components/MetricsHeader";

const cellStr = (c: number) => `(${c % GRID},${Math.floor(c / GRID)})`;

export default function LivePage() {
  const { world, snapshot, lost, send, frames, mock, connected, connecting, watching, bridgeAvailable, contractMismatch, switchToLive, runOwn } =
    useSim();
  const [chosenView, setView] = useState<ViewKey>("truth");
  const [reveal, setReveal] = useState(false);
  const [edited, setConfig] = useState<ResetConfig | null>(null);
  // Watchers (live, no presenter key) see everything but can't change the shared sim.
  const enabled = (connected || mock) && !watching;
  const disconnected = !mock && !connecting && !connected && !!world;

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

  const newMap = (cfg: ResetConfig) => {
    const seed = randomSeed(cfg.seed);
    setConfig({ ...cfg, seed });
    send({ action: "reset", seed, strategy: cfg.strategy, agents: cfg.agents });
  };

  // Keyboard shortcuts for recording the demo.
  const live = useRef({ status, config, enabled, agents });
  const newMapRef = useRef(newMap);
  useLayoutEffect(() => {
    live.current = { status, config, enabled, agents };
    newMapRef.current = newMap;
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
      else if (k === "n") newMapRef.current(config);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  const selectedAgent = selected ? (agents.find((a) => a.id === selected) ?? lost.find((a) => a.id === selected)) : undefined;

  return (
    <div className="flex h-dvh min-h-[640px] flex-col overflow-hidden">
      {(bridgeAvailable || contractMismatch) && (
        <div className="flex items-center justify-center gap-3 border-b border-border bg-brand/10 px-5 py-2 text-[13px]">
          {bridgeAvailable ? (
            <>
              <Radio className="size-4 text-brand" />
              The live simulation bridge is now reachable.
              <button onClick={switchToLive} className="btn-brand h-7 px-3">
                Switch to live
              </button>
            </>
          ) : (
            <>The bridge speaks a different contract version (v{world?.contractVersion}); some data may look wrong.</>
          )}
        </div>
      )}
      <MetricsHeader probSearched={snapshot?.metrics.probSearched ?? 0} />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 gap-6 px-5 py-4">
          <Legend />
          <div className={`min-w-0 flex-1 transition-[filter] ${disconnected ? "grayscale" : ""}`}>
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
                {selectedAgent && (
                  <AgentCard
                    agent={selectedAgent}
                    lost={!agents.includes(selectedAgent)}
                    missing={computed?.missing[selectedAgent.id] ?? 0}
                    onClose={() => setView("truth")}
                    send={send}
                    enabled={enabled}
                  />
                )}
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
                {disconnected && (
                  <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-black/55">
                    <div className="flex items-center gap-2.5 rounded-lg border border-hairline bg-card px-5 py-3 text-sm">
                      <RefreshCw className="size-4 animate-spin text-brand" /> Bridge lost. Reconnecting…
                    </div>
                  </div>
                )}
                {!watching && status && !status.running && snapshot && snapshot.metrics.tick === 0 && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-hairline bg-black/80 px-6 py-4 text-center shadow-xl backdrop-blur">
                      <div className="font-pixel text-2xl leading-none">Last seen at the pin.</div>
                      <div className="eyebrow">Press start to send the team out</div>
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
      </div>
      {watching ? (
        <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
          <span className="eyebrow flex items-center gap-2">
            <Eye className="size-4 text-brand" /> Watching the live simulation
          </span>
          <span className="text-[13px] text-foreground/70">The presenter controls this run.</span>
          <button onClick={runOwn} className="btn-brand ml-auto h-9 px-4">
            Run your own
          </button>
        </footer>
      ) : (
      <ControlBar
        status={status}
        send={send}
        enabled={enabled}
        reveal={reveal}
        setReveal={setReveal}
        config={config}
        setConfig={setConfig}
        onNewMap={() => newMap(config)}
      />
      )}
    </div>
  );
}
