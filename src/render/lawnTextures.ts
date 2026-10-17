import { mulberry32 } from '../physics/errorModel';
import { canvasTex, makeCanvas, normalFromHeight, sizeFor, type MapSet, type Quality } from './textures';

/** Metres of turf covered by one tile of the grass maps. */
export const GRASS_TILE = 2.2;

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/**
 * Dense turf seen from above: layers of short blade strokes over dark
 * thatch, deepest and darkest first, so gaps read as shadow between blades.
 * The ground shader tints it per style and blends it at two scales; the
 * map's mean linear colour is stored in `map.userData.mean` so the shader
 * can use it as neutral detail. Tiles seamlessly.
 */
export function grassMaps(q: Quality): MapSet {
  const S = sizeFor(q, 1024);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgb(30,42,17)';
  ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'round';
  const rnd = mulberry32(77);
  const pxPerM = S / GRASS_TILE;
  // Layers from the shaded thatch up to sunlit tips: coverage, stroke
  // length (m), stroke width (px at 1024), darkest and brightest colour.
  const layers: [number, number, number, number, number[], number[]][] = [
    [1.6, 0.012, 0.03, 2.4, [36, 56, 20], [62, 88, 32]],
    [1.3, 0.008, 0.022, 2.0, [52, 80, 28], [86, 118, 42]],
    [0.9, 0.005, 0.015, 1.7, [70, 104, 36], [112, 146, 56]],
    [0.12, 0.004, 0.012, 1.6, [118, 132, 64], [150, 160, 92]],
  ];
  const buckets = 6;
  for (const [cover, l0, l1, w1024, lo, hi] of layers) {
    const w = Math.max(1, (w1024 * S) / 1024);
    const meanLen = ((l0 + l1) / 2) * pxPerM;
    const n = Math.round((cover * S * S) / (meanLen * w));
    for (let b = 0; b < buckets; b++) {
      const k = (b + 0.5) / buckets;
      ctx.strokeStyle = `rgb(${lo.map((v, i) => Math.round(v + (hi[i] - v) * k)).join(',')})`;
      ctx.lineWidth = w * (0.8 + 0.4 * rnd());
      ctx.beginPath();
      for (let i = 0; i < n / buckets; i++) {
        const x = rnd() * S, y = rnd() * S;
        const a = rnd() * Math.PI * 2;
        const len = (l0 + (l1 - l0) * rnd()) * pxPerM;
        const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
        // Draw wrapped copies of strokes that cross an edge so the tile is seamless.
        for (const ox of [-S, 0, S])
          for (const oy of [-S, 0, S]) {
            const sx = x + ox, sy = y + oy;
            if (Math.max(sx, sx + dx) < -w || Math.min(sx, sx + dx) > S + w || Math.max(sy, sy + dy) < -w || Math.min(sy, sy + dy) > S + w) continue;
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + dx, sy + dy);
          }
      }
      ctx.stroke();
    }
  }
  const img = ctx.getImageData(0, 0, S, S).data;
  const h = new Float32Array(S * S);
  const mean = [0, 0, 0];
  for (let i = 0; i < S * S; i++) {
    const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2];
    mean[0] += toLinear(r);
    mean[1] += toLinear(g);
    mean[2] += toLinear(b);
    h[i] = (r * 0.3 + g * 0.6 + b * 0.1) / 255;
  }
  const map = canvasTex(c, true);
  map.userData.mean = mean.map((v) => v / (S * S));
  return { map, normalMap: canvasTex(normalFromHeight(h, S, 2.2), false) };
}
