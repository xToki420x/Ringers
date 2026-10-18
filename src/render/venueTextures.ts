import * as THREE from 'three';
import { canvasTex, concreteMaps, fbm, hash, makeCanvas, mix, normalFromHeight, sizeFor, vnoise, type MapSet, type Quality } from './textures';

/**
 * Procedural surfaces for venue buildings and props: painted lap siding,
 * asphalt shingles, sawn planks, gravel, rippled water and chain-link
 * mesh. Colour maps are kept near neutral where a prop is painted, so one
 * map serves every paint colour through the material's `color`. Every map
 * is built once per quality tier and shared by all venues.
 */

const cache = new Map<string, unknown>();
function memo<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Paint a colour field and a height field per pixel into a map set. */
function paint(S: number, strength: number, px: (u: number, v: number, out: number[]) => number): MapSet {
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  const col = [0, 0, 0];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      h[y * S + x] = px(x / S, y / S, col);
      const i = (y * S + x) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return { map: canvasTex(c, true), normalMap: canvasTex(normalFromHeight(h, S, strength), false) };
}

/** Painted lap siding: 8 laps per tile, each lap's lower edge casting a thin shadow on the one below. */
export const sidingMaps = (q: Quality): MapSet =>
  memo(`siding:${q}`, () =>
    paint(sizeFor(q, 256), 2, (u, v, out) => {
      const laps = 8;
      const t = (v * laps) % 1; // 0 at the top of a lap, 1 at its overlapping lower edge
      const grain = vnoise(u * 6, v * 160, 6, 3) * 0.5 + fbm(u * 4, v * 4, 4, 3, 4) * 0.5;
      const shadow = 1 - 0.38 * (1 - smooth(0, 0.14, t));
      const g = (226 + (grain - 0.5) * 16) * shadow;
      out[0] = g;
      out[1] = g;
      out[2] = g * 0.98;
      return t * 0.6 + grain * 0.05;
    }),
  );

/** Asphalt shingles: staggered three-tab courses with granular grit (neutral; tinted by the material). */
export const shingleMaps = (q: Quality): MapSet =>
  memo(`shingle:${q}`, () => {
    const S = sizeFor(q, 256);
    return paint(S, 3, (u, v, out) => {
      const rows = 7;
      const row = Math.floor(v * rows);
      const t = (v * rows) % 1;
      const tabU = (u * 3 + (row % 2) * 0.5) % 1;
      const tab = Math.floor(u * 3 + (row % 2) * 0.5);
      const slot = Math.abs(tabU - 0.5) > 0.485 && t > 0.35 ? 0.55 : 1;
      const tone = 0.82 + hash(tab, row, 11) * 0.3;
      const grit = hash(Math.floor(u * S), Math.floor(v * S), 12);
      const edge = 1 - 0.45 * (1 - smooth(0, 0.12, t));
      const g = (88 + grit * 60) * tone * slot * edge;
      out[0] = g;
      out[1] = g * 0.97;
      out[2] = g * 0.94;
      return t * 0.5 + grit * 0.12 - (slot < 1 ? 0.3 : 0);
    });
  });

/**
 * Sawn planks with the grain along U and `planks` boards across V, each
 * board its own tone, with dark gaps and a nail pair at each end. The wood
 * is a light neutral tone: materials stain it with their colour.
 */
