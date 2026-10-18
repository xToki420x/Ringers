import { canvasTex, hash, makeCanvas, sizeFor, vnoise, type MapSet, type Quality } from './textures';
import { noiseGrid, seededRandom, smoothstep } from './sandNoise';

/**
 * Pit fill textures, generated at load time at real-world scale.
 *
 * Pitching sand is built grain by grain: a Voronoi mosaic of mineral grains
 * (tan and milky quartz, pink feldspar, rust, grey lithics, dark mineral
 * flecks), with small pebbles, angular stone chips and the odd shell
 * fragment on top. Blue clay is smooth, plastic clay worked with a trowel
 * (curved smears with drag streaks, squeezed-out lips and grit scratches),
 * with fine hairline drying cracks on the patches nobody has touched.
 *
 * - map: albedo, without crevice shading (so damp fill can close the gaps)
 * - normalMap: from a height field in texel units, so slopes are true to scale
 * - roughnessMap: R = crevice occlusion, G = roughness (three reads G)
 */

/** Real-world width of one texture tile (m); the pit scales its UVs by this. */
export const SAND_TILE = { sand: 0.48, clay: 0.6 } as const;

/** [weight, r, g, b, roughness] */
type Mineral = readonly [number, number, number, number, number];

const GRAINS: readonly Mineral[] = [
  [0.4, 166, 131, 90, 0.93], // iron-stained quartz
  [0.18, 188, 166, 130, 0.86], // milky quartz
  [0.17, 150, 116, 78, 0.95], // buff
  [0.1, 172, 128, 96, 0.9], // pink feldspar
  [0.05, 150, 104, 68, 0.94], // rust
  [0.06, 132, 122, 108, 0.9], // grey lithic
  [0.032, 84, 74, 64, 0.8], // dark minerals
  [0.008, 224, 218, 204, 0.42], // glassy quartz and mica glints
];

const PEBBLES: readonly Mineral[] = [
  [0.28, 128, 120, 110, 0.66], // grey granite
  [0.2, 160, 132, 98, 0.74], // sandstone
  [0.15, 102, 76, 56, 0.7], // brown chert
  [0.13, 204, 196, 180, 0.5], // white quartz
  [0.1, 146, 80, 54, 0.62], // red jasper
  [0.14, 68, 66, 64, 0.6], // basalt
];

const SHELLS: readonly Mineral[] = [
  [0.6, 236, 226, 208, 0.45],
  [0.25, 214, 206, 198, 0.5],
  [0.15, 232, 206, 192, 0.45],
];

/** Mean grain size and relief (m). */
const GRAIN = 0.0014;
const GRAIN_RELIEF = 0.0003;
/** Scatter densities (per m²). */
const PEBBLE_DENSITY = 950;
const CHIP_DENSITY = 380;
const SHELL_DENSITY = 32;
const SMEAR_DENSITY = 64;
/** Drying-crack plate size in clay (m). */
const CRACK_PLATE = 0.016;

const builtFor = new WeakMap<MapSet, Quality>();

/** The quality tier a map set was generated for (the pit scales its extra detail by it). */
export function sandMapsQuality(maps: MapSet): Quality {
  return builtFor.get(maps) ?? 'medium';
}

/** Pit fill maps: pitching sand or blue clay. */
export function sandMaps(q: Quality, kind: 'sand' | 'clay'): MapSet {
  const S = sizeFor(q, 1024);
  const f = kind === 'sand' ? sandSurface(S, SAND_TILE.sand / S) : claySurface(S, SAND_TILE.clay / S);
  const maps: MapSet = {
    map: canvasTex(toCanvas(S, f.albedo), true),
    normalMap: canvasTex(normalCanvas(f.height, S), false),
    roughnessMap: canvasTex(toCanvas(S, f.surface), false),
  };
  builtFor.set(maps, q);
  return maps;
}

interface Surface {
  albedo: Uint8ClampedArray<ArrayBuffer>;
  /** Height in texel units. */
  height: Float32Array;
  /** R = crevice occlusion, G = roughness. */
  surface: Uint8ClampedArray<ArrayBuffer>;
}

function pick(list: readonly Mineral[], u: number): number {
  let i = 0;
  while (i < list.length - 1 && (u -= list[i][0]) >= 0) i++;
  return i;
}

