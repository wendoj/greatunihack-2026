"use client";

import { useEffect, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { AgentId, ClientCommand, SimEvent, Snapshot, Telemetry } from "./contract";
import { MockBridge, type WorldMsg } from "./mock";

export const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "http://localhost:4000";
const FORCE_MOCK = process.env.NEXT_PUBLIC_MOCK === "1";
const CONNECT_TIMEOUT_MS = 2000;
const UI_PUSH_MS = 200; // React sees at most 5 updates/s
export const LOST_AFTER_MS = 3000;

export interface SimState {
  connected: boolean;
  mock: boolean;
  /** true until we've decided between the bridge and mock mode */
  connecting: boolean;
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
  world: null,
  snapshot: null,
  events: [],
  lost: [],
  compareProgress: null,
};

class SimClient {
  private state: SimState = INITIAL;
  private listeners = new Set<() => void>();
  private started = false;
  private socket: Socket | null = null;
  private mock: MockBridge | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPush = 0;
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
  private pending: Partial<SimState> = {};
  private flush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.lastPush = Date.now();
    this.state = { ...this.state, ...this.pending };
    this.pending = {};
    for (const l of this.listeners) l();
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (FORCE_MOCK) return this.useMock();
    const socket = io(BRIDGE_URL, { transports: ["websocket", "polling"], timeout: CONNECT_TIMEOUT_MS });
    this.socket = socket;
    const fallback = setTimeout(() => {
      if (socket.connected) return;
      socket.removeAllListeners();
      socket.close();
      this.socket = null;
      this.useMock();
    }, CONNECT_TIMEOUT_MS);
    socket.on("connect", () => {
      clearTimeout(fallback);
      this.set({ connected: true, connecting: false, mock: false });
    });
    socket.on("disconnect", () => this.set({ connected: false }));
    socket.on("world", (w: WorldMsg) => this.onWorld(w));
    socket.on("snapshot", (s: Snapshot) => this.onSnapshot(s));
    socket.on("event", (e: SimEvent) => this.onEvent(e));
    socket.on("compare:progress", (p: { done: number; total: number }) => this.set({ compareProgress: p }));
  }

  private useMock() {
    this.set({ mock: true, connected: true, connecting: false });
    this.mock = new MockBridge({
      world: (w) => this.onWorld(w),
      snapshot: (s) => this.onSnapshot(s),
      event: (e) => this.onEvent(e),
    });
  }

  private onWorld(w: WorldMsg) {
    const f = this.frames; // mutate in place: the canvas loop holds this reference
    f.cur = null;
    f.prev = null;
    f.curAt = 0;
    f.lastSeen.clear();
    this.set({ world: w, snapshot: null, lost: [] });
  }

  private onSnapshot(s: Snapshot) {
    const now = performance.now();
    const f = this.frames;
    if (f.cur) f.interval = Math.min(1000, Math.max(80, f.interval * 0.8 + (now - f.curAt) * 0.2));
    f.prev = f.cur;
    f.cur = s;
    f.curAt = now;
    const present = new Set<AgentId>();
    for (const a of s.agents) {
      present.add(a.id);
      f.lastSeen.set(a.id, { tel: a, at: now });
    }
    const lost: Telemetry[] = [];
    for (const [id, v] of f.lastSeen) if (!present.has(id) && now - v.at > LOST_AFTER_MS) lost.push(v.tel);
    this.set({ snapshot: s, lost }, true);
  }

  private onEvent(e: SimEvent) {
    this.set({ events: [e, ...(this.pending.events ?? this.state.events)].slice(0, 50) }, true);
  }

  send = (cmd: ClientCommand) => {
    if (this.mock) this.mock.command(cmd);
    else this.socket?.emit("command", cmd);
  };

  get isMock() {
    return !!this.mock;
  }
}

let client: SimClient | null = null;
export function getSimClient(): SimClient {
  return (client ??= new SimClient());
}

export function useSim() {
  const c = getSimClient();
  useEffect(() => c.start(), [c]);
  const s = useSyncExternalStore(c.subscribe, c.getState, c.getServerState);
  return { ...s, send: c.send, frames: c.frames, client: c };
}