export const plankMaps = (q: Quality, planks: number): MapSet =>
  memo(`planks:${q}:${planks}`, () =>
    paint(sizeFor(q, 256), 2, (u, v, out) => {
      const pv = v * planks;
      const board = Math.floor(pv);
      const t = pv - board;
      const tone = 0.86 + hash(board, 0, 7) * 0.26;
      const warp = fbm(u * 2, v * 6, 2, 3, 8) * 3;
      const ring = Math.sin((t * 6 + warp + board * 1.7) * Math.PI) * 0.5 + 0.5;
      const streak = vnoise(u * 10, v * 260, 10, 9);
      const weather = fbm(u * 5, v * 5, 5, 3, 10);
      const gap = smooth(0, 0.035, t) * smooth(0, 0.035, 1 - t);
      const du = Math.min(Math.abs(u - 0.06), Math.abs(u - 0.94)), dt = (Math.abs(t - 0.5) - 0.22) / planks;
      const nail = du * du + dt * dt < 0.000025 ? 0.45 : 1;
      const k = (0.68 + 0.32 * (0.4 + ring * 0.2 + (streak - 0.5) * 0.3 + (weather - 0.5) * 0.3)) * tone * (0.35 + 0.65 * gap) * nail;
      out[0] = 214 * k;
      out[1] = 178 * k;
      out[2] = 140 * k;
      return streak * 0.2 + ring * 0.1 + gap * 0.8;
    }),
  );

/** Broom-finished concrete for slabs and foundations (the court's own maps, built once more and shared by the venues). */
export const slabMaps = (q: Quality): MapSet => memo(`slab:${q}`, () => concreteMaps(q));

/** Path gravel: packed fines with rounded stones of mixed tones. */
export const gravelMaps = (q: Quality): MapSet =>
  memo(`gravel:${q}`, () => {
    const cells = 22;
    return paint(sizeFor(q, 256), 3.5, (u, v, out) => {
      // Nearest stone centre (cellular noise, tileable).
      let d1 = 9, d2 = 9, id = 0;
      const cx = Math.floor(u * cells), cy = Math.floor(v * cells);
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i, gy = cy + j;
          const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
          const px = gx + 0.15 + hash(wx, wy, 21) * 0.7, py = gy + 0.15 + hash(wx, wy, 22) * 0.7;
          const d = Math.hypot(u * cells - px, v * cells - py);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            id = wx * 131 + wy;
          } else if (d < d2) d2 = d;
        }
      const stone = smooth(0.06, 0.2, d2 - d1);
      const dome = stone * Math.sqrt(Math.max(0, 1 - d1 * 1.4));
      const tone = hash(id, 1, 23);
      const fines = fbm(u * 16, v * 16, 16, 3, 24);
      const base = mix([118, 106, 90], [150, 140, 122], fines);
      const rock = mix(mix([128, 124, 118], [178, 168, 150], tone), [96, 88, 80], hash(id, 2, 25) > 0.8 ? 0.7 : 0);
      const c = mix(base, rock.map((x) => x * (0.75 + dome * 0.35)), stone);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return dome * 0.8 + fines * 0.1;
    });
  });

/** Wind ripples on open water: a tileable normal map of crossing wavelets. */
export const waterNormal = (q: Quality): THREE.Texture =>
  memo(`water:${q}`, () => {
    const S = sizeFor(q, 256);
    const h = new Float32Array(S * S);
    const waves = [[3, 1, 0.3], [-2, 4, 0.22], [5, -3, 0.14], [1, 7, 0.1], [-8, 3, 0.06], [11, 6, 0.04]];
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = x / S, v = y / S;
        let s = 0;
        for (const [a, b, amp] of waves) s += Math.sin((u * a + v * b) * Math.PI * 2 + a * 1.3) * amp;
        h[y * S + x] = s + fbm(u * 8, v * 8, 8, 4, 31) * 0.35;
      }
    return canvasTex(normalFromHeight(h, S, S / 64), false);
  });

/** Chain-link mesh as an alpha map: one diamond of galvanised wire per tile. */
export const chainLinkAlpha = (): THREE.Texture =>
  memo('chainlink', () => {
    const S = 64;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, S / 2);
    ctx.lineTo(S / 2, 0);
    ctx.lineTo(S, S / 2);
    ctx.lineTo(S / 2, S);
    ctx.closePath();
    ctx.stroke();
    const t = canvasTex(c, false);
    t.anisotropy = 4;
    return t;
  });

