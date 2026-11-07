"use client";

import { useEffect, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import {
  CONTRACT_VERSION,
  type AgentId,
  type ClientCommand,
  type SimEvent,
  type Snapshot,
  type SweepTable,
  type Telemetry,
  type WorldMsg,
} from "./contract";
import { MockBridge } from "./mock";

export const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "http://localhost:4000";
const FORCE_MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
const CONNECT_TIMEOUT_MS = 2000;
const UI_PUSH_MS = 200; // React sees at most 5 updates/s
export const LOST_AFTER_MS = 3000;
const KEY_STORE = "ridgeline.key";

export interface SimState {
  /** Data is flowing from the current source (mock is always "connected"). */
  connected: boolean;
  mock: boolean;
  /** true until we've decided between the bridge and mock mode */
  connecting: boolean;
  /** Live, but this browser has no presenter key: read-only. */
  watching: boolean;
  /** Running mock, but the bridge has since become reachable. */
  bridgeAvailable: boolean;
  /** The bridge speaks a different contract version. */
  contractMismatch: boolean;
  world: WorldMsg | null;
  snapshot: Snapshot | null;
  events: SimEvent[]; // newest first, ≤50
  /** Agents seen since the last reset that have dropped out of the latest snapshot (killed or vanished). */
  lost: Telemetry[];
  compareProgress: { done: number; total: number } | null;
}

/** High-rate data for the canvas loop — read from a ref, never through React. */
export interface Frames {
  cur: Snapshot | null;
  prev: Snapshot | null;
  curAt: number;
  interval: number; // smoothed ms between snapshots
  lastSeen: Map<AgentId, { tel: Telemetry; at: number }>;
}

const INITIAL: SimState = {
  connected: false,
  mock: false,
  connecting: true,
  watching: false,
  bridgeAvailable: false,
  contractMismatch: false,
  world: null,
  snapshot: null,
  events: [],
  lost: [],
  compareProgress: null,
};

/** Presenter key: taken from ?key= once, stored, and stripped from the URL so it never shows on screen. */
export function presenterKey(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    const k = url.searchParams.get("key");
    if (k) {
      localStorage.setItem(KEY_STORE, k);
      url.searchParams.delete("key");
      window.history.replaceState(null, "", url.toString());
      return k;
    }
    return localStorage.getItem(KEY_STORE) ?? "";
  } catch {
    return "";
  }
}

class SimClient {
  private state: SimState = INITIAL;
  private pending: Partial<SimState> = {};
  private listeners = new Set<() => void>();
  private started = false;
  private socket: Socket | null = null;
  private mockBridge: MockBridge | null = null;
  private live = false; // socket is the active data source
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPush = 0;
  private sweepCache = new Map<AgentId, SweepTable>();
  private blackoutLinks: { count: number; restoring: number; restoreUntil: number } = { count: 0, restoring: 0, restoreUntil: 0 };
  frames: Frames = { cur: null, prev: null, curAt: 0, interval: 200, lastSeen: new Map() };

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  getServerState = () => INITIAL;

