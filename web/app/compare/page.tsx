"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChartLine } from "lucide-react";
import type { CompareResults, Strategy } from "@/lib/contract";
import { BRIDGE_URL, presenterKey, useSim } from "@/lib/socket";
import { CompareCharts, summaryParts } from "@/components/CompareCharts";

const JOB = {
  seeds: [1, 2, 3, 4, 5],
  storms: [0, 0.3, 0.6, 0.9],
  strategies: ["central", "independent", "ridgeline"] as Strategy[],
  maxTicks: 1500,
};

// Survives navigating back and forth within the session.
let cached: CompareResults | null = null;

export default function ComparePage() {
  const { mock: mockSource, watching, connecting, compareProgress } = useSim();
  // Watchers can't start a live comparison, so they get the in-browser one (labelled mock).
  const mock = mockSource || watching;
  const [results, setResults] = useState<CompareResults | null>(cached);
  const [workerProgress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "missing" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);

  const done = (r: CompareResults) => {
    cached = r;
    setResults(r);
    setState("idle");
    setProgress(null);
  };

  const runMock = useCallback(() => {
    worker.current?.terminate();
    const w = new Worker(new URL("../../lib/sim/compare.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    setState("running");
    setProgress({ done: 0, total: JOB.seeds.length * JOB.storms.length * JOB.strategies.length });
    w.onmessage = (e) => {
      if (e.data.type === "progress") setProgress({ done: e.data.done, total: e.data.total });
      else if (e.data.type === "done") {
        done(e.data.results);
        w.terminate();
      }
    };
    w.onerror = (e) => {
      setState("error");
      setError(e.message || "Worker failed");
    };
    w.postMessage(JOB);
  }, []);

  const fetchLive = useCallback(async () => {
    setState("loading");
    try {
      const res = await fetch(`${BRIDGE_URL}/api/results`);
      if (res.status === 404) return setState("missing");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      done(await res.json());
    } catch (e) {
      setState("error");
      setError(String(e));
    }
  }, []);

  const runLive = async () => {
    setState("running");
    setProgress(null);
    try {
      const res = await fetch(`${BRIDGE_URL}/api/compare`, { method: "POST", headers: { "x-ridgeline-key": presenterKey() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      setState("error");
      setError(String(e));
    }
  };

  // First load: mock → run the headless sim; live → fetch the bridge's saved results.
  useEffect(() => {
    if (connecting || cached) return;
    // Kicking off external work (a worker or a fetch) on mount is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mock) runMock();
    else fetchLive();
  }, [connecting, mock, runMock, fetchLive]);

  // Live: bridge reports progress over Socket.IO; refetch when finished.
  useEffect(() => {
    if (mock || !compareProgress || compareProgress.done < compareProgress.total) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchLive();
  }, [compareProgress, mock, fetchLive]);

  useEffect(() => () => worker.current?.terminate(), []);

  const progress = mock ? workerProgress : compareProgress;
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-6 py-5">
      <header className="flex h-9 items-center gap-4">
        <Link href="/" className="btn-hw h-8 px-3">
          <ArrowLeft className="size-3.5" /> Live
        </Link>
        {mock && (
          <span className="eyebrow ml-auto flex items-center gap-1.5">
            <span className="size-1.5 bg-brand" /> mock data
          </span>
        )}
      </header>

      <div className="flex flex-col gap-4 pt-2">
        <h1 className="font-pixel text-5xl leading-[1.05]">How do we compare?</h1>
        {results && (
          <p className="max-w-4xl text-[26px] leading-tight tracking-tight text-foreground">
            {summaryParts(results)[0]}
            <span className="text-foreground/70">{summaryParts(results)[1]}</span>
          </p>
        )}
      </div>

      {(state === "running" || state === "loading") && (
        <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-card p-5">
          <div className="eyebrow flex items-center justify-between">
            <span>
              {state === "loading"
                ? "Loading results"
                : `Running ${progress?.total ?? "…"} simulations`}
            </span>
            <span className="font-mono tabular-nums">{progress ? `${progress.done}/${progress.total}` : ""}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.12]">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{ width: `${pct}%`, backgroundImage: "linear-gradient(90deg, #dd520c, #f7732b)" }}
            />
          </div>
        </div>
      )}

      {state === "missing" && !results && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-hairline bg-card p-6">
          <p className="text-sm text-foreground/85">No comparison results on the bridge yet.</p>
          <button onClick={runLive} className="btn-brand h-9 px-4">
            <ChartLine className="size-4" /> Run comparison
          </button>
        </div>
      )}

      {state === "error" && (
        <div className="rounded-lg border border-red-500/40 p-4 text-sm text-red-200">
          Couldn&apos;t get results: {error}.{" "}
          <button className="underline" onClick={mock ? runMock : fetchLive}>
            Try again
          </button>
        </div>
      )}

      {results && <CompareCharts results={results} />}

      {results && (
        <div className="eyebrow flex items-center gap-3 text-foreground/60">
          <span>
            {results.runs.length} runs · {results.seeds.length} seeds · {results.maxTicks.toLocaleString("en-GB")} ticks max
          </span>
          {mock && state !== "running" && (
            <button onClick={runMock} className="btn-hw h-7 px-2.5">
              Re-run
            </button>
          )}
        </div>
      )}
    </div>
  );
}
