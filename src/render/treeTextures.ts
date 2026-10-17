import * as THREE from 'three';
import { hash, type Quality } from './textures';
import type { TreeSpecies } from './trees';
import { LEAF_ATLAS, SPECIES_COLUMN } from './treeMesh';

/**
 * Procedural tree textures. Bark is computed per pixel from periodic noise
 * (it wraps around a limb and repeats along it) with a matching normal map;
 * the foliage atlas paints real leaf and needle sprays with a 2D canvas, one
 * column per species and one row per spray layout.
 */

export interface BarkMaps {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** Normal map strength for the material. */
  relief: number;
}

/**
 * Periodic fractal value noise (0..1) over a W×H texture, starting with
 * `fx` × `fy` lattice cells and doubling per octave. Computed a whole grid at
 * a time (lattice lookups and weights per row and column), which is far
 * cheaper than evaluating noise texel by texel.
 */
function field(W: number, H: number, fx: number, fy: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(W * H);
  const lattice = new Float32Array((fx << (octaves - 1)) * (fy << (octaves - 1)));
  const axis = (n: number, cells: number) => {
    const i0 = new Int32Array(n), i1 = new Int32Array(n), s = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const p = (k / n) * cells, i = Math.floor(p), f = p - i;
      i0[k] = i % cells;
      i1[k] = (i + 1) % cells;
      s[k] = f * f * (3 - 2 * f);
    }
    return { i0, i1, s };
  };
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = fx << o, cy = fy << o;
    for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) lattice[y * cx + x] = hash(x, y, seed + o * 17);
    const X = axis(W, cx), Y = axis(H, cy);
    for (let y = 0; y < H; y++) {
      const r0 = Y.i0[y] * cx, r1 = Y.i1[y] * cx, sy = Y.s[y];
      for (let x = 0; x < W; x++) {
        const x0 = X.i0[x], x1 = X.i1[x], sx = X.s[x];
        const a = lattice[r0 + x0], b = lattice[r0 + x1], c = lattice[r1 + x0], d = lattice[r1 + x1];
        out[y * W + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    norm += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Periodic Voronoi over a W×H texture: per texel, the gap between the two nearest jittered centres and the nearest cell's id. */
function voronoi(W: number, H: number, nx: number, ny: number, seed: number, warp?: Float32Array) {
  const jx = new Float32Array(nx * ny), jy = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) {
    jx[i] = 0.12 + 0.76 * hash(i % nx, Math.floor(i / nx), seed);
    jy[i] = 0.12 + 0.76 * hash(i % nx, Math.floor(i / nx), seed + 1);
  }
  // Wrapped neighbour cell indices, so the inner loop needs no modulo.
  const wrap = (n: number) => Int32Array.from({ length: n + 4 }, (_, k) => (k - 2 + n) % n);
  const wx = wrap(nx), wy = wrap(ny);
  const gap = new Float32Array(W * H), id = new Int32Array(W * H);
  for (let py = 0, t = 0; py < H; py++)
    for (let px = 0; px < W; px++, t++) {
      const w = warp ? warp[t] - 0.5 : 0;
      const x = (px / W + w * 0.08) * nx, y = (py / H + w * 0.05) * ny;
      const xi = Math.floor(x), yi = Math.floor(y);
      let d1 = 99, d2 = 99, best = 0;
      for (let j = -1; j <= 1; j++) {
        const row = wy[yi + j + 2] * nx;
        for (let i = -1; i <= 1; i++) {
          const k = row + wx[xi + i + 2];
          const dx = xi + i + jx[k] - x, dy = yi + j + jy[k] - y;
          const d = dx * dx + dy * dy;
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = k;
          } else if (d < d2) d2 = d;
        }
      }
      gap[t] = Math.sqrt(d2) - Math.sqrt(d1);
      id[t] = best;
    }
  return { gap, id };
}

/** `f` sampled `dx` texels across (wrapping), for warping ridges sideways. */
const across = (f: Float32Array, W: number, i: number, x: number, dx: number) => f[i - x + ((((x + Math.round(dx)) % W) + W) % W)];

/**
 * Bark split into plates: wandering vertical fissures `cols` to a tile, the strips between them
 * broken crosswise `rows` times at a different height in each strip. Per texel: distance in
 * texels to the nearest fissure (`dx`) and cross break (`dy`), and the plate's random value (`own`).
 */
function strips(W: number, H: number, cols: number, rows: number, wander: number, seed: number) {
  const warp = field(W, H, 3, 4, 2, seed), wobble = field(W, H, 12, 16, 1, seed + 1);
  const cw = W / cols, ch = H / rows;
  const dx = new Float32Array(W * H), dy = new Float32Array(W * H), own = new Float32Array(W * H);
  for (let y = 0, i = 0; y < H; y++)
    for (let x = 0; x < W; x++, i++) {
      const u = (x / W) * cols + (warp[i] - 0.5) * wander + (wobble[i] - 0.5) * 0.35;
      const ci = Math.floor(u), f = u - ci, col = ((ci % cols) + cols) % cols;
      // Cross breaks slant a little and sit at a different height in every strip.
      const v = (y / H) * rows + hash(col, 0, seed + 2) * rows + (f - 0.5) * (hash(col, 1, seed + 2) - 0.5) * 0.9 + (wobble[i] - 0.5) * 0.12;
      const ri = Math.floor(v), g = v - ri, row = ((ri % rows) + rows) % rows;
      dx[i] = Math.min(f, 1 - f) * cw;
      dy[i] = Math.min(g, 1 - g) * ch;
      own[i] = hash(col, row, seed + 3);
    }
  return { dx, dy, own };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type RGB = [number, number, number];

/** Scratch colour mixing (no allocation per texel). */
class Paint {
  r = 0;
  g = 0;
  b = 0;
  set(c: RGB) {
    [this.r, this.g, this.b] = c;
    return this;
  }
  mix(c: RGB, t: number) {
    const k = Math.min(1, Math.max(0, t));
    this.r += (c[0] - this.r) * k;
    this.g += (c[1] - this.g) * k;
    this.b += (c[2] - this.b) * k;
    return this;
  }
  lerp(a: RGB, b: RGB, t: number) {
    return this.set(a).mix(b, t);
  }
}

/** Fills relief height (0 deep … 1 proud) and colour for every texel; U runs around the limb, V along it. */
type BarkPainter = (W: number, H: number, height: Float32Array, paint: (i: number, p: Paint) => void) => void;

const BARK: Record<TreeSpecies, { paint: BarkPainter; relief: number }> = {
  // Thick, deeply furrowed oak bark: tall interlaced ridges between dark furrows, the ridges rough
  // and grainy, with grey weathering and the odd patch of lichen.
  oak: {
    relief: 1.6,
    paint(W, H, height, out) {
      const warp = field(W, H, 4, 2, 2, 11), mottle = field(W, H, 4, 6, 3, 15), grain = field(W, H, 40, 6, 2, 14);
      const { gap } = voronoi(W, H, 14, 3, 12, warp);
      const rough = field(W, H, 32, 64, 1, 16);
      const furrow: RGB = [33, 26, 20], ridgeTop: RGB = [126, 110, 92], weathered: RGB = [88, 76, 62], lichen: RGB = [132, 138, 108];
      const p = new Paint();
      for (let i = 0; i < W * H; i++) {
        // Furrows wander in width and fall away steeply; ridge tops are rounded and rough.
        const n = grain[i] * 0.1;
        const ridge = smooth(0.05 + n, 0.2 + n, gap[i]);
        const g = grain[i], m = mottle[i], r = rough[i];
        const h = ridge * (0.62 + 0.22 * g + 0.16 * r);
        height[i] = h;
        p.lerp(furrow, ridgeTop, h * (0.85 + 0.3 * r)).mix(weathered, (1 - m) * 0.5);
        out(i, p.mix(lichen, smooth(0.66, 0.8, m) * ridge * 0.4));
      }
    },
  },
  // Maple: smoother grey-brown bark, long shallow fissures between flat strips, soft mottling.
  maple: {
    relief: 0.9,
    paint(W, H, height, out) {
      const warp = field(W, H, 3, 1, 2, 21), bands = field(W, H, 11, 2, 2, 22), mottle = field(W, H, 5, 8, 3, 23), fine = field(W, H, 32, 32, 1, 24);
      const dark: RGB = [88, 80, 70], light: RGB = [140, 131, 118], fissured: RGB = [50, 43, 36];
      const p = new Paint();
      for (let y = 0, i = 0; y < H; y++)
        for (let x = 0; x < W; x++, i++) {
          const f = across(bands, W, i, x, (warp[i] - 0.5) * W * 0.15);
          const fissure = 1 - smooth(0.02, 0.13, Math.abs(f * 2 - 1));
          const m = mottle[i];
          height[i] = 0.75 + m * 0.15 + fine[i] * 0.1 - fissure * 0.5;
          out(i, p.lerp(dark, light, m * 1.2 - 0.1).mix(fissured, fissure * 0.8));
        }
    },
  },
  // Paper birch: chalky white with horizontal lenticels, black lens-shaped scars and the odd peeling curl.
  birch: {
    relief: 0.55,
    paint(W, H, height, out) {
      const mottle = field(W, H, 4, 6, 3, 31), lens = field(W, H, 5, 56, 1, 32), breaks = field(W, H, 16, 56, 1, 33);
      const scars = field(W, H, 2, 10, 3, 34), peeling = field(W, H, 6, 10, 3, 35);
      const chalk: RGB = [204, 200, 190], white: RGB = [236, 233, 225], peeled: RGB = [214, 172, 138], pore: RGB = [70, 64, 58], scarred: RGB = [28, 26, 25];
      const p = new Paint();
      for (let i = 0; i < W * H; i++) {
        const m = mottle[i];
        const lenticel = smooth(0.72, 0.84, lens[i]) * smooth(0.3, 0.6, breaks[i]);
        const scar = smooth(0.64, 0.72, scars[i]);
        const peel = smooth(0.68, 0.78, peeling[i]) * (1 - scar);
        height[i] = 0.7 + m * 0.2 - lenticel * 0.35 - scar * 0.25 + peel * 0.2;
        out(i, p.lerp(chalk, white, m).mix(peeled, peel * 0.6).mix(pore, lenticel).mix(scarred, scar * 0.92));
      }
    },
  },
  // Scots pine: deep wandering vertical fissures, the strips between them broken crosswise into
  // layered, flaking plates, grey-brown low down with rust where the outer layers have peeled.
  pine: {
    relief: 1.3,
    paint(W, H, height, out) {
      const k = W / 256;
      const { dx, dy, own } = strips(W, H, 8, 6, 2.4, 42);
      const tone = field(W, H, 8, 12, 3, 44), width = field(W, H, 4, 9, 2, 46);
      const strata = field(W, H, 6, 90, 1, 47), flakes = field(W, H, 10, 20, 2, 48);
      const greyBrown: RGB = [100, 80, 66], rust: RGB = [134, 78, 52], orange: RGB = [168, 100, 62], ash: RGB = [128, 118, 108];
      const fissured: RGB = [26, 18, 14];
      const p = new Paint();
      for (let i = 0; i < W * H; i++) {
        const o = own[i], t = tone[i];
        // Fissure width wanders along each crack; some plates run on unbroken into the next.
        const wv = (2 + 8 * width[i] * width[i]) * k, wh = (0.8 + 2.6 * o) * k;
        const crossing = o < 0.6 ? 1 - smooth(wh * 0.3, wh, dy[i]) : 0;
        const fissure = Math.max(1 - smooth(wv * 0.3, wv, dx[i]), crossing);
        // Plates round off into the cracks and are layered: thin strata, and fresh flakes where a layer peeled.
        const rim = smooth(0, 5 * k, Math.min(dx[i], dy[i]));
        const layer = smooth(0.45, 0.6, strata[i]) * 0.5;
        const peel = smooth(0.7, 0.78, flakes[i] * 0.7 + o * 0.3) * (1 - fissure);
        height[i] = (1 - fissure) * (0.55 + 0.25 * rim + 0.1 * o - layer * 0.1 + peel * 0.06) + 0.04 * t;
        p.lerp(greyBrown, rust, o * 0.7 + t * 0.5 - 0.25).mix(ash, smooth(0.55, 0.85, t) * 0.4 * (1 - o));
        p.mix(fissured, layer * 0.2 + (1 - rim) * 0.3).mix(orange, peel * 0.6);
        out(i, p.mix(fissured, Math.pow(fissure, 0.7)));
      }
    },
  },
};

function dataTexture(data: Uint8Array, w: number, h: number, srgb: boolean, repeat: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Bark colour and normal maps. U wraps once around a limb; V runs along it (one tile per two circumferences). */
export function barkMaps(species: TreeSpecies, q: Quality): BarkMaps {
  const W = q === 'high' ? 256 : 128, H = W * 2;
  const height = new Float32Array(W * H);
  const albedo = new Uint8Array(W * H * 4);
  BARK[species].paint(W, H, height, (i, p) => {
    albedo[i * 4] = p.r;
    albedo[i * 4 + 1] = p.g;
    albedo[i * 4 + 2] = p.b;
    albedo[i * 4 + 3] = 255;
  });
  // Slopes per texel, scaled so both resolutions give the same relief.
  const k = W / 48;
  const normal = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const l = height[y * W + ((x - 1 + W) % W)], r = height[y * W + ((x + 1) % W)];
      const u = height[((y - 1 + H) % H) * W + x], d = height[((y + 1) % H) * W + x];
      const nx = (l - r) * k, ny = (u - d) * k;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      const i = (y * W + x) * 4;
      normal[i] = (nx / len) * 127.5 + 127.5;
      normal[i + 1] = (ny / len) * 127.5 + 127.5;
      normal[i + 2] = (1 / len) * 127.5 + 127.5;
      normal[i + 3] = 255;
    }
  return { map: dataTexture(albedo, W, H, true, true), normalMap: dataTexture(normal, W, H, false, true), relief: BARK[species].relief };
}

/** Seeded random for painting, so every build paints the same sprays. */
function painter(seed: number) {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { rnd, range: (a: number, b: number) => a + (b - a) * rnd() };
}

type Ctx = CanvasRenderingContext2D;
type Pt = [number, number];

/** Leaf outlines in a local frame: petiole at the origin, tip at (0, −len), width ±. */
function oakLeaf(len: number, wid: number, lobes: number, skew: number): Pt[] {
  const side = (s: number, phase: number) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.8) * (0.5 + 0.5 * t);
      const lobe = t < 0.1 ? 1 : 0.58 + 0.42 * Math.pow(Math.abs(Math.sin(Math.PI * (t * lobes + phase))), 0.55);
      pts.push([s * wid * env * lobe, -len * t]);
    }
    return pts;
  };
  return [...side(1, 0.1), ...side(-1, 0.1 + skew).reverse()];
}