/** Visit every texel within `ext` of (cx, cy) on the wrapping S×S grid, with its offset from the centre. */
function stamp(S: number, cx: number, cy: number, ext: number, fn: (p: number, dx: number, dy: number) => void) {
  const x0 = Math.floor(cx - ext), x1 = Math.ceil(cx + ext);
  const y0 = Math.floor(cy - ext), y1 = Math.ceil(cy + ext);
  for (let y = y0; y <= y1; y++) {
    const row = (((y % S) + S) % S) * S;
    for (let x = x0; x <= x1; x++) fn(row + (((x % S) + S) % S), x + 0.5 - cx, y + 0.5 - cy);
  }
}

interface Mosaic {
  /** Index of the nearest feature cell. */
  id: Int32Array;
  /** Distance to the nearest cell boundary, in cells. */
  edge: Float32Array;
}

interface MosaicOptions {
  /** Weights the cells (a power diagram) so they vary in size. */
  sizeJitter?: number;
  /** Wiggles the borders: displacement (cells) at full noise swing. */
  warp?: { x: Float32Array; y: Float32Array; amount: number };
  /** Texels where this is zero are skipped (left at id 0, far from any edge). */
  mask?: Float32Array;
  /**
   * Search only the 2×2 cells nearest the texel instead of all 3×3: twice as
   * fast, and the rare misses are invisible on mosaics a few texels across.
   */
  quick?: boolean;
}

/** Tileable Voronoi mosaic with G×G jittered cells. */
function voronoi(S: number, G: number, seed: number, { sizeJitter = 0, warp, mask, quick = false }: MosaicOptions): Mosaic {
  const rand = seededRandom(seed);
  const fx = new Float32Array(G * G);
  const fy = new Float32Array(G * G);
  const fw = new Float32Array(G * G);
  for (let k = 0; k < G * G; k++) {
    fx[k] = 0.1 + 0.8 * rand();
    fy[k] = 0.1 + 0.8 * rand();
    fw[k] = (rand() - 0.5) * sizeJitter;
  }
  const wrap = new Int32Array(G + 2);
  for (let i = 0; i < G + 2; i++) wrap[i] = (i - 1 + G) % G;
  const id = new Int32Array(S * S);
  const edge = new Float32Array(S * S).fill(G);
  const sc = G / S;
  const span = quick ? 2 : 3;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      if (mask && mask[p] <= 0) continue;
      let gx = (x + 0.5) * sc;
      let gy = (y + 0.5) * sc;
      if (warp) {
        gx += (warp.x[p] - 0.5) * warp.amount;
        gy += (warp.y[p] - 0.5) * warp.amount;
        gx = gx < 0 ? gx + G : gx >= G ? gx - G : gx;
        gy = gy < 0 ? gy + G : gy >= G ? gy - G : gy;
      }
      const ci = Math.floor(gx), cj = Math.floor(gy);
      const si = quick && gx - ci >= 0.5 ? ci : ci - 1;
      const sj = quick && gy - cj >= 0.5 ? cj : cj - 1;
      let d1 = 1e9, d2 = 1e9, k1 = 0, ax = 0, ay = 0, bx = 0, by = 0;
      for (let cy = sj; cy < sj + span; cy++) {
        const row = wrap[cy + 1] * G;
        const oy = cy - gy;
        for (let cx = si; cx < si + span; cx++) {
          const k = row + wrap[cx + 1];
          const dx = cx + fx[k] - gx;
          const dy = oy + fy[k];
          const d = dx * dx + dy * dy - fw[k];
          if (d < d1) {
            d2 = d1;
            bx = ax;
            by = ay;
            d1 = d;
            k1 = k;
            ax = dx;
            ay = dy;
          } else if (d < d2) {
            d2 = d;
            bx = dx;
            by = dy;
          }
        }
      }
      // Distance to the (power) bisector of the two nearest features, which
      // sit in different cells and so are never closer than 0.2 cells.
      id[p] = k1;
      edge[p] = (d2 - d1) / (2 * Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)));
    }
  return { id, edge };
}

/** Coverage of a line `w` texels wide at distance `e` from its centre (box-filtered). */
function line(w: number, e: number): number {
  return Math.max(0, Math.min(w / 2 + 0.5 - e, Math.min(1, w)));
}

