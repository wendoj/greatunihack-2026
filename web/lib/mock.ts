import { CONTRACT_VERSION, type ClientCommand, type SimEvent, type SimStatus, type Snapshot, type Strategy, type WorldMsg } from "./contract";
import { SimEngine } from "./sim/engine";

export type { WorldMsg };

export interface BridgeHandlers {
  world: (w: WorldMsg) => void;
  snapshot: (s: Snapshot) => void;
  event: (e: SimEvent) => void;
}

const SNAPSHOT_MS = 200;

/**
 * In-browser stand-in for the bridge. Emits exactly the bridge's Socket.IO shapes.
 * The engine underneath keeps every agent's state private; this class only steps it
 * and relays fault injection — it never tells an agent where to go.
 */
export class MockBridge {
  private engine!: SimEngine;
  private running = false;
  private tickMs = 250;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;
  private runId = 0;
  private cfg = { seed: 39, strategy: "ridgeline" as Strategy, agents: 5 };

  constructor(private on: BridgeHandlers) {
    this.reset(this.cfg);
    this.snapTimer = setInterval(() => this.emitSnapshot(), SNAPSHOT_MS);
  }

  dispose() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
  }

  private status(): SimStatus {
    return {
      runId: this.runId,
      running: this.running,
      strategy: this.cfg.strategy,
      seed: this.cfg.seed,
      agentCount: this.cfg.agents,
      storm: this.engine.storm,
      blackout: this.engine.blackout,
      tickMs: this.tickMs,
    };
  }

  private emitSnapshot() {
    const now = Date.now();
    for (const e of this.engine.drainEvents()) this.on.event({ t: now, runId: this.runId, ...e });
    this.on.snapshot({
      t: now,
      status: this.status(),
      agents: this.engine.telemetry(this.tickMs),
      metrics: this.engine.metrics(),
    });
  }

  private schedule() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.running) this.tickTimer = setInterval(() => this.engine.step(), this.tickMs);
  }

  private reset(cfg: { seed: number; strategy: Strategy; agents: number }) {
    const storm = this.engine?.storm ?? 0;
    this.cfg = cfg;
    this.runId++;
    this.engine = new SimEngine(cfg);
    if (storm) this.engine.control({ type: "storm", value: storm });
    this.engine.drainEvents();
    const { casualty, ...pub } = this.engine.world;
    this.on.world({ ...pub, casualty, runId: this.runId, contractVersion: CONTRACT_VERSION });
    this.on.event({
      t: Date.now(),
      runId: this.runId,
      kind: "reset",
      text: `Reset · seed ${cfg.seed} · ${cfg.strategy} · ${cfg.agents} agents`,
    });
  }

  command(cmd: ClientCommand) {
    switch (cmd.action) {
      case "start":
        this.running = true;
        this.schedule();
        break;
      case "pause":
        this.running = false;
        this.schedule();
        break;
      case "reset":
        this.running = false;
        this.schedule();
        this.reset({
          seed: cmd.seed ?? this.cfg.seed,
          strategy: cmd.strategy ?? this.cfg.strategy,
          agents: Math.max(3, Math.min(6, cmd.agents ?? this.cfg.agents)),
        });
        break;
      case "speed":
        this.tickMs = Math.max(50, Math.min(1000, cmd.tickMs));
        this.schedule();
        break;
      case "storm":
        this.engine.control({ type: "storm", value: cmd.value });
        break;
      case "blackout":
        this.engine.control({ type: "blackout", value: cmd.value });
        break;
      case "radio":
        this.engine.control({ type: "radio", agent: cmd.agent, value: cmd.value });
        break;
      case "kill":
        this.engine.control({ type: "kill", agent: cmd.agent });
        break;
    }
    this.emitSnapshot();
  }
}
