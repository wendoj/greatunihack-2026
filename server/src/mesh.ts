// mesh.ts — serverless peer-to-peer transport over a local network.
//
// No internet, no broker, no central server. Every node discovers its peers on whatever
// local network exists (venue Wi-Fi, a phone hotspot with mobile data OFF, a travel router,
// or just one laptop) and connects to them over TCP. Messages flood across the resulting
// mesh, so a node several hops away is still reachable without any node being "in charge".
//
// Discovery and data are split on purpose:
//   * discovery — UDP beacons (broadcast + multicast, both loopback so processes on one
//     machine hear each other, and TTL 1 so nothing leaves the local network);
//   * data       — persistent TCP links, newline-delimited JSON, with (origin, seq) dedup
//     and a hop budget so a flooded message reaches everyone exactly once.
//
// The mesh is transport only. It carries whatever the application puts in `type`/`body`
// and never interprets it, so the "no central decision-maker" rule is preserved at the
// application layer (see agent-node.ts and web/lib/sim/agent.ts).

import dgram from "node:dgram";
import net from "node:net";
import os from "node:os";
import { EventEmitter } from "node:events";

export const MESH_VERSION = 1;

/** A flooded message as it travels the mesh. `from` is the ORIGIN node, never a relay. */
export interface MeshMessage {
  v: 1;
  from: string;
  seq: number; // per-origin monotonic sequence, used for dedup
  ttl: number; // remaining hops
  type: string;
  body: unknown;
}

export interface PeerEvent {
  id: string;
  status: "joined" | "lost";
  address?: string;
}

export interface MeshOptions {
  /** This node's id. Must be unique on the network. */
  id: string;
  /** UDP discovery port shared by every node (beacons are sent and received here). */
  discoveryPort?: number;
  /** TCP listen port; 0 picks a free ephemeral port (default). */
  tcpPort?: number;
  /** Multicast group used as an extra discovery channel alongside broadcast. */
  group?: string;
  /** Announce presence with a UDP broadcast to 255.255.255.255. */
  broadcast?: boolean;
  /** Announce presence on the multicast group (loopback on, TTL 1). */
  multicast?: boolean;
  /** Static peers to dial, "id@host:port" or "host:port". */
  peers?: string[];
  /** Beacon interval in ms. */
  heartbeatMs?: number;
  /** Forget a peer after this much silence (beacons or traffic). */
  peerTimeoutMs?: number;
  /** Default hop budget for broadcast(). */
  ttl?: number;
}

interface Conn {
  sock: net.Socket;
  peerId: string; // "" until the peer's handshake identifies it
  outbound: boolean;
  address: string;
  lastSeen: number;
  buffer: string;
  discarded?: boolean;
}

const DEFAULT_GROUP = "239.255.42.98";
const DEFAULT_DISCOVERY_PORT = 41238;
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_PEER_TIMEOUT_MS = 8000;
const DEFAULT_TTL = 8;

export class MeshNode extends EventEmitter {
  readonly id: string;
  tcpPort = 0;

  private opts: Required<Omit<MeshOptions, "peers">> & { peers: string[] };
  private server: net.Server | null = null;
  private udp: dgram.Socket | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  /** Highest sequence seen per origin. Reset when a peer (re)joins so a restarted node works. */
  private seen = new Map<string, number>();
  private conns = new Map<string, Conn>();
  private pending = new Set<Conn>();
  private started = false;

  constructor(opts: MeshOptions) {
    super();
    if (!opts.id) throw new Error("mesh node requires an id");
    this.id = String(opts.id);
    this.opts = {
      id: this.id,
      discoveryPort: opts.discoveryPort ?? DEFAULT_DISCOVERY_PORT,
      tcpPort: opts.tcpPort ?? 0,
      group: opts.group ?? DEFAULT_GROUP,
      broadcast: opts.broadcast ?? true,
      multicast: opts.multicast ?? true,
      peers: opts.peers ?? [],
      heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      peerTimeoutMs: opts.peerTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS,
      ttl: opts.ttl ?? DEFAULT_TTL,
    };
  }

