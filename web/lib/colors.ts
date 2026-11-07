import type { AgentId, LinkStatus, Mode, Strategy } from "./contract";

export const UI = {
  bg: "#000000",
  panel: "#080808",
  border: "#1a1a1a",
  text: "#e8edef",
  muted: "#8b8f91",
  brand: "#f7732b",
} as const;

export const AGENT_COLORS: Record<AgentId, string> = {
  A: "#60a5fa",
  B: "#f472b6",
  C: "#34d399",
  D: "#fbbf24",
  E: "#a78bfa",
  F: "#22d3ee",
  BASE: "#f8fafc",
};

export const agentColor = (id: AgentId) => AGENT_COLORS[id] ?? "#94a3b8";

export const LINK_COLORS: Partial<Record<LinkStatus, string>> = {
  ok: "#22c55e",
  terrain: "#ef4444",
  storm: "#6b7280",
};

export const STRATEGY_COLORS: Record<Strategy, string> = {
  ridgeline: "#22c55e",
  independent: "#f59e0b",
  central: "#ef4444",
};

export const STRATEGY_LABELS: Record<Strategy, string> = {
  ridgeline: "Ridgeline (ours)",
  independent: "Independent",
  central: "Central",
};

export const STRATEGY_TIPS: Record<Strategy, string> = {
  ridgeline:
    "Ours: each agent plans for itself, shares its map and plan with whoever it can hear, and avoids ground teammates are covering.",
  independent:
    "Baseline: each agent plans for itself but ignores its teammates completely.",
  central:
    "Baseline: the base station assigns every target. Agents stop and wait when orders stop arriving.",
};

export const MODE_STYLES: Record<Mode, { label: string; className: string }> = {
  search: { label: "search", className: "bg-white/5 text-foreground/70" },
  messenger: { label: "messenger", className: "bg-amber-500/20 text-amber-300" },
  relay: { label: "relay", className: "bg-violet-500/20 text-violet-300" },
  hold: { label: "hold", className: "bg-white/10 text-foreground/70" },
  converge: { label: "converge", className: "bg-emerald-500/20 text-emerald-300" },
  done: { label: "on scene", className: "bg-emerald-500/30 text-emerald-200" },
};

export const LINK_RANK: Record<LinkStatus, number> = {
  ok: 5,
  storm: 4,
  terrain: 3,
  range: 2,
  stale: 1,
  off: 0,
};

/** The better (more connected) of two link directions. */
export function betterLink(a?: LinkStatus, b?: LinkStatus): LinkStatus | undefined {
  if (!a) return b;
  if (!b) return a;
  return LINK_RANK[a] >= LINK_RANK[b] ? a : b;
}
