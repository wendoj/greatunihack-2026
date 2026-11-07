// agent.js — a tiny search agent that coordinates with peers with no server.
//
//   node agent.js A
//   node agent.js B
//   node agent.js C
//
// Each agent "sweeps" cells of a 10x10 grid, gossips what it has swept, and
// merges what it hears. Type `off` / `on` + Enter to cut this agent's radio,
// `status` to print its map, `quit` to exit. While its radio is off it keeps
// searching on its own; when it comes back, maps merge with no conflicts.

import readline from 'node:readline';
import { UdpTransport } from './transport.js';

const id = process.argv[2] ?? `agent-${Math.floor(Math.random() * 1000)}`;
const SIZE = 10;
const net = new UdpTransport({ id });

// ---- State that merges cleanly (grow-only) ----------------------------------
// swept[cell] = Set of agent ids that swept it. Merge = set union, so the
// result is the same whatever order messages arrive in, and repeats are harmless.
const swept = new Map();
let found = null; // once set, never unset
const casualty = `${Math.floor(Math.random() * SIZE)},${Math.floor(Math.random() * SIZE)}`;
// (each agent here picks its own fake casualty just for the demo)

function markSwept(cell, by) {
	if (!swept.has(cell)) swept.set(cell, new Set());
	swept.get(cell).add(by);
}

function merge(remote) {
	let learned = 0;
	for (const [cell, by] of Object.entries(remote.swept ?? {})) {
		for (const who of by) {
			if (!swept.get(cell)?.has(who)) learned++;
			markSwept(cell, who);
		}
	}
	if (!found && remote.found) {
		found = remote.found;
		log(`heard: casualty found at ${found.cell} by ${found.by}`);
	}
	return learned;
}

function snapshot() {
	const obj = {};
	for (const [cell, by] of swept) obj[cell] = [...by];
	return { swept: obj, found };
}

// ---- Independent decision: pick the nearest cell nobody is known to have swept
let pos = [Math.floor(Math.random() * SIZE), Math.floor(Math.random() * SIZE)];
function nextCell() {
	let best = null, bestD = Infinity;
	for (let x = 0; x < SIZE; x++) for (let y = 0; y < SIZE; y++) {
		if (swept.has(`${x},${y}`)) continue;
		const d = Math.abs(x - pos[0]) + Math.abs(y - pos[1]) + Math.random() * 0.5; // jitter spreads agents out
		if (d < bestD) { bestD = d; best = [x, y]; }
	}
	return best;
}

function step() {
	if (found) return;
	const target = nextCell();
	if (!target) { log('grid fully swept'); return; }
	pos = target;
	const cell = `${pos[0]},${pos[1]}`;
	markSwept(cell, id);
	if (cell === casualty) {
		found = { cell, by: id, t: Date.now() };
		log(`FOUND casualty at ${cell}`);
	}
}

// ---- Wire it up -------------------------------------------------------------
net.onPeer(({ id: peer, status }) => log(`peer ${peer} ${status}`));
net.onMessage((msg) => {
	if (msg.type === 'state') {
		const n = merge(msg.body);
		if (n) log(`merged ${n} new sweep(s) from ${msg.from}`);
	}
});

await net.start();
log(`online — group ${net.group}:${net.port}`);

setInterval(() => { step(); net.send('state', snapshot()); }, 1000);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
	const cmd = line.trim();
	if (cmd === 'off') { net.setOffline(true); log('radio OFF — searching alone'); }
	else if (cmd === 'on') { net.setOffline(false); log('radio ON'); }
	else if (cmd === 'status') printMap();
	else if (cmd === 'quit') { net.stop(); process.exit(0); }
});

function printMap() {
	const rows = [];
	for (let y = 0; y < SIZE; y++) {
		let row = '';
		for (let x = 0; x < SIZE; x++) row += swept.has(`${x},${y}`) ? '#' : '.';
		rows.push(row);
	}
	log(`map (${swept.size}/${SIZE * SIZE} swept, peers: ${[...net.peers.keys()].join(', ') || 'none'})\n${rows.join('\n')}`);
}

function log(s) { console.log(`[${id}] ${s}`); }
