import * as THREE from 'three';

/**
 * Procedural, tileable textures generated at load time so the game ships
 * without bitmap assets. Heights are generated as float fields, then turned
 * into colour, normal and roughness maps.
 */

export type Quality = 'low' | 'medium' | 'high';

export function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic value noise (tiles every `period` cells). */
export function vnoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let amp = 1, sum = 0, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + o * 17);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export interface MapSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
}

export function canvasTex(c: HTMLCanvasElement | OffscreenCanvas, srgb: boolean, repeat = 1): THREE.Texture {
  const t = new THREE.CanvasTexture(c as HTMLCanvasElement);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

export function makeCanvas(w: number, h = w): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Normal map from a tileable height field. */
export function normalFromHeight(h: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - d) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / len * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  return c;
}

export const sizeFor = (q: Quality, high: number) => (q === 'high' ? high : q === 'medium' ? high / 2 : high / 4);

export function mix(a: number[], b: number[], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Weathered timber planks (grain runs along U). */
export function woodMaps(q: Quality, tint: [number, number, number] = [138, 104, 72]): MapSet {
  const S = sizeFor(q, 512);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const h = new Float32Array(S * S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const warp = fbm(u * 2, v * 8, 2, 3, 31) * 3;
      const ring = Math.sin((v * 40 + warp) * Math.PI) * 0.5 + 0.5;
      const streak = vnoise(u * 8, v * 220, 8, 32);
      const plank = (Math.floor(v * 4) % 2) * 0.06;
      const gap = Math.abs((v * 4) % 1) < 0.012 ? 0.45 : 1;
      const weather = fbm(u * 6, v * 6, 6, 4, 33);
      const t = 0.45 + ring * 0.15 + (streak - 0.5) * 0.25 + (weather - 0.5) * 0.3 + plank;
      let col = mix([tint[0] * 0.7, tint[1] * 0.7, tint[2] * 0.7], tint, t);
      col = mix(col, [150, 146, 138], Math.max(0, weather - 0.6) * 0.9); // silvered weathering
      const i = (y * S + x) * 4;
      img.data[i] = col[0] * gap;
      img.data[i + 1] = col[1] * gap;
      img.data[i + 2] = col[2] * gap;
      img.data[i + 3] = 255;
      h[y * S + x] = streak * 0.25 + ring * 0.15 - (gap < 1 ? 1 : 0);
    }
  ctx.putImageData(img, 0, 0);
  return { map: canvasTex(c, true), normalMap: canvasTex(normalFromHeight(h, S, 2.5), false) };
}

/** Broom-finished concrete for the extended platforms and walkways. */
export function concreteMaps(q: Quality): MapSet {
  const S = sizeFor(q, 512);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const h = new Float32Array(S * S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const n = fbm(u * 8, v * 8, 8, 5, 41);
      const broom = vnoise(u * 300, v * 4, 300, 42);
      const col = mix([128, 126, 120], [182, 180, 172], n * 0.8 + broom * 0.2);
      const i = (y * S + x) * 4;
      img.data[i] = col[0];
      img.data[i + 1] = col[1];
      img.data[i + 2] = col[2];
      img.data[i + 3] = 255;
      h[y * S + x] = n * 0.4 + broom * 0.6;
    }
  ctx.putImageData(img, 0, 0);
  return { map: canvasTex(c, true), normalMap: canvasTex(normalFromHeight(h, S, 2), false) };
}

/** Hammered / forged steel micro-surface used as a bump map on the shoes. */
let forgedCache: THREE.Texture | null = null;
export function forgedBump(): THREE.Texture {
  if (forgedCache) return forgedCache;
  const S = 256;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // Hammer dimples: cellular-ish via abs(sin) of warped noise.
      const n = fbm(u * 8, v * 8, 8, 4, 51);
      const dimple = Math.abs(Math.sin(n * 18));
      const g = 120 + dimple * 70 + vnoise(u * 64, v * 64, 64, 52) * 50;
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = g;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  forgedCache = canvasTex(c, false);
  return forgedCache;
}

/** Soft round sprite for dust and grains. */
export function softDot(): THREE.Texture {
  const c = makeCanvas(64);
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Text banner texture. */
export function bannerTexture(lines: string[], bg: string, fg: string, w = 1024, h = 256, accent?: string): THREE.Texture {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  if (accent) {
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, w, h * 0.06);
    ctx.fillRect(0, h * 0.94, w, h * 0.06);
  }
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const n = lines.length;
  lines.forEach((line, i) => {
    const size = i === 0 ? h * (n > 1 ? 0.4 : 0.55) : h * 0.2;
    ctx.font = `700 ${size}px Oswald, Impact, sans-serif`;
    ctx.fillText(line, w / 2, n > 1 ? h * (i === 0 ? 0.42 : 0.78) : h / 2);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