function mapleLeaf(r: number): Pt[] {
  // Five pointed lobes fanning from the petiole, with toothed margins and a notch at the base.
  const lobes: [number, number][] = [[0, 1], [0.9, 0.88], [-0.9, 0.88], [1.8, 0.55], [-1.8, 0.55]];
  const pts: Pt[] = [];
  for (let i = 0; i <= 160; i++) {
    const a = -2.75 + (5.5 * i) / 160;
    let m = 0.4;
    for (const [c, l] of lobes) m = Math.max(m, l * Math.pow(Math.max(0, 1 - Math.abs(a - c) / 0.62), 0.6));
    const tooth = 1 + 0.07 * Math.abs(((a * 9) % 1 + 1) % 1 - 0.5) * 2;
    const rr = r * m * tooth;
    pts.push([Math.sin(a) * rr, -Math.cos(a) * rr - r * 0.05]);
  }
  return pts;
}

function birchLeaf(len: number, wid: number): Pt[] {
  const side = (s: number) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      const env = t < 0.32 ? Math.pow(Math.sin(((t / 0.32) * Math.PI) / 2), 0.6) : Math.pow((1 - t) / 0.68, 1.25);
      const tooth = 1 + 0.09 * ((i % 2) * 2 - 1) * Math.min(1, t * 4);
      pts.push([s * wid * env * tooth, -len * t]);
    }
    return pts;
  };
  return [...side(1), ...side(-1).reverse()];
}