/** Soft rounded-rectangle shadow (alpha), stretched under props to seat them on the ground. */
export const softShadow = (): THREE.Texture =>
  memo('softShadow', () => {
    const S = 64;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const ax = Math.abs((x + 0.5) / S - 0.5) * 2, ay = Math.abs((y + 0.5) / S - 0.5) * 2;
        const d = Math.pow(ax ** 4 + ay ** 4, 0.25);
        data.fill(Math.round((1 - smooth(0.45, 1, d)) * 255), (y * S + x) * 4, (y * S + x) * 4 + 4);
      }
    const t = new THREE.DataTexture(data, S, S);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  });

/** Warm radial glow for lamps and bulbs (additive sprites and points). */
export const glowTexture = (): THREE.Texture =>
  memo('glow', () => {
    const c = makeCanvas(128);
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,250,235,1)');
    gr.addColorStop(0.2, 'rgba(255,240,210,0.6)');
    gr.addColorStop(1, 'rgba(255,230,200,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });

/** Alpha across a path or shore strip (v = 0..1): solid in the middle, feathered at both edges. */
export const edgeFade = (): THREE.Texture =>
  memo('edgeFade', () => {
    const S = 64;
    const data = new Uint8Array(4 * S * 4);
    for (let y = 0; y < S; y++) {
      const v = (y + 0.5) / S;
      const a = Math.round(smooth(0, 0.22, v) * smooth(0, 0.22, 1 - v) * 255);
      for (let x = 0; x < 4; x++) data.fill(a, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    }
    const t = new THREE.DataTexture(data, 4, S);
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  });

/**
 * Office-tower facades for a distant skyline: a grid of windows on
 * concrete bands (`map`), and which windows are lit after dark (`lit`).
 */
export const facadeMaps = (): { map: THREE.Texture; lit: THREE.Texture } =>
  memo('facade', () => {
    const S = 256, cols = 16, rows = 32;
    const day = makeCanvas(S), night = makeCanvas(S);
    const d = day.getContext('2d')!, n = night.getContext('2d')!;
    d.fillStyle = '#8d939a';
    d.fillRect(0, 0, S, S);
    n.fillStyle = '#000';
    n.fillRect(0, 0, S, S);
    const cw = S / cols, ch = S / rows;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const k = 40 + hash(i, j, 61) * 40;
        d.fillStyle = `rgb(${k * 0.8},${k * 0.95},${k * 1.15})`;
        d.fillRect(i * cw + 1, j * ch + 1.5, cw - 2, ch - 3);
        if (hash(i, j, 62) < 0.35) {
          const w = 160 + hash(i, j, 63) * 90;
          n.fillStyle = `rgb(${w},${w * 0.85},${w * 0.6})`;
          n.fillRect(i * cw + 1, j * ch + 1.5, cw - 2, ch - 3);
        }
      }
    return { map: canvasTex(day, true), lit: canvasTex(night, true) };
  });

/** Peeled, oiled cabin logs: grain along V (the log's length), U around it, with drying checks and knots. */
export const logMaps = (q: Quality): MapSet =>
  memo(`log:${q}`, () =>
    paint(sizeFor(q, 256), 2.5, (u, v, out) => {
      const grain = vnoise(u * 40, v * 3, 40, 71) * 0.6 + fbm(u * 6, v * 2, 6, 3, 72) * 0.4;
      const wob = fbm(u * 2, v * 4, 2, 2, 73) * 0.06;
      const check = Math.min(...[0.18, 0.57, 0.83].map((c) => Math.abs(((u + wob - c + 1.5) % 1) - 0.5) * 2));
      const crack = check < 0.012 && hash(Math.floor(v * 6), 0, 74) > 0.35 ? 0.45 : 1;
      const knot = Math.max(0, 1 - Math.hypot((u - 0.35) * 8, ((v * 2) % 1 - 0.5) * 3)) > 0.6 ? 0.55 : 1;
      const c = mix([128, 86, 50], [188, 140, 88], grain).map((x) => x * crack * knot);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return grain * 0.3 - (crack < 1 ? 0.5 : 0);
    }),
  );
