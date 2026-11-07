import { GRID, type CellIdx } from "../contract";

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const cx = (i: CellIdx) => i % GRID;
export const cy = (i: CellIdx) => (i / GRID) | 0;

export function cheb(a: CellIdx, b: CellIdx): number {
  return Math.max(Math.abs(cx(a) - cx(b)), Math.abs(cy(a) - cy(b)));
}

export function dist(a: CellIdx, b: CellIdx): number {
  return Math.hypot(cx(a) - cx(b), cy(a) - cy(b));
}

export const fmtCell = (i: CellIdx) => `(${cx(i)},${cy(i)})`;

// ---- base64 for Uint8Array, environment-agnostic (main thread + worker) ----
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV = new Uint8Array(128);
for (let i = 0; i < B64.length; i++) B64_REV[B64.charCodeAt(i)] = i;

export function encodeB64(u8: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = u8.length - i;
  if (rem === 1) {
    const n = u8[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

export function decodeB64(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < s.length && o < len; i += 4) {
    const n =
      (B64_REV[s.charCodeAt(i)] << 18) |
      (B64_REV[s.charCodeAt(i + 1)] << 12) |
      (B64_REV[s.charCodeAt(i + 2)] << 6) |
      B64_REV[s.charCodeAt(i + 3)];
    out[o++] = (n >> 16) & 255;
    if (o < len && s[i + 2] !== "=") out[o++] = (n >> 8) & 255;
    if (o < len && s[i + 3] !== "=") out[o++] = n & 255;
  }
  return out;
}