function fillShape(g: Ctx, pts: Pt[]) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  g.fill();
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

/** A leaf blade at (x, y) pointing along `ang` (0 = up), shaded across its width, with its veins. */
function leaf(g: Ctx, x: number, y: number, ang: number, outline: Pt[], len: number, hue: number, sat: number, light: number, veins: number) {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  let w = 0;
  for (const p of outline) w = Math.max(w, Math.abs(p[0]));
  const grad = g.createLinearGradient(-w, 0, w, -len * 0.3);
  grad.addColorStop(0, hsl(hue, sat, light * 0.7));
  grad.addColorStop(0.55, hsl(hue - 4, sat, light));
  grad.addColorStop(1, hsl(hue - 8, sat - 4, light * 1.2));
  g.fillStyle = grad;
  fillShape(g, outline);
  g.strokeStyle = hsl(hue - 16, sat - 12, Math.min(80, light * 1.55), 0.5);
  g.lineWidth = len * 0.03;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.92);
  g.stroke();
  if (veins > 0) {
    g.lineWidth = len * 0.014;
    g.strokeStyle = hsl(hue - 16, sat - 12, Math.min(80, light * 1.45), 0.32);
    g.beginPath();
    for (let i = 1; i <= veins; i++) {
      const t = i / (veins + 1);
      for (const s of [-1, 1]) {
        g.moveTo(0, -len * t);
        g.lineTo(s * w * 0.7, -len * (t + 0.13));
      }
    }
    g.stroke();
  }
  g.restore();
}

