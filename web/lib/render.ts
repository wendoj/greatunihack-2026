import { CELLS, GRID, type CellIdx, type Telemetry, type WorldPublic } from "./contract";
import type { ViewData } from "./belief";

const cx = (i: number) => i % GRID;
const cy = (i: number) => (i / GRID) | 0;

let fontFamily: string | null = null;
/** Canvas can't resolve CSS vars, so read next/font's generated Geist family once. */
export function uiFont(): string {
  if (fontFamily) return fontFamily;
  const v = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-sans").trim();
  return (fontFamily = v ? `${v}, sans-serif` : "sans-serif");
}

function makeCanvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ------------------------------------------------------------------ terrain
function hillshade(world: WorldPublic): HTMLCanvasElement {
  const S = 8, W = GRID * S;
  const canvas = makeCanvas(W);
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, W);
  const E = world.elevation;
  const at = (x: number, y: number) => {
    const gx = Math.min(GRID - 1, Math.max(0, x - 0.5)), gy = Math.min(GRID - 1, Math.max(0, y - 0.5));
    const ix = Math.min(GRID - 2, Math.floor(gx)), iy = Math.min(GRID - 2, Math.floor(gy));
    const fx = gx - ix, fy = gy - iy;
    const e = (i: number, j: number) => E[j * GRID + i];
    return (
      (e(ix, iy) * (1 - fx) + e(ix + 1, iy) * fx) * (1 - fy) + (e(ix, iy + 1) * (1 - fx) + e(ix + 1, iy + 1) * fx) * fy
    );
  };
  let lo = Infinity, hi = -Infinity;
  for (const e of E) {
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
  }
  const L = [-1, -1, 1.3];
  const ln = Math.hypot(...L);
  const lx = L[0] / ln, ly = L[1] / ln, lz = L[2] / ln;
  const Z = 2.2; // vertical exaggeration
  const lowC = [52, 56, 58], midC = [92, 96, 96], highC = [170, 168, 160];
  for (let py = 0; py < W; py++)
    for (let px = 0; px < W; px++) {
      const X = (px + 0.5) / S, Y = (py + 0.5) / S;
      const e = at(X, Y);
      const dzdx = ((at(X + 0.3, Y) - at(X - 0.3, Y)) / (0.6 * world.cellMetres)) * Z;
      const dzdy = ((at(X, Y + 0.3) - at(X, Y - 0.3)) / (0.6 * world.cellMetres)) * Z;
      const nl = Math.hypot(dzdx, dzdy, 1);
      const shade = Math.max(0, (-dzdx * lx - dzdy * ly + lz) / nl);
      const t = (e - lo) / (hi - lo || 1);
      const [a, b, u] = t < 0.55 ? [lowC, midC, t / 0.55] : [midC, highC, (t - 0.55) / 0.45];
      const k = 0.6 + 0.6 * shade;
      const contour = Math.floor(e / 25) !== Math.floor(at(X + 1 / S, Y) / 25) || Math.floor(e / 25) !== Math.floor(at(X, Y + 1 / S) / 25);
      const o = (py * W + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let v = (a[ch] + (b[ch] - a[ch]) * u) * k;
        if (contour) v = v * 0.8 + 255 * 0.07;
        img.data[o + ch] = Math.min(255, v);
      }
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function linkCells(ctx: CanvasRenderingContext2D, flags: boolean[], cell: number) {
  ctx.beginPath();
  for (let i = 0; i < CELLS; i++) {
    if (!flags[i]) continue;
    const x = cx(i), y = cy(i);
    let linked = false;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID || !flags[ny * GRID + nx]) continue;
      ctx.moveTo((x + 0.5) * cell, (y + 0.5) * cell);
      ctx.lineTo((nx + 0.5) * cell, (ny + 0.5) * cell);
      linked = true;
    }
    if (!linked) {
      ctx.moveTo((x + 0.3) * cell, (y + 0.5) * cell);
      ctx.lineTo((x + 0.7) * cell, (y + 0.5) * cell);
    }
  }
  ctx.stroke();
}

/** Static layer at device resolution: hillshade, streams, paths. Rebuilt on world or size change. */
export function buildTerrain(world: WorldPublic, px: number): HTMLCanvasElement {
  const out = makeCanvas(px);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(hillshade(world), 0, 0, px, px);
  const cell = px / GRID;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(56,189,248,0.75)";
  ctx.lineWidth = Math.max(1, cell * 0.12);
  linkCells(ctx, world.isStream, cell);
  ctx.strokeStyle = "rgba(214,184,138,0.8)";
  ctx.setLineDash([cell * 0.12, cell * 0.28]);
  linkCells(ctx, world.isPath, cell);
  ctx.setLineDash([]);
  return out;
}

// ------------------------------------------------------------------ belief overlay
const AMBER = [251, 191, 36], RED = [239, 68, 68];

