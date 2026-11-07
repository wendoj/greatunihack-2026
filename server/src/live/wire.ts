// UDP multicast wire format for the live simulation.
//
// Three channels on one administratively scoped group (never leaves the LAN):
//   state     agent ⇄ agent gossip. Radio-filtered by the RECEIVER.
//   telemetry agent → bridge. Observation only; no agent ever reads it.
//   control   bridge → agents. Environment faults only (storm, blackout, kill…), never goals.
//
// Every packet is JSON, deflated. macOS caps UDP datagrams at 9216 bytes, and the sweep
// tables are mostly zeros, so deflate takes a ~16 KB state message down to ~2-4 KB.

import dgram from "node:dgram";
import os from "node:os";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { CELLS, type AgentId } from "../../../web/lib/contract";
import type { TableSnap, WireState } from "../../../web/lib/sim/agent";
import { decodeB64, encodeB64 } from "../../../web/lib/sim/util";

export const GROUP = process.env.RIDGELINE_GROUP ?? "239.255.42.99";
export const PORTS = { state: 41235, telemetry: 41236, control: 41237 } as const;
const MAX_DGRAM = 9000;

export function pack(obj: unknown): Buffer {
  const buf = deflateRawSync(Buffer.from(JSON.stringify(obj)));
  if (buf.length > MAX_DGRAM) throw new Error(`packet is ${buf.length} B, over the ${MAX_DGRAM} B UDP limit`);
  return buf;
}

export function unpack<T>(buf: Buffer): T | null {
  try {
    return JSON.parse(inflateRawSync(buf).toString()) as T;
  } catch {
    return null;
  }
}

export interface Channel {
  send(obj: unknown): void;
  close(): void;
}

/** Join the multicast group on one port. Loopback is on, so processes on one machine hear each other. */
export function channel(port: number, onMessage?: (buf: Buffer) => void): Promise<Channel> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sock.on("error", reject);
    if (onMessage) sock.on("message", (b) => onMessage(b));
    sock.bind(port, () => {
      let joined = false;
      for (const iface of ipv4Interfaces())
        try {
          sock.addMembership(GROUP, iface);
          joined = true;
        } catch {
          /* interface without multicast */
        }
      if (!joined) sock.addMembership(GROUP);
      sock.setMulticastTTL(1);
      sock.setMulticastLoopback(true);
      resolve({
        send: (obj) => sock.send(pack(obj), port, GROUP),
        close: () => {
          try {
            sock.close();
          } catch {}
        },
      });
    });
  });
}

function ipv4Interfaces(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === "IPv4") out.push(a.address);
  return out;
}

// ---- WireState <-> JSON --------------------------------------------------------------

interface JsonTable {
  v: number;
  d: string;
  r: number[];
}
export type JsonState = Omit<WireState, "tables"> & { type: "state"; runId: number; tables: Record<AgentId, JsonTable> };

const encCache = new WeakMap<Uint8Array, string>();
const enc = (u8: Uint8Array) => {
  let s = encCache.get(u8);
  if (!s) encCache.set(u8, (s = encodeB64(u8)));
  return s;
};
export { enc as encodeTable };

export function stateToJson(m: WireState, runId: number): JsonState {
  const tables: Record<AgentId, JsonTable> = {};
  for (const id in m.tables) {
    const t = m.tables[id];
    tables[id] = { v: t.v, d: enc(t.data), r: Array.from(t.recent) };
  }
  return { ...m, type: "state", runId, tables };
}

const decCache = new Map<string, Uint8Array>();
export function stateFromJson(j: JsonState): WireState {
  const tables: Record<AgentId, TableSnap> = {};
  for (const id in j.tables) {
    const t = j.tables[id];
    let data = decCache.get(t.d);
    if (!data) {
      if (decCache.size > 400) decCache.clear();
      decCache.set(t.d, (data = decodeB64(t.d, CELLS)));
    }
    tables[id] = { v: t.v, data, recent: Int32Array.from(t.r) };
  }
  const { type: _t, runId: _r, ...rest } = j;
  return { ...rest, tables };
}