function sandSurface(S: number, texel: number): Surface {
  const n = S * S;
  const albedo = new Uint8ClampedArray(n * 4);
  const surface = new Uint8ClampedArray(n * 4);
  const height = new Float32Array(n);
  const tone = noiseGrid(S, 4, 11, 3);
  const area = (S * texel) ** 2;
  const relief = GRAIN_RELIEF / texel;

  // Mineral grains: one per Voronoi cell, domed, with crevices between them
  // that are deeper in some places than others (fines fill the rest).
  const G = Math.min(Math.round(S / 1.25), Math.round((S * texel) / GRAIN));
  const grains = voronoi(S, G, 3, { sizeJitter: 0.45, quick: true });
  const cellPx = S / G;
  const rim = Math.max(0.6, cellPx * 0.3);
  const mineral = new Uint8Array(G * G);
  const shade = new Float32Array(G * G);
  const lift = new Float32Array(G * G);
  const rand = seededRandom(5);
  for (let k = 0; k < G * G; k++) {
    mineral[k] = pick(GRAINS, rand());
    shade[k] = 0.9 + 0.2 * rand();
    lift[k] = 0.5 + 0.5 * rand();
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      const id = grains.id[p];
      const inner = Math.min(1, (grains.edge[p] * cellPx) / rim);
      const dome = inner * (2 - inner);
      const m = GRAINS[mineral[id]];
      const t = shade[id] * (0.93 + 0.14 * tone[p]) * (0.92 + 0.08 * dome) * (0.97 + 0.06 * hash(x, y, 5));
      const gap = 0.4 + 0.25 * tone[p];
      const i = p * 4;
      albedo[i] = m[1] * t;
      albedo[i + 1] = m[2] * t;
      albedo[i + 2] = m[3] * t;
      albedo[i + 3] = 255;
      height[p] = lift[id] * dome * relief;
      surface[i] = 255 * (gap + (1 - gap) * dome);
      surface[i + 1] = 255 * (m[4] + (1 - m[4]) * (1 - dome));
      surface[i + 2] = surface[i + 3] = 255;
    }

  const put = (p: number, col: Mineral, k: number, cov: number, rough: number, crev: number) => {
    const i = p * 4;
    albedo[i] += (col[1] * k - albedo[i]) * cov;
    albedo[i + 1] += (col[2] * k - albedo[i + 1]) * cov;
    albedo[i + 2] += (col[3] * k - albedo[i + 2]) * cov;
    surface[i] += (255 * crev - surface[i]) * cov;
    surface[i + 1] += (255 * rough - surface[i + 1]) * cov;
  };
  const shadow = (p: number, k: number) => {
    surface[p * 4] *= k;
  };

  // Every tier draws the same scatter (random numbers are always drawn), but
  // pieces too small to resolve at this resolution are left to the grains.
  const rs = seededRandom(21);

  // Rounded pebbles (2–6 mm), resting on the grains with a contact shadow.
  const pebbles = Math.round(PEBBLE_DENSITY * area);
  for (let s = 0; s < pebbles; s++) {
    const r = (0.001 + 0.0022 * rs() ** 1.8) / texel;
    const cx = rs() * S, cy = rs() * S, ang = rs() * Math.PI;
    const el = 0.62 + 0.38 * rs();
    const lobes = [rs() * 0.12, rs() * 0.08, rs() * 0.05, rs() * 6.3, rs() * 6.3, rs() * 6.3];
    const m = PEBBLES[pick(PEBBLES, rs())];
    const speckled = rs() < 0.4;
    const top = r * (0.4 + 0.25 * rs());
    const tint = 0.9 + 0.2 * rs();
    if (r < 0.6) continue;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    stamp(S, cx, cy, r * 1.45 + 1, (p, dx, dy) => {
      const u = dx * ca + dy * sa;
      const v = (-dx * sa + dy * ca) / el;
      const th = Math.atan2(v, u);
      const rr = r * (1 + lobes[0] * Math.sin(2 * th + lobes[3]) + lobes[1] * Math.sin(3 * th + lobes[4]) + lobes[2] * Math.sin(5 * th + lobes[5]));
      const d = Math.sqrt(u * u + v * v) / rr;
      if (d >= 1.4) return;
      if (d >= 1) {
        shadow(p, 0.65 + 0.35 * ((d - 1) / 0.4));
        return;
      }
      const dome = Math.sqrt(1 - d * d);
      const mott = 0.88 + 0.24 * vnoise(u * 0.9 + s, v * 0.9, 4096, s);
      const fleck = speckled ? hash(p, s, 9) : 0.5;
      const k = tint * mott * (0.84 + 0.16 * dome) * (fleck > 0.93 ? 0.5 : fleck < 0.05 ? 1.2 : 1);
      put(p, m, k, Math.min(1, (1 - d) * rr + 0.25), m[4], 0.75 + 0.25 * dome);
      height[p] = Math.max(height[p], top * dome ** 0.7 + relief * 0.5);
    });
  }

  // Angular stone chips: small flat-topped polygons with faceted shading.
  const chips = Math.round(CHIP_DENSITY * area);
  for (let s = 0; s < chips; s++) {
    const r = (0.0009 + 0.0016 * rs()) / texel;
    const cx = rs() * S, cy = rs() * S;
    const sides = 4 + Math.floor(rs() * 3);
    const a0 = rs() * 6.3;
    const pts: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = a0 + ((k + 0.2 + 0.6 * rs()) / sides) * Math.PI * 2;
      const rr = r * (0.6 + 0.4 * rs());
      pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    const m = PEBBLES[pick(PEBBLES, rs())];
    const top = r * (0.25 + 0.2 * rs());
    const tint = 0.85 + 0.25 * rs();
    if (r < 0.6) continue;
    stamp(S, cx, cy, r + 1.5, (p, dx, dy) => {
      // Signed distance inside the convex polygon (positive inside); the
      // vertices are distinct, so no edge has zero length.
      let sd = Infinity;
      for (let k = 0; k < sides; k++) {
        const x0 = pts[k * 2], y0 = pts[k * 2 + 1];
        const x1 = pts[((k + 1) % sides) * 2], y1 = pts[((k + 1) % sides) * 2 + 1];
        const ex = x1 - x0, ey = y1 - y0;
        sd = Math.min(sd, ((dy - y0) * ex - (dx - x0) * ey) / Math.sqrt(ex * ex + ey * ey));
      }
      if (sd < -1.2) return;
      if (sd < 0) {
        shadow(p, 0.75 + 0.25 * (-sd / 1.2));
        return;
      }
      const facet = 0.9 + 0.2 * hash(Math.floor(dx * 0.7 + 9), Math.floor(dy * 0.7 + 9), s);
      put(p, m, tint * facet, Math.min(1, sd + 0.5), m[4] + 0.1, 1);
      height[p] = Math.max(height[p], Math.min(top, sd * 0.9) + relief * 0.4);
    });
  }

  // Shell fragments: thin ribbed arcs.
  const shells = Math.max(1, Math.round(SHELL_DENSITY * area));
  for (let s = 0; s < shells; s++) {
    const R = (0.0025 + 0.0035 * rs()) / texel;
    const th = (0.0006 + 0.0007 * rs()) / texel;
    const cx = rs() * S, cy = rs() * S;
    const a0 = rs() * 6.3, span = 0.9 + 1.2 * rs();
    const m = SHELLS[pick(SHELLS, rs())];
    const ribs = 3 + Math.floor(rs() * 4);
    if (th < 0.5) continue;
    stamp(S, cx, cy, R + th + 1.5, (p, dx, dy) => {
      const a = Math.atan2(dy, dx) - a0;
      const f = (((a % 6.2832) + 6.2832) % 6.2832) / span;
      if (f > 1) return;
      const w = th * Math.sqrt(Math.sin(Math.PI * f));
      const e = Math.abs(Math.sqrt(dx * dx + dy * dy) - R);
      const cov = line(w, e);
      if (cov <= 0) {
        if (e < w * 0.5 + 1.5) shadow(p, 0.8);
        return;
      }
      const rib = 0.5 + 0.5 * Math.cos(f * ribs * Math.PI * 2);
      put(p, m, 0.9 + 0.1 * rib, cov, m[4], 1);
      height[p] = Math.max(height[p], w * 0.45 + relief * 0.4 + rib * 0.3);
    });
  }
  return { albedo, height, surface };
}