/** A point along a shoot and the way it is heading (0 = up the cell). */
interface Node {
  x: number;
  y: number;
  a: number;
}

/** A twig that tapers and gently turns as it grows; returns its centre line for leaves and side shoots. */
function shoot(g: Ctx, from: Node, len: number, w0: number, turn: number, colour: string): Node[] {
  const n = 10;
  const pts: Node[] = [{ ...from }];
  for (let i = 1; i <= n; i++) {
    const p = pts[i - 1];
    const a = from.a + (turn * i) / n;
    pts.push({ x: p.x + (Math.sin(a) * len) / n, y: p.y - (Math.cos(a) * len) / n, a });
  }
  g.strokeStyle = colour;
  g.lineCap = 'round';
  for (let i = 1; i <= n; i++) {
    g.lineWidth = w0 * (1 - (0.65 * i) / n);
    g.beginPath();
    g.moveTo(pts[i - 1].x, pts[i - 1].y);
    g.lineTo(pts[i].x, pts[i].y);
    g.stroke();
  }
  return pts;
}

const at = (pts: Node[], t: number) => pts[Math.min(pts.length - 1, Math.round(t * (pts.length - 1)))];

/**
 * Paint one spray into a unit cell: the shoot enters at the bottom centre
 * (0, 0) and grows up (−y) toward the top edge near y = −0.95. Each spray is
 * a small branch tip with side shoots, so a card reads as foliage rather
 * than a few big leaves.
 */