  /** Bind TCP + UDP and start beacons. Resolves to the bound TCP port. */
  async start(): Promise<number> {
    if (this.started) return this.tcpPort;
    this.started = true;

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => this.#onInbound(sock));
      server.once("error", reject);
      server.listen(this.opts.tcpPort, "0.0.0.0", () => {
        const addr = server.address();
        this.tcpPort = typeof addr === "object" && addr ? addr.port : this.opts.tcpPort;
        this.server = server;
        resolve();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
      udp.on("error", reject);
      udp.on("message", (buf, rinfo) => this.#onBeacon(buf, rinfo));
      udp.bind(this.opts.discoveryPort, "0.0.0.0", () => {
        try {
          udp.setBroadcast(this.opts.broadcast);
          udp.setMulticastTTL(1); // never leave the local network
          udp.setMulticastLoopback(true); // processes on one machine hear each other
          if (this.opts.multicast)
            for (const iface of localIPv4())
              try {
                udp.addMembership(this.opts.group, iface);
              } catch {
                /* interface without multicast */
              }
        } catch {
          /* discovery is best-effort; static peers still work */
        }
        this.udp = udp;
        resolve();
      });
    });

    for (const spec of this.opts.peers) this.connect(spec);
    this.hbTimer = setInterval(() => this.#heartbeat(), this.opts.heartbeatMs);
    this.#heartbeat();
    return this.tcpPort;
  }

  stop() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    for (const conn of this.conns.values()) conn.sock.destroy();
    for (const conn of this.pending) conn.sock.destroy();
    this.conns.clear();
    this.pending.clear();
    try {
      this.udp?.close();
    } catch {}
    try {
      this.server?.close();
    } catch {}
    this.started = false;
  }

  /** Flood a message to the whole mesh (not delivered back to this node). */
  broadcast(type: string, body: unknown = {}, ttl: number = this.opts.ttl) {
    const frame: MeshMessage = { v: MESH_VERSION, from: this.id, seq: ++this.seq, ttl, type, body };
    this.seen.set(this.id, frame.seq);
    for (const conn of this.conns.values()) this.#write(conn, frame);
  }

  /** Dial a peer directly, bypassing discovery: "id@host:port" or "host:port". */
  connect(spec: string) {
    const p = parsePeer(spec);
    if (!p) return;
    this.#dial(p.id, p.host, p.port);
  }

  peerIds(): string[] {
    return [...this.conns.keys()];
  }

  onMessage(cb: (msg: MeshMessage) => void): this {
    return this.on("message", cb) as this;
  }
  onPeer(cb: (evt: PeerEvent) => void): this {
    return this.on("peer", cb) as this;
  }

  // ------------------------------------------------------------------ discovery
  #heartbeat() {
    const beacon = Buffer.from(JSON.stringify({ v: MESH_VERSION, id: this.id, tcpPort: this.tcpPort }), "utf8");
    if (this.opts.broadcast && this.udp)
      try {
        this.udp.send(beacon, 0, beacon.length, this.opts.discoveryPort, "255.255.255.255");
      } catch {}
    if (this.opts.multicast && this.udp)
      try {
        this.udp.send(beacon, 0, beacon.length, this.opts.discoveryPort, this.opts.group);
      } catch {}
    this.#expire();
  }