export function buildOverlay(view: ViewData, px: number): HTMLCanvasElement {
  const heat = makeCanvas(GRID);
  const hctx = heat.getContext("2d")!;
  const img = hctx.createImageData(GRID, GRID);
  for (let c = 0; c < CELLS; c++) {
    const t = view.max > 0 ? Math.sqrt(view.b[c] / view.max) : 0;
    const o = c * 4;
    for (let ch = 0; ch < 3; ch++) img.data[o + ch] = AMBER[ch] + (RED[ch] - AMBER[ch]) * t;
    img.data[o + 3] = Math.round(255 * Math.min(0.85, t * 0.85));
  }
  hctx.putImageData(img, 0, 0);

  const out = makeCanvas(px);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = !view.found;
  ctx.drawImage(heat, 0, 0, px, px);

  // Swept cells get a faint cool hatch: "this ground has been searched".
  const cell = px / GRID;
  ctx.strokeStyle = "rgba(186,230,253,0.22)";
  ctx.lineWidth = Math.max(1, cell * 0.06);
  ctx.beginPath();
  for (let c = 0; c < CELLS; c++) {
    if (!view.counts[c]) continue;
    const x = cx(c) * cell, y = cy(c) * cell;
    ctx.moveTo(x + cell * 0.15, y + cell * 0.85);
    ctx.lineTo(x + cell * 0.85, y + cell * 0.15);
    if (view.counts[c] > 1) {
      ctx.moveTo(x + cell * 0.15, y + cell * 0.45);
      ctx.lineTo(x + cell * 0.45, y + cell * 0.15);
    }
  }
  ctx.stroke();
  return out;
}

// ------------------------------------------------------------------ interpolation
export interface Pt {
  x: number;
  y: number;
}

/**
 * Where to draw an agent `f` (0..1) of the way through the latest snapshot interval.
 * Walks the cells in `path` between the previous and current position, so motion follows
 * the real route instead of cutting corners through a ridge. Returns cell-space coords
 * (cell centre = i + 0.5) and how much of `path` has been "walked" for the trail.
 */
export function interpPos(prev: Telemetry | undefined, cur: Telemetry, f: number): { p: Pt; walked: number } {
  const path = cur.path.length ? cur.path : [cur.pos];
  const snap = { p: { x: cx(cur.pos) + 0.5, y: cy(cur.pos) + 0.5 }, walked: path.length - 1 };
  if (!prev) return snap;
  const iPrev = path.lastIndexOf(prev.pos, path.length - 1);
  const k = path.length - 1 - iPrev;
  if (iPrev < 0 || k > 8) return snap;
  for (let i = iPrev; i < path.length - 1; i++)
    if (Math.max(Math.abs(cx(path[i]) - cx(path[i + 1])), Math.abs(cy(path[i]) - cy(path[i + 1]))) > 1) return snap;
  if (k === 0) return snap;
  const u = Math.min(1, Math.max(0, f)) * k;
  const i = Math.min(k - 1, Math.floor(u));
  const fr = u - i;
  const a = path[iPrev + i], b = path[iPrev + i + 1];
  return {
    p: { x: cx(a) + 0.5 + (cx(b) - cx(a)) * fr, y: cy(a) + 0.5 + (cy(b) - cy(a)) * fr },
    walked: iPrev + i,
  };
}

export const cellCentre = (i: CellIdx): Pt => ({ x: cx(i) + 0.5, y: cy(i) + 0.5 });

// ------------------------------------------------------------------ glyphs
export function drawMountainGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(x, y, s * 0.95, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.7, y + s * 0.45);
  ctx.lineTo(x - s * 0.15, y - s * 0.5);
  ctx.lineTo(x + s * 0.1, y - s * 0.05);
  ctx.lineTo(x + s * 0.3, y - s * 0.3);
  ctx.lineTo(x + s * 0.7, y + s * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawTent(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, color: string) {
  ctx.beginPath();
  ctx.moveTo(x - s * 0.6, y + s * 0.45);
  ctx.lineTo(x, y - s * 0.55);
  ctx.lineTo(x + s * 0.6, y + s * 0.45);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.1);
  ctx.lineTo(x - s * 0.18, y + s * 0.45);
  ctx.lineTo(x + s * 0.18, y + s * 0.45);
  ctx.closePath();
  ctx.fillStyle = "#000000";
  ctx.fill();
}

export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.fillStyle = "#fde68a";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = Math.max(1, s * 0.12);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - s * 0.45, y - s * 0.9);
  ctx.arc(x, y - s * 1.15, s * 0.55, Math.PI * 0.8, Math.PI * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#000000";
  ctx.font = `700 ${Math.round(s * 0.8)}px ${uiFont()}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("?", x, y - s * 1.12);
  ctx.restore();
}

export function drawCross(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ef4444";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(1, s * 0.12);
  const a = s * 0.22, b = s * 0.65;
  ctx.beginPath();
  ctx.rect(x - a, y - b, a * 2, b * 2);
  ctx.rect(x - b, y - a, b * 2, a * 2);
  ctx.stroke();
  ctx.fillRect(x - a, y - b, a * 2, b * 2);
  ctx.fillRect(x - b, y - a, b * 2, a * 2);
  ctx.restore();
}
