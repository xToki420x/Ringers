import { hash } from './textures';

/**
 * Small, fast building blocks for the pit fill: a seeded random stream (so a
 * raked pit or a texture is reproducible) and whole-grid tileable value noise
 * that shares its lattice lookups across a row, several times quicker than
 * sampling noise pixel by pixel.
 */

/** Seeded uniform random numbers in [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Tileable fractal value noise over an S×S grid, in [0, 1]. The base octave
 * has `cells` lattice cells across the tile; each further octave doubles it.
 */
export function noiseGrid(S: number, cells: number, seed: number, octaves = 1, gain = 0.5): Float32Array {
  const out = new Float32Array(S * S);
  const x0 = new Int32Array(S);
  const x1 = new Int32Array(S);
  const xt = new Float32Array(S);
  const line = new Float32Array(S);
  let norm = 0;
  for (let o = 0, a = 1; o < octaves; o++, a *= gain) norm += a;
  let amp = 1 / norm;
  for (let o = 0; o < octaves; o++) {
    const L = Math.min(S, cells << o);
    const lat = new Float32Array(L * L);
    for (let j = 0; j < L; j++) for (let i = 0; i < L; i++) lat[j * L + i] = hash(i, j, seed + o * 101);
    // Column lookups are shared by every row.
    for (let x = 0; x < S; x++) {
      const f = (x * L) / S;
      const i = Math.floor(f);
      const t = f - i;
      x0[x] = i % L;
      x1[x] = (i + 1) % L;
      xt[x] = t * t * (3 - 2 * t);
    }
    for (let y = 0; y < S; y++) {
      // Interpolate the two lattice rows once, then each texel along the row.
      const f = (y * L) / S;
      const j = Math.floor(f);
      let t = f - j;
      t = t * t * (3 - 2 * t);
      const r0 = (j % L) * L;
      const r1 = ((j + 1) % L) * L;
      for (let i = 0; i < L; i++) {
        const a = lat[r0 + i];
        line[i] = (a + (lat[r1 + i] - a) * t) * amp;
      }
      const row = y * S;
      for (let x = 0; x < S; x++) {
        const a = line[x0[x]];
        out[row + x] += a + (line[x1[x]] - a) * xt[x];
      }
    }
    amp *= gain;
  }
  return out;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
