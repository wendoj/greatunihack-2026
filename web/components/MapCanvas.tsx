"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { GRID, type AgentId, type Telemetry } from "@/lib/contract";
import type { ViewData, ViewKey } from "@/lib/belief";
import { agentColor, betterLink, LINK_COLORS } from "@/lib/colors";
import {
  buildOverlay,
  buildTerrain,
  cellCentre,
  drawCross,
  drawMountainGlyph,
  drawPin,
  drawTent,
  interpPos,
  type Pt,
  uiFont,
} from "@/lib/render";
import type { WorldMsg } from "@/lib/mock";
import type { Frames } from "@/lib/socket";

interface Props {
  world: WorldMsg;
  frames: Frames;
  views: Map<ViewKey, ViewData> | null;
  view: ViewKey;
  selected: AgentId | null;
  reveal: boolean;
  onSelect: (id: AgentId) => void;
  children?: React.ReactNode; // HTML overlays (banners)
}

interface Hover {
  cell: number;
  left: number;
  top: number;
}

const FADE_MS = 600;

export function MapCanvas({ world, frames, views, view, selected, reveal, onSelect, children }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const live = useRef({ views, view, selected, reveal, world });
  useLayoutEffect(() => {
    live.current = { views, view, selected, reveal, world };
  });
  const drawn = useRef(new Map<AgentId, Pt>());

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(([e]) => {
      const s = Math.floor(Math.min(e.contentRect.width, e.contentRect.height));
      setSize(s > 0 ? s : 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!size) return;
    const canvas = canvasRef.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d")!;
    const terrain = buildTerrain(world, px);
    const cell = px / GRID;
    const R = Math.max(7 * dpr, cell * 0.55);

    let overlay: HTMLCanvasElement | null = null;
    let overlayFor: ViewData | null = null;
    let fadeFrom: HTMLCanvasElement | null = null;
    let fadeAt = 0;
    let lastView: ViewKey | null = null;
    let lastFound = false;
    let raf = 0;

    const toPx = (p: Pt) => ({ x: p.x * cell, y: p.y * cell });

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const { views, view, selected, reveal } = live.current;
      const cur = frames.cur;
      const vd = views?.get(view) ?? views?.get("truth") ?? null;

      // Rebuild the belief overlay when the view's data changes. Cross-fade when a find lands in this view.
      if (vd && vd !== overlayFor) {
        const next = buildOverlay(vd, px);
        const foundNow = !!vd.found;
        if (lastView === view && foundNow && !lastFound && overlay) {
          fadeFrom = overlay;
          fadeAt = now;
        }
        overlay = next;
        overlayFor = vd;
        lastView = view;
        lastFound = foundNow;
      }

      ctx.clearRect(0, 0, px, px);
      ctx.drawImage(terrain, 0, 0);
      if (overlay) {
        const t = fadeFrom ? Math.min(1, (now - fadeAt) / FADE_MS) : 1;
        if (fadeFrom && t < 1) {
          ctx.globalAlpha = 1 - t;
          ctx.drawImage(fadeFrom, 0, 0);
          ctx.globalAlpha = t;
        } else fadeFrom = null;
        ctx.drawImage(overlay, 0, 0);
        ctx.globalAlpha = 1;
      }

      // Last known position and base marker.
      const lkp = toPx(cellCentre(world.lkp));
      drawPin(ctx, lkp.x, lkp.y - cell * 0.1, cell * 0.75);

      if (!cur) return;
      const prevById = new Map((frames.prev?.agents ?? []).map((a) => [a.id, a]));
      const f = (now - frames.curAt) / frames.interval;
      const pos = new Map<AgentId, Pt>();
      const walked = new Map<AgentId, number>();
      for (const a of cur.agents) {
        const r = interpPos(prevById.get(a.id), a, f);
        pos.set(a.id, toPx(r.p));
        walked.set(a.id, r.walked);
      }
      drawn.current = pos;

      // Radio links (better of both directions).
      const ag = cur.agents;
      for (let i = 0; i < ag.length; i++)
        for (let j = i + 1; j < ag.length; j++) {
          const a = ag[i], b = ag[j];
          if (selected && a.id !== selected && b.id !== selected) continue;
          const st = betterLink(a.links[b.id], b.links[a.id]);
          if (st !== "ok" && st !== "terrain" && st !== "storm") continue;
          const pa = pos.get(a.id)!, pb = pos.get(b.id)!;
          ctx.save();
          ctx.strokeStyle = LINK_COLORS[st]!;
          ctx.lineWidth = (st === "ok" ? 2 : 1.5) * dpr;
          if (st === "terrain") ctx.setLineDash([6 * dpr, 5 * dpr]);
          if (st === "storm") ctx.setLineDash([1.5 * dpr, 4 * dpr]);
          ctx.globalAlpha = st === "ok" ? 0.9 : 0.75;
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
          ctx.restore();
          if (st === "terrain") drawMountainGlyph(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, 6 * dpr, "#ef4444");
        }

      // Trails and target lines.
      for (const a of ag) {
        if (a.role === "base") continue;
        const color = agentColor(a.id);
        const p = pos.get(a.id)!;
        const w = walked.get(a.id)!;
        const pts = a.path.slice(0, w + 1).map((c) => toPx(cellCentre(c)));
        pts.push(p);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2 * dpr;
        ctx.lineCap = "round";
        for (let k = 1; k < pts.length; k++) {
          ctx.globalAlpha = 0.08 + 0.55 * (k / pts.length);
          ctx.beginPath();
          ctx.moveTo(pts[k - 1].x, pts[k - 1].y);
          ctx.lineTo(pts[k].x, pts[k].y);
          ctx.stroke();
        }
        if (a.target !== null && a.target !== a.pos) {
          const t = toPx(cellCentre(a.target));
          ctx.globalAlpha = selected && selected !== a.id ? 0.2 : 0.7;
          ctx.lineWidth = 1 * dpr;
          ctx.setLineDash([3 * dpr, 4 * dpr]);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(t.x, t.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(t.x, t.y, 2.5 * dpr, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Casualty: hidden until someone finds it (or Reveal).
      const anyFound = ag.find((a) => a.found)?.found ?? null;
      if (anyFound || reveal) {
        const c = toPx(cellCentre(anyFound?.cell ?? world.casualty));
        if (anyFound) {
          const ph = ((now / 1200) % 1) as number;
          ctx.save();
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = 2 * dpr;
          ctx.globalAlpha = 1 - ph;
          ctx.beginPath();
          ctx.arc(c.x, c.y, cell * (0.6 + ph * 1.8), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
        drawCross(ctx, c.x, c.y, cell * 0.8, anyFound ? 1 : 0.55);
      }

      // Lost agents: greyed at their last position.
      for (const [id, v] of frames.lastSeen) {
        if (pos.has(id)) continue;
        const p = toPx(cellCentre(v.tel.pos));
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = "#4b5563";
        ctx.beginPath();
        ctx.arc(p.x, p.y, R * 0.85, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#9ca3af";
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(p.x - R * 0.5, p.y - R * 0.5);
        ctx.lineTo(p.x + R * 0.5, p.y + R * 0.5);
        ctx.moveTo(p.x + R * 0.5, p.y - R * 0.5);
        ctx.lineTo(p.x - R * 0.5, p.y + R * 0.5);
        ctx.stroke();
        ctx.restore();
      }

      // Agents on top.
      for (const a of ag) drawAgent(ctx, a, pos.get(a.id)!, R, dpr, now, selected === a.id, !!selected && selected !== a.id);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, world, frames]);

  const cellAt = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * GRID);
    const y = Math.floor(((e.clientY - r.top) / r.height) * GRID);
    if (x < 0 || y < 0 || x >= GRID || y >= GRID) return null;
    return { cell: y * GRID + x, left: e.clientX - r.left, top: e.clientY - r.top, r };
  };

  const onClick = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const scale = canvasRef.current!.width / r.width;
    const mx = (e.clientX - r.left) * scale, my = (e.clientY - r.top) * scale;
    let best: AgentId | null = null, bestD = Infinity;
    for (const [id, p] of drawn.current) {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    const cell = canvasRef.current!.width / GRID;
    if (best && bestD < Math.max(14 * scale, cell)) onSelect(best);
  };

  const vd = views?.get(view) ?? views?.get("truth");

  return (
    <div ref={wrapRef} className="relative flex h-full w-full items-center justify-center">
      <div className="relative" style={{ width: size, height: size }}>
        <canvas
          ref={canvasRef}
          className="block h-full w-full cursor-crosshair rounded-lg ring-1 ring-hairline"
          style={{ width: size, height: size }}
          onMouseMove={(e) => {
            const c = cellAt(e);
            setHover(c ? { cell: c.cell, left: c.left, top: c.top } : null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
        />
        {children}
        {hover && vd && (
          <div
            className="pointer-events-none absolute z-20 rounded-lg border border-hairline bg-black/85 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground shadow-lg backdrop-blur tabular-nums"
            style={{
              left: Math.min(hover.left + 14, size - 170),
              top: Math.min(hover.top + 14, size - 96),
            }}
          >
            <div className="font-semibold">
              ({hover.cell % GRID},{Math.floor(hover.cell / GRID)})
            </div>
            <div className="text-muted-foreground">elev {world.elevation[hover.cell]} m</div>
            <div className="text-muted-foreground">prior {(world.prior[hover.cell] * 100).toFixed(2)}%</div>
            <div>belief {(vd.b[hover.cell] * 100).toFixed(2)}%</div>
            <div className="text-muted-foreground">swept ×{vd.counts[hover.cell]}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  a: Telemetry,
  p: Pt,
  R: number,
  dpr: number,
  now: number,
  isSel: boolean,
  dim: boolean,
) {
  ctx.save();
  if (dim) ctx.globalAlpha = 0.7;
  const color = agentColor(a.id);
  if (a.role === "base") {
    const s = R * 1.05;
    ctx.fillStyle = "#000";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.roundRect(p.x - s, p.y - s, s * 2, s * 2, 3 * dpr);
    ctx.fill();
    ctx.stroke();
    drawTent(ctx, p.x, p.y + s * 0.05, s * 1.2, color);
  } else {
    if (isSel) {
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R + 6 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#000000";
    ctx.font = `700 ${Math.round(R * 1.15)}px ${uiFont()}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.id, p.x, p.y + R * 0.05);

    const ring = (c: string, w: number, r: number, dash?: number[]) => {
      ctx.strokeStyle = c;
      ctx.lineWidth = w * dpr;
      ctx.setLineDash(dash ?? []);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (a.mode === "messenger") {
      const ph = (now / 900) % 1;
      ctx.globalAlpha = 1 - ph * 0.8;
      ring("#f59e0b", 2.5, R + 3 * dpr + ph * 6 * dpr);
      ctx.globalAlpha = dim ? 0.7 : 1;
    } else if (a.mode === "relay") ring("#a855f7", 2.5, R + 3 * dpr);
    else if (a.mode === "hold") {
      ring("#cbd5e1", 2, R + 3 * dpr);
      ctx.beginPath();
      ctx.moveTo(p.x - (R + 3 * dpr) * 0.7, p.y + (R + 3 * dpr) * 0.7);
      ctx.lineTo(p.x + (R + 3 * dpr) * 0.7, p.y - (R + 3 * dpr) * 0.7);
      ctx.stroke();
    }
    if (!a.radioOn) ring("#6b7280", 2, R + (a.mode === "search" ? 3 : 7) * dpr, [2 * dpr, 2 * dpr]);
  }
  ctx.restore();
}
