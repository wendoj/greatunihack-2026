
// transport.js — serverless peer-to-peer messaging over a local network.
//
// No internet, no broker, no central server. Every agent joins a UDP multicast
// group on whatever local network exists (venue Wi-Fi, a phone hotspot with
// mobile data OFF, a travel router, or just one laptop). Anything an agent sends
// reaches every other agent on that network; each agent decides for itself what
// to do with it.
//
// Swap this file for a LoRa / Bluetooth transport later: agents only use
// start(), send(), onMessage(), onPeer() and stop().

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const DEFAULT_GROUP = '239.255.42.99'; // "administratively scoped" multicast: stays on the local network
const DEFAULT_PORT = 41234;

export class UdpTransport extends EventEmitter {
	/**
	 * @param {object} opts
	 * @param {string} opts.id                  this agent's id
	 * @param {string} [opts.group]             multicast group
	 * @param {number} [opts.port]              UDP port shared by all agents
	 * @param {number} [opts.heartbeatMs]       how often to announce "I'm here"
	 * @param {number} [opts.peerTimeoutMs]     forget a peer after this much silence
	 * @param {(msg, meta) => boolean} [opts.radioFilter]
	 *        optional receive-side filter, e.g. simulated range / line of sight.
	 *        Return false to drop the packet as if the radio never heard it.
	 */
	constructor({
		id,
		group = DEFAULT_GROUP,
		port = DEFAULT_PORT,
		heartbeatMs = 1000,
		peerTimeoutMs = 4000,
		radioFilter = () => true,
	}) {
		super();
		if (!id) throw new Error('id is required');
		this.id = String(id);
		this.group = group;
		this.port = port;
		this.heartbeatMs = heartbeatMs;
		this.peerTimeoutMs = peerTimeoutMs;
		this.radioFilter = radioFilter;
		this.peers = new Map(); // id -> { address, lastSeen }
		this.seq = 0;
		this.offline = false; // set true to simulate "radio off" for this agent
	}

	start() {
		return new Promise((resolve, reject) => {
			// reuseAddr lets several agents share one port, including on one laptop.
			this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			this.sock.on('error', (err) => {
				this.emit('error', err);
				reject(err);
			});
			this.sock.on('message', (buf, rinfo) => this.#receive(buf, rinfo));
			this.sock.bind(this.port, () => {
				try {
					for (const iface of localIPv4Interfaces()) {
						try { this.sock.addMembership(this.group, iface); } catch { /* interface may not support multicast */ }
					}
					this.sock.setMulticastTTL(1);         // never leave the local network
					this.sock.setMulticastLoopback(true); // agents on the same machine hear each other
				} catch (err) {
					return reject(err);
				}
				this.hb = setInterval(() => this.#heartbeat(), this.heartbeatMs);
				this.sweep = setInterval(() => this.#expirePeers(), 500);
				this.#heartbeat();
				resolve();
			});
		});
	}

	/** Send to everyone in range. `type` is free-form, `body` must be JSON-serialisable. */
	send(type, body = {}) {
		if (this.offline || !this.sock) return;
		const packet = JSON.stringify({ v: 1, from: this.id, seq: ++this.seq, t: Date.now(), type, body });
		const buf = Buffer.from(packet);
		if (buf.length > 60000) throw new Error(`message too large for one UDP packet: ${buf.length} bytes`);
		this.sock.send(buf, this.port, this.group);
	}

	onMessage(cb) { this.on('message', cb); return this; }
	onPeer(cb) { this.on('peer', cb); return this; }

	setOffline(offline) {
		this.offline = offline;
		this.emit('radio', offline ? 'off' : 'on');
	}

	stop() {
		clearInterval(this.hb);
		clearInterval(this.sweep);
		try { this.sock?.close(); } catch { /* already closed */ }
	}

	#heartbeat() { this.send('hello'); }

	#receive(buf, rinfo) {
		if (this.offline) return; // our own radio is off: we hear nothing
		let msg;
		try { msg = JSON.parse(buf.toString()); } catch { return; }
		if (msg?.v !== 1 || !msg.from || msg.from === this.id) return; // ignore junk and our own echo
		const meta = { address: rinfo.address, port: rinfo.port };
		if (!this.radioFilter(msg, meta)) return;

		const known = this.peers.has(msg.from);
		this.peers.set(msg.from, { address: rinfo.address, lastSeen: Date.now() });
		if (!known) this.emit('peer', { id: msg.from, status: 'joined', address: rinfo.address });

		if (msg.type !== 'hello') this.emit('message', msg, meta);
	}

	#expirePeers() {
		const now = Date.now();
		for (const [id, p] of this.peers) {
			if (now - p.lastSeen > this.peerTimeoutMs) {
				this.peers.delete(id);
				this.emit('peer', { id, status: 'lost' });
			}
		}
	}
}

function localIPv4Interfaces() {
	const out = [];
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const a of addrs ?? []) if (a.family === 'IPv4') out.push(a.address);
	}
	return out.length ? out : ['0.0.0.0'];
}