function claySurface(S: number, texel: number): Surface {
  const n = S * S;
  const albedo = new Uint8ClampedArray(n * 4);
  const surface = new Uint8ClampedArray(n * 4);
  const height = new Float32Array(n);
  const area = (S * texel) ** 2;
  const lumps = noiseGrid(S, 5, 301, 3);
  const hue = noiseGrid(S, 3, 306, 1);
  const dryness = noiseGrid(S, 4, 305, 2);
  const grit = noiseGrid(S, Math.min(S >> 1, Math.round((S * texel) / 0.003)), 302, 1);
  const worked = new Float32Array(n);
  const sheen = new Float32Array(n);
  for (let p = 0; p < n; p++) height[p] = ((lumps[p] - 0.5) * 0.004 + (grit[p] - 0.5) * 0.00025) / texel;

  // Trowel smears: curved, blade-shaped strokes pressed flat, with drag
  // streaks running along them, clay squeezed up along one side and at the
  // end where the blade stopped, and grit scratches on some.
  const rs = seededRandom(41);
  const lattice = new Float32Array(512);
  for (let i = 0; i < 512; i++) lattice[i] = rs();
  const streakPitch = 0.0011 / texel;
  const scratchPitch = 0.0018 / texel;
  const lip = 0.0005 / texel;
  const bump = (x: number) => (x > -1 && x < 1 ? (1 - x * x) ** 2 : 0);
  const smears = Math.round(SMEAR_DENSITY * area);
  for (let s = 0; s < smears; s++) {
    const cx = rs() * S, cy = rs() * S, ang = rs() * Math.PI * 2;
    const bend = (rs() - 0.5) * 14 * texel;
    const len = (0.06 + 0.12 * rs()) / texel, wid = (0.03 + 0.045 * rs()) / texel;
    const level = ((rs() - 0.5) * 0.0015) / texel;
    const tilt = (rs() - 0.5) * 0.012;
    // Half-width along the stroke (64 steps), wobbling as the hand pressed harder or softer.
    const p0 = rs() * 6.3, p1 = rs() * 6.3, amt = 0.1 + 0.15 * rs();
    const halfWidth = new Float32Array(65);
    for (let k = 0; k <= 64; k++) halfWidth[k] = wid * 0.5 * (1 + amt * Math.sin(k * 0.14 + p0) * Math.sin(k * 0.073 + p1));
    const offset = Math.floor(rs() * 512);
    const scratches = rs() < 0.45;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    stamp(S, cx, cy, Math.hypot(len, wid) / 2 + 3, (p, dx, dy) => {
      const a = dx * ca + dy * sa;
      const fa = Math.abs(a) / (len * 0.5);
      if (fa >= 1) return;
      const c = -dx * sa + dy * ca - 0.5 * bend * a * a;
      const half = halfWidth[Math.round((a / len + 0.5) * 64)];
      const fc = Math.abs(c) / half;
      if (fc >= 1.2) return;
      // Crisp where the blade stopped (a > 0), feathered where it set down.
      const r = Math.sqrt(fa * fa * fa * fa + fc * fc);
      const m = 1 - smoothstep(a > 0 ? 0.84 : 0.45, 1, r);
      const q = c / streakPitch + offset;
      const qi = Math.floor(q);
      const qt = q - qi;
      const l0 = lattice[qi & 511];
      const streak = l0 + (lattice[(qi + 1) & 511] - l0) * qt * qt * (3 - 2 * qt) - 0.5;
      let h = level + a * tilt + (streak * 0.00014) / texel;
      if (scratches) {
        const g = c / scratchPitch;
        const gi = Math.floor(g);
        if (hash(gi, s, 77) < 0.2) h -= (Math.max(0, 1 - Math.abs(g - gi - 0.5) * 3.2) * 0.00015) / texel;
      }
      const ridge = bump((c - half * 0.92) / (half * 0.14)) * (1 - fa * fa) + (a > 0 ? bump((r - 0.93) / 0.07) : 0);
      height[p] += (h - height[p]) * m + ridge * lip;
      worked[p] = Math.max(worked[p], m);
      sheen[p] += (0.5 + streak - sheen[p]) * m;
    });
  }

  // Hairline drying cracks on the untouched patches: plates of ~1.6 cm, some
  // split again by finer cracks, their edges curling up a touch.
  const dry = new Float32Array(n);
  for (let p = 0; p < n; p++) dry[p] = smoothstep(0.54, 0.7, dryness[p]) * (1 - worked[p]);
  const G1 = Math.max(4, Math.round((S * texel) / CRACK_PLATE));
  const wx = noiseGrid(S, Math.min(S >> 2, G1), 303, 2);
  const wy = noiseGrid(S, Math.min(S >> 2, G1), 304, 2);
  const plates = voronoi(S, G1, 307, { warp: { x: wx, y: wy, amount: 0.5 }, mask: dry });
  const plateWidth = new Float32Array(G1 * G1);
  const plateSplit = new Uint8Array(G1 * G1);
  for (let k = 0; k < G1 * G1; k++) {
    plateWidth[k] = (0.0002 + 0.00025 * rs()) / texel;
    plateSplit[k] = rs() < 0.4 ? 1 : 0;
  }
  const splitting = new Float32Array(n);
  for (let p = 0; p < n; p++) splitting[p] = dry[p] > 0 && plateSplit[plates.id[p]] ? 1 : 0;
  const G2 = Math.round(G1 * 2.5);
  const splits = voronoi(S, G2, 308, { sizeJitter: 0.2, warp: { x: wx, y: wy, amount: 1 }, mask: splitting });
  const px1 = S / G1, px2 = S / G2;
  const splitWidth = 0.00014 / texel;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const p = y * S + x;
      let crack = 0;
      if (dry[p] > 0) {
        const e1 = plates.edge[p] * px1;
        const k = plates.id[p];
        const split = splitting[p] ? line(splitWidth, splits.edge[p] * px2) * 0.8 : 0;
        crack = Math.max(line(plateWidth[k], e1), split) * dry[p];
        height[p] += ((1 - smoothstep(0, px1 * 0.25, e1)) * dry[p] * 0.00008 - crack * 0.0005) / texel;
      }
      const d = dry[p];
      const w = worked[p];
      const t = (0.94 + 0.12 * lumps[p]) * (0.97 + 0.06 * grit[p]) * (1 - 0.03 * w);
      const i = p * 4;
      // Moist blue-grey (drifting greener in places), drying paler and greyer.
      const r0 = 60 + 6 * hue[p], g0 = 68 + 5 * hue[p], b0 = 76 - 2 * hue[p];
      albedo[i] = (r0 + (98 - r0) * d * 0.45) * t;
      albedo[i + 1] = (g0 + (102 - g0) * d * 0.45) * t;
      albedo[i + 2] = (b0 + (104 - b0) * d * 0.45) * t;
      albedo[i + 3] = 255;
      surface[i] = 255 * (1 - crack * 0.8);
      surface[i + 1] = 255 * Math.min(1, 0.78 + 0.16 * d - w * (0.1 + 0.1 * sheen[p]) + crack * 0.3);
      surface[i + 2] = surface[i + 3] = 255;
    }
  // Grit: the odd pale sand grain or dark speck worked into the clay.
  for (let k = Math.round(n * 0.004); k > 0; k--) {
    const i = Math.floor(rs() * n) * 4;
    const f = rs() < 0.6 ? 1.4 : 0.6;
    for (let c = 0; c < 3; c++) albedo[i + c] *= f;
  }
  return { albedo, height, surface };
}

function toCanvas(S: number, rgba: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement {
  const c = makeCanvas(S);
  c.getContext('2d')!.putImageData(new ImageData(rgba, S, S), 0, 0);
  return c;
}

/** Tangent-space normal map (+Y along texture V, which runs up the canvas) from heights in texel units. */
function normalCanvas(h: Float32Array, S: number): HTMLCanvasElement {
  const d = new Uint8ClampedArray(S * S * 4);
  for (let y = 0; y < S; y++) {
    const up = ((y + S - 1) % S) * S;
    const dn = ((y + 1) % S) * S;
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const nx = (h[row + (x === 0 ? S - 1 : x - 1)] - h[row + (x === S - 1 ? 0 : x + 1)]) * 0.5;
      const ny = (h[dn + x] - h[up + x]) * 0.5;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (row + x) * 4;
      d[i] = (nx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  return toCanvas(S, d);
}