  private set(patch: Partial<SimState>, throttle = false) {
    this.pending = { ...this.pending, ...patch };
    if (!throttle) return this.flush();
    if (this.pushTimer) return;
    const wait = Math.max(0, UI_PUSH_MS - (Date.now() - this.lastPush));
    this.pushTimer = setTimeout(() => this.flush(), wait);
  }
  private flush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.lastPush = Date.now();
    this.state = { ...this.state, ...this.pending };
    this.pending = {};
    for (const l of this.listeners) l();
  }
  private get cur(): SimState {
    return { ...this.state, ...this.pending };
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (FORCE_MOCK) return this.startMock();

    const key = presenterKey();
    const socket = io(BRIDGE_URL, {
      transports: ["websocket", "polling"],
      timeout: CONNECT_TIMEOUT_MS,
      auth: { key },
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
    });
    this.socket = socket;
    this.live = true;

    // Give the bridge 2 s; then run the mock but keep probing in the background.
    const fallback = setTimeout(() => {
      if (socket.connected) return;
      this.live = false;
      this.startMock();
    }, CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      clearTimeout(fallback);
      if (this.live) this.set({ connected: true, connecting: false, mock: false });
      else this.set({ bridgeAvailable: true }); // found it while on mock: offer, never auto-switch
    });
    socket.on("disconnect", () => {
      if (this.live) this.set({ connected: false });
      else this.set({ bridgeAvailable: false });
    });
    socket.on("role", (r: { presenter: boolean }) => this.live && this.set({ watching: !r.presenter }));
    socket.on("world", (w: WorldMsg) => this.live && this.onWorld(w));
    socket.on("snapshot", (s: Snapshot) => this.live && this.onSnapshot(s));
    socket.on("event", (e: SimEvent) => this.live && this.onEvent(e));
    socket.on("compare:progress", (p: { done: number; total: number }) => this.set({ compareProgress: p }));
  }

  private startMock() {
    this.mockBridge?.dispose();
    this.set({ mock: true, connected: true, connecting: false, watching: false });
    this.mockBridge = new MockBridge({
      world: (w) => this.onWorld(w),
      snapshot: (s) => this.onSnapshot(s),
      event: (e) => this.onEvent(e),
    });
  }

  /** Switch from the mock to the live bridge (after the user accepts the prompt). */
  switchToLive = () => {
    if (!this.socket?.connected) return;
    this.mockBridge?.dispose();
    this.mockBridge = null;
    this.live = true;
    this.set({ mock: false, connected: true, bridgeAvailable: false, world: null, snapshot: null, events: [] });
    // Ask the bridge to resend world + role by reconnecting.
    this.socket.disconnect().connect();
  };

  /** Watchers: leave the shared live sim and run a private mock instead. */
  runOwn = () => {
    this.live = false;
    this.set({ watching: false, events: [] });
    this.startMock();
  };

  private onWorld(w: WorldMsg) {
    const f = this.frames; // mutate in place: the canvas loop holds this reference
    f.cur = null;
    f.prev = null;
    f.curAt = 0;
    f.lastSeen.clear();
    this.sweepCache.clear();
    this.blackoutLinks = { count: 0, restoring: 0, restoreUntil: 0 };
    this.set({ world: w, snapshot: null, lost: [], contractMismatch: w.contractVersion !== CONTRACT_VERSION });
  }

  private onSnapshot(raw: Snapshot) {
    const world = this.cur.world;
    // Reset race: drop snapshots from a previous run.
    if (!world || (raw.status.runId !== undefined && raw.status.runId !== world.runId)) return;
    // Delta sweeps: a missing table means "unchanged since last time".
    const agents = raw.agents.map((a) => {
      const merged = { ...(this.sweepCache.get(a.id) ?? {}), ...a.sweeps };
      this.sweepCache.set(a.id, merged);
      return { ...a, sweeps: merged };
    });
    const s: Snapshot = { ...raw, agents };

    const now = performance.now();
    const f = this.frames;
    if (f.cur) f.interval = Math.min(1000, Math.max(80, f.interval * 0.8 + (now - f.curAt) * 0.2));
    f.prev = f.cur;
    f.cur = s;
    f.curAt = now;
    const present = new Set<AgentId>();
    for (const a of agents) {
      present.add(a.id);
      f.lastSeen.set(a.id, { tel: a, at: now });
    }
    const lost: Telemetry[] = [];
    for (const [id, v] of f.lastSeen) if (!present.has(id) && now - v.at > LOST_AFTER_MS) lost.push(v.tel);
    this.set({ snapshot: s, lost }, true);
  }

  /** Normalise events so mock and live read the same: re-stamp time, hide range noise, collapse blackouts. */
  private onEvent(raw: SimEvent) {
    const world = this.cur.world;
    if (raw.runId !== undefined && world && raw.runId !== world.runId && raw.kind !== "reset") return;
    const e: SimEvent = { ...raw, t: Date.now() };
    const blackout = this.cur.snapshot?.status.blackout ?? false;
    const events = [...this.cur.events];
    const b = this.blackoutLinks;

    if (e.kind === "peer_lost" && /\(range\)/.test(e.text)) return;
    if (e.kind === "blackout" && e.text.startsWith("Blackout lifted")) {
      b.restoring = 0;
      b.restoreUntil = Date.now() + 4000;
    }
    if (e.kind === "peer_lost" && blackout) {
      b.count++;
      const head = events.findIndex((x) => x.kind === "blackout");
      if (head >= 0) events[head] = { ...events[head], text: `RADIO BLACKOUT · ${b.count} link${b.count === 1 ? "" : "s"} down` };
      return this.set({ events }, true);
    }
    if (e.kind === "peer_joined" && Date.now() < b.restoreUntil) {
      b.restoring++;
      const head = events.findIndex((x) => x.kind === "peer_joined" && x.text.startsWith("Radios back"));
      const merged: SimEvent = { ...e, agent: undefined, peer: undefined, text: `Radios back · ${b.restoring} link${b.restoring === 1 ? "" : "s"} restored` };
      if (head >= 0) events[head] = merged;
      else events.unshift(merged);
      return this.set({ events: events.slice(0, 50) }, true);
    }
    if (e.kind === "blackout" && !e.text.startsWith("Blackout lifted")) b.count = 0;
    this.set({ events: [e, ...events].slice(0, 50) }, true);
  }

  send = (cmd: ClientCommand) => {
    if (this.mockBridge && !this.live) this.mockBridge.command(cmd);
    else this.socket?.emit("command", cmd);
  };
}

let client: SimClient | null = null;
export function getSimClient(): SimClient {
  return (client ??= new SimClient());
}

export function useSim() {
  const c = getSimClient();
  useEffect(() => c.start(), [c]);
  const s = useSyncExternalStore(c.subscribe, c.getState, c.getServerState);
  return { ...s, send: c.send, frames: c.frames, client: c, switchToLive: c.switchToLive, runOwn: c.runOwn };
}
