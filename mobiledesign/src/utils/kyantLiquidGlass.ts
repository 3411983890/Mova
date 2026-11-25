import type { KyantHighlightStyle } from '../types';

export interface LensMapResult {
  dataUrl: string;
  scale: number;
}

const lensCache = new Map<string, LensMapResult>();
const highlightCache = new Map<string, string>();

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function sdRoundedRect(cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(cx) - (hx - r);
  const qy = Math.abs(cy) - (hy - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const outside = Math.hypot(ox, oy) - r;
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside;
}

function gradSdRoundedRect(cx: number, cy: number, hx: number, hy: number, r: number): [number, number] {
  const qx = Math.abs(cx) - (hx - r);
  const qy = Math.abs(cy) - (hy - r);
  const sx = sign(cx);
  const sy = sign(cy);
  if (qx >= 0 || qy >= 0) {
    const mx = Math.max(qx, 0);
    const my = Math.max(qy, 0);
    const len = Math.hypot(mx, my) || 1;
    return [(sx * mx) / len, (sy * my) / len];
  }
  const gradX = qx >= qy ? 1 : 0;
  return [sx * gradX, sy * (1 - gradX)];
}

function circleMap(x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  return 1 - Math.sqrt(Math.max(0, 1 - clamped * clamped));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Ported 1:1 from Kyant0/AndroidLiquidGlass `RoundedRectRefractionShaderString` + `Lens.kt`
 */
export function getKyantLensMap(
  width: number,
  height: number,
  cornerRadius: number,
  refractionHeight: number,
  refractionAmount: number,
  depthEffect: number
): LensMapResult {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round(height));
  const hx = w * 0.5;
  const hy = h * 0.5;
  const radius = Math.min(cornerRadius, hx, hy);
  const refH = Math.max(1, Math.min(refractionHeight, Math.min(hx, hy)));
  const refAmt = Math.max(0, refractionAmount);
  const depth = Math.max(0, depthEffect);

  const key = `${w}x${h}_r${radius.toFixed(1)}_rh${refH.toFixed(1)}_ra${refAmt.toFixed(1)}_d${depth.toFixed(2)}`;
  const cached = lensCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  // Encode displacement in [-maxDisp, +maxDisp] -> [0..255] with 127.5 as 0
  const maxDisp = Math.max(1, refAmt * 1.05);
  const scale = maxDisp * 2;
  const gradRadius = Math.min(radius * 1.5, Math.min(hx, hy));

  let p = 0;
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5 - hy;
    for (let x = 0; x < w; x++) {
      const cx = x + 0.5 - hx;
      const sd = sdRoundedRect(cx, cy, hx, hy, radius);

      let dx = 0;
      let dy = 0;
      let rimFactor = 0;

      if (sd < 0 && -sd < refH) {
        const clampedSd = Math.min(sd, 0);
        rimFactor = circleMap(1 - -clampedSd / refH);
        const d = -refAmt * rimFactor;

        const [gx, gy] = gradSdRoundedRect(cx, cy, hx, hy, gradRadius);
        const cLen = Math.hypot(cx, cy) || 1;
        const vx = gx + depth * (cx / cLen);
        const vy = gy + depth * (cy / cLen);
        const vLen = Math.hypot(vx, vy) || 1;

        dx = d * (vx / vLen);
        dy = d * (vy / vLen);
      }

      const rByte = Math.max(0, Math.min(255, Math.round((dx / scale + 0.5) * 255)));
      const gByte = Math.max(0, Math.min(255, Math.round((dy / scale + 0.5) * 255)));
      const bByte = Math.max(0, Math.min(255, Math.round(rimFactor * 255)));

      data[p++] = rByte;
      data[p++] = gByte;
      data[p++] = bByte;
      data[p++] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const result: LensMapResult = { dataUrl: canvas.toDataURL('image/png'), scale };
  lensCache.set(key, result);
  return result;
}

/**
 * Ported 1:1 from Kyant0/AndroidLiquidGlass `DefaultHighlightShaderString` & `AmbientHighlightShaderString`
 * Renders a 2x supersampled SDF-gradient rim stroke texture.
 */
export function getKyantHighlightMap(
  width: number,
  height: number,
  cornerRadius: number,
  style: KyantHighlightStyle,
  angleDeg: number,
  strokeWidth = 0.68
): string {
  const dpr = 2;
  const w = Math.max(8, Math.round(width * dpr));
  const h = Math.max(8, Math.round(height * dpr));
  const hx = w * 0.5;
  const hy = h * 0.5;
  const radius = Math.min(cornerRadius * dpr, hx, hy);
  const sw = strokeWidth * dpr;

  const key = `${w}x${h}_r${radius.toFixed(1)}_${style}_a${angleDeg.toFixed(0)}_sw${sw.toFixed(1)}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  const gradRadius = Math.min(radius * 1.5, Math.min(hx, hy));
  const rad = (angleDeg * Math.PI) / 180;
  const nx = Math.cos(rad);
  const ny = Math.sin(rad);
  const falloff = 1.15;

  let p = 0;
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5 - hy;
    for (let x = 0; x < w; x++) {
      const cx = x + 0.5 - hx;
      const sd = sdRoundedRect(cx, cy, hx, hy, radius);

      // Anti-aliased inner border ring between [-sw - 1.2, 0.5]
      if (sd > 0.6 || sd < -(sw + 1.5)) {
        p += 4;
        continue;
      }

      const outerAA = 1 - smoothstep(-0.6, 0.55, sd);
      const innerAA = smoothstep(-(sw + 1.4), -(sw * 0.35), sd);
      const ringAlpha = outerAA * innerAA;

      if (ringAlpha <= 0.004) {
        p += 4;
        continue;
      }

      let directional = 1;
      if (style === 'default') {
        const [gx, gy] = gradSdRoundedRect(cx, cy, hx, hy, gradRadius);
        const dot = gx * nx + gy * ny;
        // Kyant Default: twin opposite specular arcs + whisper-subtle flat sheen
        directional = 0.08 + 0.92 * Math.pow(Math.abs(dot), 1.35);
      } else if (style === 'ambient') {
        const [gx, gy] = gradSdRoundedRect(cx, cy, hx, hy, gradRadius);
        const dot = gx * nx + gy * ny;
        directional = dot <= 0 ? Math.pow(Math.abs(dot), falloff) : 0.12 * Math.pow(dot, 1.5);
      } else {
        directional = 0.65;
      }

      const a = Math.max(0, Math.min(255, Math.round(ringAlpha * directional * 255)));
      data[p++] = 255;
      data[p++] = 255;
      data[p++] = 255;
      data[p++] = a;
    }
  }

  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  highlightCache.set(key, url);
  return url;
}
