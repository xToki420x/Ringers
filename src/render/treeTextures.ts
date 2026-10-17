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
  const gap = new Float32Array(W * H), id = new Int32Array(W * H);
  for (let py = 0; py < H; py++)
    for (let px = 0; px < W; px++) {
      const w = warp ? warp[py * W + px] - 0.5 : 0;
      const x = (px / W + w * 0.08) * nx, y = (py / H + w * 0.05) * ny;
      const xi = Math.floor(x), yi = Math.floor(y);
      let f1 = 9, f2 = 9, best = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const cx = xi + i, cy = yi + j;
          const k = (((cy % ny) + ny) % ny) * nx + (((cx % nx) + nx) % nx);
          const dx = cx + jx[k] - x, dy = cy + jy[k] - y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
            best = k;
          } else if (d < f2) f2 = d;
        }
      gap[py * W + px] = f2 - f1;
      id[py * W + px] = best;
    }
  return { gap, id };
}

/** `f` sampled `dx` texels across (wrapping), for warping ridges sideways. */
const across = (f: Float32Array, W: number, i: number, x: number, dx: number) => f[i - x + ((((x + Math.round(dx)) % W) + W) % W)];

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
  // Thick, deeply furrowed oak bark: tall interlaced ridges broken by cross cracks, lichen on the ridges.
  oak: {
    relief: 1.6,
    paint(W, H, height, out) {
      const warp = field(W, H, 4, 2, 2, 11), mottle = field(W, H, 4, 6, 3, 15), grain = field(W, H, 32, 4, 2, 14);
      const { gap } = voronoi(W, H, 12, 4, 12, warp);
      const cracks = field(W, H, 9, 26, 1, 13);
      const furrow: RGB = [26, 21, 17], ridgeTop: RGB = [98, 90, 80], weathered: RGB = [62, 53, 45], lichen: RGB = [122, 128, 102];
      const p = new Paint();
      for (let y = 0, i = 0; y < H; y++)
        for (let x = 0; x < W; x++, i++) {
          // Furrows wander in width; ridges stay narrow and rough.
          const n = grain[i] * 0.12;
          const ridge = smooth(0.08 + n, 0.3 + n, gap[i]);
          const crack = smooth(0.64, 0.74, cracks[i]) * ridge;
          const g = grain[i], m = mottle[i];
          const h = ridge * (0.75 + 0.25 * g) - crack * 0.5;
          height[i] = h;
          p.lerp(furrow, ridgeTop, h).mix(weathered, (1 - m) * 0.5);
          out(i, p.mix(lichen, smooth(0.66, 0.8, m) * ridge * 0.4));
        }
    },
  },
  // Maple: smoother grey-brown bark, long shallow fissures between flat strips, soft mottling.
  maple: {
    relief: 0.9,
    paint(W, H, height, out) {
      const warp = field(W, H, 3, 1, 2, 21), strips = field(W, H, 11, 2, 2, 22), mottle = field(W, H, 5, 8, 3, 23), fine = field(W, H, 32, 32, 1, 24);
      const dark: RGB = [88, 80, 70], light: RGB = [140, 131, 118], fissured: RGB = [50, 43, 36];
      const p = new Paint();
      for (let y = 0, i = 0; y < H; y++)
        for (let x = 0; x < W; x++, i++) {
          const f = across(strips, W, i, x, (warp[i] - 0.5) * W * 0.15);
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
  // Scots pine: irregular reddish plates split by deep dark fissures, flaking in thin layers.
  pine: {
    relief: 1.4,
    paint(W, H, height, out) {
      const warp = field(W, H, 4, 4, 2, 42), tone = field(W, H, 8, 12, 3, 44);
      const plates = voronoi(W, H, 6, 7, 41, warp), flakes = voronoi(W, H, 18, 22, 43);
      const rust: RGB = [132, 74, 48], orange: RGB = [176, 112, 76], grey: RGB = [128, 116, 104], flaking: RGB = [92, 58, 42], fissured: RGB = [34, 23, 18];
      const p = new Paint();
      for (let i = 0; i < W * H; i++) {
        const fissure = 1 - smooth(0.03, 0.18, plates.gap[i]);
        const own = hash(plates.id[i], 7, 45);
        const flakeEdge = 1 - smooth(0.0, 0.06, flakes.gap[i]);
        const t = tone[i];
        height[i] = (1 - fissure) * (0.75 + 0.15 * own + 0.1 * t) - flakeEdge * 0.12;
        p.lerp(rust, orange, t * 0.7 + own * 0.3).mix(grey, smooth(0.62, 0.85, own) * 0.55);
        out(i, p.mix(flaking, flakeEdge * 0.5).mix(fissured, fissure));
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