  #onBeacon(buf: Buffer, rinfo: dgram.RemoteInfo) {
    let b: { v?: number; id?: string; tcpPort?: number };
    try {
      b = JSON.parse(buf.toString("utf8"));
    } catch {
      return;
    }
    if (b?.v !== MESH_VERSION || typeof b.id !== "string" || b.id === this.id) return;
    const peerId = b.id;
    const existing = this.conns.get(peerId);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.address = rinfo.address;
      return;
    }
    // One side dials so we never open two links to the same peer: the lexicographically
    // larger id initiates; the smaller id accepts. The larger keeps retrying on every beacon.
    const port = Number(b.tcpPort);
    if (this.id > peerId && port > 0) this.#dial(peerId, rinfo.address, port);
  }

  #expire() {
    const now = Date.now();
    for (const conn of [...this.conns.values()]) if (now - conn.lastSeen > this.opts.peerTimeoutMs) conn.sock.destroy();
    for (const conn of [...this.pending]) if (now - conn.lastSeen > this.opts.peerTimeoutMs) conn.sock.destroy();
  }

  // ------------------------------------------------------------------ connections
  #onInbound(sock: net.Socket) {
    const conn: Conn = {
      sock,
      peerId: "",
      outbound: false,
      address: sock.remoteAddress ?? "",
      lastSeen: Date.now(),
      buffer: "",
    };
    this.pending.add(conn);
    // We answer with our own handshake too, so a static "host:port" dialer learns who we are.
    this.#write(conn, { v: MESH_VERSION, type: "handshake", from: this.id, tcpPort: this.tcpPort });
    sock.on("data", (chunk) => this.#onData(conn, chunk));
    sock.on("error", () => this.#dropConn(conn));
    sock.on("close", () => this.#dropConn(conn));
  }

  #dial(peerId: string, host: string, port: number) {
    if (peerId && this.conns.has(peerId)) return;
    if (peerId === this.id) return;
    const sock = net.connect(port, host);
    const conn: Conn = {
      sock,
      peerId,
      outbound: true,
      address: host,
      lastSeen: Date.now(),
      buffer: "",
    };
    this.pending.add(conn);
    sock.on("connect", () => {
      this.#write(conn, { v: MESH_VERSION, type: "handshake", from: this.id, tcpPort: this.tcpPort });
      if (conn.peerId) this.#adopt(conn);
    });
    sock.on("data", (chunk) => this.#onData(conn, chunk));
    sock.on("error", () => this.#dropConn(conn));
    sock.on("close", () => this.#dropConn(conn));
  }

  #adopt(conn: Conn) {
    const pid = conn.peerId;
    if (!pid || pid === this.id) {
      conn.sock.destroy();
      return;
    }
    const existing = this.conns.get(pid);
    if (existing === conn) return;
    if (existing) {
      // Duplicate link (e.g. both sides dialled at once). Keep the deterministic one.
      const keepInbound = this.id < pid; // smaller id accepts, larger id dials
      if (keepInbound === !conn.outbound) {
        existing.discarded = true;
        existing.sock.destroy();
        this.conns.set(pid, conn);
        this.seen.delete(pid);
      } else {
        conn.discarded = true;
        conn.sock.destroy();
      }
      return;
    }
    this.conns.set(pid, conn);
    this.pending.delete(conn);
    this.seen.delete(pid); // a rejoined peer may restart its sequence
    this.emit("peer", { id: pid, status: "joined", address: conn.address });
  }

  #dropConn(conn: Conn) {
    this.pending.delete(conn);
    if (conn.discarded) return;
    const pid = conn.peerId;
    if (pid && this.conns.get(pid) === conn) {
      this.conns.delete(pid);
      this.emit("peer", { id: pid, status: "lost", address: conn.address });
    }
    try {
      conn.sock.destroy();
    } catch {}
  }

  // ------------------------------------------------------------------ wire
  #write(conn: Conn, obj: unknown) {
    const s = conn.sock;
    if (s.destroyed || !s.writable) return;
    try {
      s.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  #onData(conn: Conn, chunk: Buffer) {
    conn.buffer += chunk.toString("utf8");
    let i;
    while ((i = conn.buffer.indexOf("\n")) >= 0) {
      const line = conn.buffer.slice(0, i);
      conn.buffer = conn.buffer.slice(i + 1);
      if (line.trim()) this.#onLine(conn, line);
    }
    if (conn.buffer.length > 1_000_000) conn.sock.destroy(); // refuse an unterminated blob
  }

  #onLine(conn: Conn, line: string) {
    let frame: { v?: number; type?: string; from?: string; seq?: number; ttl?: number; body?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame?.v !== MESH_VERSION || typeof frame.from !== "string") return;
    conn.lastSeen = Date.now();

    if (frame.type === "handshake") {
      if (frame.from === this.id) {
        conn.sock.destroy();
        return;
      }
      if (conn.peerId && conn.peerId !== frame.from) return;
      conn.peerId = frame.from;
      this.#adopt(conn);
      return;
    }

    if (!conn.peerId) return; // not identified yet (handshake always comes first)
    if (frame.from === this.id) return;
    const seq = Number(frame.seq);
    if (!Number.isFinite(seq)) return;
    if ((this.seen.get(frame.from) ?? -1) >= seq) return; // already seen → drop, no loop
    this.seen.set(frame.from, seq);

    const msg: MeshMessage = {
      v: MESH_VERSION,
      from: frame.from,
      seq,
      ttl: Number(frame.ttl) || 0,
      type: frame.type ?? "",
      body: frame.body,
    };
    this.emit("message", msg);
    if (msg.ttl > 1) {
      const out: MeshMessage = { ...msg, ttl: msg.ttl - 1 };
      for (const [pid, c] of this.conns) if (pid !== conn.peerId) this.#write(c, out);
    }
  }
}

export function parsePeer(s: string): { id: string; host: string; port: number } | null {
  const m = /^(?:([^@]+)@)?([^:]+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (!(port > 0 && port < 65536)) return null;
  return { id: m[1] ?? "", host: m[2], port };
}

function localIPv4(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? []) if (a.family === "IPv4") out.push(a.address);
  return out;
}