function paintSpray(g: Ctx, species: TreeSpecies, row: number) {
  const { rnd, range } = painter(1 + SPECIES_COLUMN[species] * 31 + row * 7);
  const side = () => (rnd() < 0.5 ? -1 : 1);
  switch (species) {
    case 'oak': {
      // Crooked shoots, each ending in a rosette of lobed leaves (oak leaves crowd at the tips).
      const main = shoot(g, { x: 0, y: 0, a: range(-0.12, 0.12) }, 0.7, 0.02, range(-0.3, 0.3), '#4a3a2a');
      const tips: Node[] = [main[main.length - 1]];
      const shoots = [main];
      const n = 5 + row;
      for (let k = 0; k < n; k++) {
        const p = at(main, 0.2 + (0.65 * (k + rnd() * 0.5)) / n);
        const s = k % 2 ? 1 : -1;
        const sub = shoot(g, { x: p.x, y: p.y, a: p.a + s * range(0.6, 1.0) }, range(0.2, 0.3), 0.011, s * range(-0.2, 0.4), '#4f3e2c');
        tips.push(sub[sub.length - 1]);
        shoots.push(sub);
      }
      // A few leaves along the shoots, then the crowded rosettes at their tips.
      for (const pts of shoots)
        for (const t of [0.35, 0.65]) {
          const p = at(pts, t + range(-0.08, 0.08));
          const len = range(0.11, 0.14);
          leaf(g, p.x, p.y, p.a + side() * range(0.7, 1.2), oakLeaf(len, len * 0.34, 5, range(-0.15, 0.15)), len, range(94, 108), range(34, 46), range(17, 24), 3);
        }
      for (const layer of [0.75, 1])
        for (const tip of tips) {
          const count = layer < 1 ? 3 : 5;
          for (let i = 0; i < count; i++) {
            const a = tip.a + (i / (count - 1) - 0.5) * range(2.4, 3.2) + range(-0.2, 0.2);
            const len = range(0.12, 0.16);
            leaf(g, tip.x, tip.y, a, oakLeaf(len, len * range(0.32, 0.38), 4 + Math.floor(rnd() * 2), range(-0.15, 0.15)), len, range(92, 108), range(36, 50), range(20, 30) * layer, 3);
          }
        }
      break;
    }
    case 'maple': {
      // Opposite pairs of palmate leaves on long stalks, on short paired side shoots.
      const main = shoot(g, { x: 0, y: 0, a: range(-0.1, 0.1) }, 0.72, 0.016, range(-0.25, 0.25), '#5a4636');
      const stalkLeaf = (p: Node, a: number, light: number) => {
        const stalk = range(0.06, 0.1);
        const x = p.x + Math.sin(a) * stalk, y = p.y - Math.cos(a) * stalk;
        g.strokeStyle = '#7a6a3e';
        g.lineWidth = 0.006;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(x, y);
        g.stroke();
        const r = range(0.085, 0.105);
        leaf(g, x, y, a + range(-0.25, 0.25), mapleLeaf(r), r * 1.1, range(86, 102), range(40, 54), light * range(24, 33), 0);
        // Palmate veins radiate from the stalk.
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.strokeStyle = hsl(80, 30, 50, 0.35);
        g.lineWidth = r * 0.04;
        g.beginPath();
        for (const v of [0, 0.9, -0.9, 1.8, -1.8]) {
          g.moveTo(0, -r * 0.05);
          g.lineTo(Math.sin(v) * r * 0.8, -Math.cos(v) * r * 0.8 - r * 0.05);
        }
        g.stroke();
        g.restore();
      };
      const nodes = 4;
      for (const layer of [0.8, 1])
        for (let k = 0; k < nodes; k++) {
          const p = at(main, 0.2 + (0.65 * k) / (nodes - 1));
          for (const s of [-1, 1]) {
            if (layer < 1) {
              const sub = shoot(g, { x: p.x, y: p.y, a: p.a + s * range(0.7, 1.0) }, range(0.14, 0.22), 0.008, s * 0.2, '#5a4636');
              const tip = sub[sub.length - 1];
              stalkLeaf(tip, tip.a - 0.5, layer);
              stalkLeaf(tip, tip.a + 0.5, layer);
            } else stalkLeaf(p, p.a + s * range(0.9, 1.3), layer);
          }
        }
      const tip = main[main.length - 1];
      for (const a of [-0.6, 0, 0.6]) stalkLeaf(tip, tip.a + a, 1);
      break;
    }
    case 'birch': {
      // A slender hanging shoot with fine side shoots, all set with small toothed leaves.
      const main = shoot(g, { x: 0, y: 0, a: range(-0.15, 0.15) }, 0.84, 0.009, range(-0.5, 0.5), '#3b2a22');
      const shoots = [main];
      const n = 4 + row;
      for (let k = 0; k < n; k++) {
        const p = at(main, 0.2 + (0.65 * (k + rnd() * 0.6)) / n);
        const s = k % 2 ? 1 : -1;
        shoots.push(shoot(g, { x: p.x, y: p.y, a: p.a + s * range(0.5, 0.9) }, range(0.2, 0.32), 0.005, s * range(0.1, 0.5), '#3b2a22'));
      }
      for (const pts of shoots)
        for (let i = 2; i < pts.length; i++) {
          const p = pts[i];
          const len = range(0.075, 0.1);
          leaf(g, p.x, p.y, p.a + side() * range(0.6, 1.3), birchLeaf(len, len * range(0.38, 0.44)), len, range(78, 92), range(46, 60), range(28, 40), 3);
        }
      break;
    }
    case 'pine': {
      // A shoot with side shoots, each a bottle-brush of paired needles swept forward, tufted at the tip.
      const main = shoot(g, { x: 0, y: 0, a: range(-0.08, 0.08) }, 0.72, 0.018, range(-0.15, 0.15), '#7a4a2c');
      const shoots = [main];
      for (let k = 0; k < 3 + row; k++) {
        const p = at(main, 0.2 + 0.17 * k + range(0, 0.06));
        const s = k % 2 ? 1 : -1;
        shoots.push(shoot(g, { x: p.x, y: p.y, a: p.a + s * range(0.55, 0.85) }, range(0.26, 0.36), 0.01, -s * 0.15, '#7a4a2c'));
      }
      // Needles grouped into a few shades, darkest first, so the lighter tips lie on top.
      const shades = [hsl(146, 22, 13), hsl(140, 24, 18), hsl(132, 26, 23), hsl(112, 30, 30)];
      const lines: number[][] = shades.map(() => []);
      for (const pts of shoots) {
        const last = pts[pts.length - 1];
        const total = Math.hypot(last.x - pts[0].x, last.y - pts[0].y);
        const steps = Math.round(total / 0.008);
        for (let i = 2; i <= steps; i++) {
          const t = i / steps;
          const p = at(pts, t);
          const reach = (0.08 + 0.07 * Math.sin(Math.PI * Math.min(1, 0.25 + t))) * range(0.85, 1.15);
          for (const s of [-1, 1]) {
            const a = p.a + s * range(0.45, 1.1) * (1 - 0.4 * t);
            const shade = Math.min(shades.length - 1, Math.floor(rnd() * 3 + t * 1.4));
            lines[shade].push(p.x, p.y, p.x + Math.sin(a) * reach, p.y - Math.cos(a) * reach);
          }
        }
        for (let i = 0; i < 9; i++) {
          const a = last.a + (i / 8 - 0.5) * 1.8;
          const reach = range(0.06, 0.1);
          lines[3].push(last.x, last.y, last.x + Math.sin(a) * reach, last.y - Math.cos(a) * reach);
        }
      }
      g.lineCap = 'round';
      lines.forEach((ls, k) => {
        g.strokeStyle = shades[k];
        g.lineWidth = 0.0075;
        g.beginPath();
        for (let i = 0; i < ls.length; i += 4) {
          g.moveTo(ls[i], ls[i + 1]);
          g.lineTo(ls[i + 2], ls[i + 3]);
        }
        g.stroke();
      });
      break;
    }
  }
}

/** Mean colour of each species' leaves, given to the transparent texels so mip levels never darken leaf edges. */
const LEAF_BACKDROP: Record<TreeSpecies, RGB> = { oak: [52, 74, 34], maple: [61, 87, 38], birch: [88, 112, 46], pine: [38, 58, 38] };

/** The foliage atlas: real leaf and needle sprays on transparent ground. */
export function leafAtlas(q: Quality): THREE.DataTexture {
  const cell = q === 'high' ? 256 : 128;
  const W = cell * LEAF_ATLAS.cols, H = cell * LEAF_ATLAS.rows;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const species = (Object.keys(SPECIES_COLUMN) as TreeSpecies[]).sort((a, b) => SPECIES_COLUMN[a] - SPECIES_COLUMN[b]);
  for (const sp of species)
    for (let row = 0; row < LEAF_ATLAS.rows; row++) {
      const col = SPECIES_COLUMN[sp];
      g.save();
      // Keep every spray inside its own cell, clear of the edges that mip levels blend.
      g.beginPath();
      g.rect(col * cell + 2, row * cell + 2, cell - 4, cell - 4);
      g.clip();
      g.translate(col * cell + cell / 2, row * cell + cell * 0.97);
      g.scale(cell, cell);
      paintSpray(g, sp, row);
      g.restore();
    }
  const data = new Uint8Array(g.getImageData(0, 0, W, H).data.buffer);
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] === 0) {
      const back = LEAF_BACKDROP[species[Math.floor(((i / 4) % W) / cell)]];
      data[i] = back[0];
      data[i + 1] = back[1];
      data[i + 2] = back[2];
    }
  return dataTexture(data, W, H, true, false);
}

/** Soft round shadow for the ground under a tree (alpha in every channel). */
export function contactShadow(): THREE.DataTexture {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const r = Math.hypot((x + 0.5) / S - 0.5, (y + 0.5) / S - 0.5) * 2;
      const a = Math.pow(1 - smooth(0, 1, r), 1.6) * 255;
      data.fill(a, (y * S + x) * 4, (y * S + x) * 4 + 4);
    }
  return dataTexture(data, S, S, false, false);
}
