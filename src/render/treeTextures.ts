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

/** Value noise that repeats every `px` cells across and `py` cells down. */
function pnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % px) + px) % px, y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px, y1 = (y0 + 1) % py;
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal sum of `pnoise`, still periodic over the unit square at base frequency (fx, fy). */
function pfbm(u: number, v: number, fx: number, fy: number, octaves: number, seed: number): number {
  let amp = 1, sum = 0, norm = 0, k = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * pnoise(u * fx * k, v * fy * k, fx * k, fy * k, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    k *= 2;
  }
  return sum / norm;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type RGB = [number, number, number];
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Distance to the nearest and second-nearest jittered cell centre (periodic Voronoi). */
function cells(u: number, v: number, nx: number, ny: number, seed: number): [number, number] {
  const x = u * nx, y = v * ny;
  const xi = Math.floor(x), yi = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % nx) + nx) % nx, wy = ((cy % ny) + ny) % ny;
      const dx = cx + 0.15 + 0.7 * hash(wx, wy, seed) - x;
      const dy = cy + 0.15 + 0.7 * hash(wx, wy, seed + 1) - y;
      const d = Math.sqrt(dx * dx + dy * dy * 0.45);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  return [f1, f2];
}

/** One bark texel: relief height (0 deep … 1 proud) and albedo. */
type BarkTexel = (u: number, v: number) => { h: number; c: RGB };

const BARK: Record<TreeSpecies, { texel: BarkTexel; relief: number }> = {
  // Thick, deeply furrowed oak bark: an interlaced net of vertical ridges, grey lichen on the plates.
  oak: {
    relief: 1.4,
    texel(u, v) {
      const warp = pfbm(u, v, 3, 2, 3, 11);
      const f = pfbm(u + warp * 0.18, v, 9, 3, 3, 12);
      const ridge = smooth(0.04, 0.32, Math.abs(f * 2 - 1));
      const crack = smooth(0.66, 0.8, pnoise(u * 12, v * 20, 12, 20, 13)) * ridge;
      const grain = pfbm(u, v, 24, 24, 2, 14);
      const h = ridge * (0.75 + 0.25 * grain) - crack * 0.45;
      let c = lerp3([34, 27, 21], [104, 93, 80], h);
      c = lerp3(c, [72, 62, 52], (grain - 0.5) * 0.6 + 0.2);
      const lichen = smooth(0.58, 0.75, pfbm(u, v, 4, 6, 3, 15)) * ridge;
      return { h, c: lerp3(c, [128, 134, 108], lichen * 0.55) };
    },
  },
  // Maple: smoother grey-brown bark with long shallow fissures and soft mottling.
  maple: {
    relief: 0.9,
    texel(u, v) {
      const warp = pfbm(u, v, 3, 2, 2, 21);
      const f = pfbm(u + warp * 0.12, v, 7, 2, 3, 22);
      const fissure = 1 - smooth(0.0, 0.12, Math.abs(f * 2 - 1));
      const mottle = pfbm(u, v, 5, 8, 4, 23);
      const fine = pfbm(u, v, 32, 32, 2, 24);
      const h = 0.75 + mottle * 0.15 + fine * 0.1 - fissure * 0.55;
      let c = lerp3([86, 78, 68], [138, 128, 114], mottle * 1.2 - 0.1);
      c = lerp3(c, [52, 44, 37], fissure * 0.85);
      return { h, c };
    },
  },
  // Paper birch: chalky white with horizontal lenticels, black scars and the odd peeling curl.
  birch: {
    relief: 0.55,
    texel(u, v) {
      const mottle = pfbm(u, v, 4, 6, 3, 31);
      const len = pnoise(u * 5, v * 56, 5, 56, 32);
      const lenticel = smooth(0.74, 0.86, len) * smooth(0.3, 0.6, pnoise(u * 16, v * 56, 16, 56, 33));
      const scar = smooth(0.62, 0.7, pfbm(u, v, 3, 7, 4, 34));
      const peel = smooth(0.68, 0.78, pfbm(u, v, 6, 10, 3, 35)) * (1 - scar);
      const h = 0.7 + mottle * 0.2 - lenticel * 0.35 - scar * 0.25 + peel * 0.2;
      let c = lerp3([206, 202, 192], [236, 233, 225], mottle);
      c = lerp3(c, [214, 172, 138], peel * 0.6);
      c = lerp3(c, [70, 64, 58], lenticel);
      return { h, c: lerp3(c, [28, 26, 25], scar * 0.92) };
    },
  },
  // Scots pine: reddish plates split by dark fissures, flaking grey at their edges.
  pine: {
    relief: 1.25,
    texel(u, v) {
      const [f1, f2] = cells(u, v, 7, 9, 41);
      const edge = f2 - f1;
      const plate = smooth(0.02, 0.16, edge);
      const flake = pfbm(u, v, 10, 14, 3, 42);
      const h = plate * (0.7 + 0.3 * flake) + (f1 < 0.18 ? 0.05 : 0);
      let c = lerp3([118, 66, 42], [168, 104, 70], flake);
      c = lerp3(c, [138, 126, 114], smooth(0.62, 0.8, flake) * 0.7);
      return { h, c: lerp3([40, 27, 21], c, plate) };
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
  const { texel, relief } = BARK[species];
  const height = new Float32Array(W * H);
  const albedo = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const { h, c } = texel(x / W, y / H);
      const i = y * W + x;
      height[i] = h;
      albedo[i * 4] = c[0];
      albedo[i * 4 + 1] = c[1];
      albedo[i * 4 + 2] = c[2];
      albedo[i * 4 + 3] = 255;
    }
  // Slopes in texels (V spans twice the distance of U per texel count, so both read alike).
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
  return { map: dataTexture(albedo, W, H, true, true), normalMap: dataTexture(normal, W, H, false, true), relief };
}

/** Seeded random for painting (the colour and mask passes replay the same strokes). */
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
  const lobes: [number, number][] = [[0, 1], [0.86, 0.86], [-0.86, 0.86], [1.75, 0.5], [-1.75, 0.5]];
  const pts: Pt[] = [];
  for (let i = 0; i <= 160; i++) {
    const a = -2.75 + (5.5 * i) / 160;
    let m = 0.28;
    for (const [c, l] of lobes) m = Math.max(m, l * Math.pow(Math.max(0, 1 - Math.abs(a - c) / 0.52), 0.75));
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

/** A leaf blade with a light-to-shade gradient across it and its veins. */
function leaf(g: Ctx, mask: boolean, outline: Pt[], len: number, hue: number, sat: number, light: number, veins: number) {
  if (mask) {
    g.fillStyle = '#fff';
    fillShape(g, outline);
    return;
  }
  let w = 0;
  for (const p of outline) w = Math.max(w, Math.abs(p[0]));
  const grad = g.createLinearGradient(-w, 0, w, -len * 0.3);
  grad.addColorStop(0, hsl(hue, sat, light * 0.72));
  grad.addColorStop(0.55, hsl(hue - 4, sat, light));
  grad.addColorStop(1, hsl(hue - 8, sat - 4, light * 1.18));
  g.fillStyle = grad;
  fillShape(g, outline);
  g.strokeStyle = hsl(hue - 18, sat - 12, Math.min(85, light * 1.6), 0.55);
  g.lineWidth = len * 0.022;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, -len * 0.94);
  g.stroke();
  g.lineWidth = len * 0.01;
  g.strokeStyle = hsl(hue - 18, sat - 12, Math.min(85, light * 1.5), 0.35);
  g.beginPath();
  for (let i = 1; i <= veins; i++) {
    const t = i / (veins + 1);
    for (const s of [-1, 1]) {
      g.moveTo(0, -len * t);
      g.lineTo(s * w * 0.75, -len * (t + 0.12));
    }
  }
  g.stroke();
}

/** A tapered twig from the base of the cell toward (tx, ty). */
function twig(g: Ctx, mask: boolean, tx: number, ty: number, w0: number, colour: string) {
  g.fillStyle = mask ? '#fff' : colour;
  const nx = -ty, ny = tx;
  const n = Math.hypot(nx, ny);
  const cx = tx * 0.5 + (nx / n) * 0.04, cy = ty * 0.5 + (ny / n) * 0.04;
  g.beginPath();
  g.moveTo(-w0, 0);
  g.quadraticCurveTo(cx - w0 * 0.6, cy, tx, ty);
  g.quadraticCurveTo(cx + w0 * 0.6, cy, w0, 0);
  g.closePath();
  g.fill();
}

/** Point at fraction `t` along the twig curve drawn by `twig` (control point bowed sideways). */
function onTwig(tx: number, ty: number, t: number): Pt {
  const nx = -ty, ny = tx;
  const n = Math.hypot(nx, ny);
  const cx = tx * 0.5 + (nx / n) * 0.04, cy = ty * 0.5 + (ny / n) * 0.04;
  const b = 2 * t * (1 - t), c = t * t;
  return [b * cx + c * tx, b * cy + c * ty];
}

/**
 * Paint one spray into a unit cell: the twig enters at the bottom centre
 * (0, 0) and grows up (−y) toward the tip near (0, −0.95).
 */
function paintSpray(g: Ctx, mask: boolean, species: TreeSpecies, row: number) {
  const { rnd, range } = painter(1 + SPECIES_COLUMN[species] * 31 + row * 7);
  const tx = range(-0.08, 0.08), ty = -0.86;
  switch (species) {
    case 'oak': {
      twig(g, mask, tx, ty, 0.012, '#4a3a2a');
      // Oak leaves crowd toward the end of each shoot.
      const n = 7 + row;
      for (let i = 0; i < n; i++) {
        const t = i < 2 ? range(0.3, 0.5) : range(0.62, 1);
        const [x, y] = onTwig(tx, ty, t);
        const ang = (i % 2 ? 1 : -1) * range(0.35, 1.3) * (i < 2 ? 1.2 : 1) + (i === n - 1 ? -Math.sign(tx) * 0.2 : 0);
        const len = range(0.3, 0.4) * (i < 2 ? 0.85 : 1);
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        leaf(g, mask, oakLeaf(len, len * range(0.3, 0.36), 4 + Math.floor(rnd() * 2), range(-0.15, 0.15)), len, range(92, 108), range(38, 52), range(21, 31), 4);
        g.restore();
      }
      break;
    }
    case 'maple': {
      twig(g, mask, tx * 0.6, ty * 0.7, 0.01, '#5a4636');
      // Opposite pairs of palmate leaves on long stalks.
      const n = 6 + row;
      for (let i = 0; i < n; i++) {
        const t = 0.3 + (0.7 * Math.floor(i / 2)) / Math.ceil(n / 2) + range(0, 0.08);
        const [x, y] = onTwig(tx * 0.6, ty * 0.7, Math.min(1, t));
        const ang = (i % 2 ? 1 : -1) * range(0.45, 1.15);
        const stalk = range(0.08, 0.14);
        const r = range(0.17, 0.22);
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        if (!mask) g.strokeStyle = '#6b5a3a';
        else g.strokeStyle = '#fff';
        g.lineWidth = 0.008;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -stalk);
        g.stroke();
        g.translate(0, -stalk);
        leaf(g, mask, mapleLeaf(r), r * 1.05, range(86, 104), range(42, 56), range(25, 35), 0);
        if (!mask) {
          // Palmate veins radiate from the stalk.
          g.strokeStyle = hsl(80, 35, 52, 0.4);
          g.lineWidth = r * 0.025;
          g.beginPath();
          for (const a of [0, 0.86, -0.86, 1.7, -1.7]) {
            g.moveTo(0, -r * 0.05);
            g.lineTo(Math.sin(a) * r * 0.8, -Math.cos(a) * r * 0.8 - r * 0.05);
          }
          g.stroke();
        }
        g.restore();
      }
      break;
    }
    case 'birch': {
      twig(g, mask, tx, ty, 0.006, '#3b2a22');
      // Many small toothed leaves, alternate along a slender twig, hanging loosely.
      const n = 13 + row * 2;
      for (let i = 0; i < n; i++) {
        const t = 0.12 + (0.88 * i) / (n - 1);
        const [x, y] = onTwig(tx, ty, t);
        const ang = (i % 2 ? 1 : -1) * range(0.7, 1.5);
        const len = range(0.13, 0.18) * (0.75 + 0.25 * Math.sin(Math.PI * t));
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        if (!mask) g.strokeStyle = '#4a3a28';
        else g.strokeStyle = '#fff';
        g.lineWidth = 0.005;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -0.03);
        g.stroke();
        g.translate(0, -0.03);
        leaf(g, mask, birchLeaf(len, len * range(0.36, 0.42)), len, range(78, 92), range(46, 60), range(30, 40), 4);
        g.restore();
      }
      break;
    }
    case 'pine': {
      // Pairs of long needles all along the shoot, swept forward, a tuft at the tip.
      const steps = 46 + row * 6;
      g.lineCap = 'round';
      for (let i = 0; i < steps; i++) {
        const t = 0.06 + (0.94 * i) / steps;
        const [x, y] = onTwig(tx, ty, t);
        const reach = 0.2 + 0.08 * Math.sin(Math.PI * Math.min(1, t * 1.3));
        for (const s of [-1, 1]) {
          const a = s * range(0.45, 1.05) * (1 - 0.35 * t);
          const len = reach * range(0.85, 1.1);
          const dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
          if (mask) g.strokeStyle = '#fff';
          else {
            const grad = g.createLinearGradient(x, y, x + dx, y + dy);
            const l = range(17, 25);
            grad.addColorStop(0, hsl(range(128, 140), 26, l * 0.75));
            grad.addColorStop(1, hsl(range(110, 126), 30, l * 1.35));
            g.strokeStyle = grad;
          }
          g.lineWidth = range(0.007, 0.01);
          g.beginPath();
          g.moveTo(x, y);
          g.quadraticCurveTo(x + dx * 0.5 + s * 0.01, y + dy * 0.55, x + dx, y + dy);
          g.stroke();
        }
      }
      twig(g, mask, tx, ty, 0.014, '#7a4a2c');
      const [x, y] = onTwig(tx, ty, 1);
      g.fillStyle = mask ? '#fff' : '#8a5a36';
      g.beginPath();
      g.ellipse(x, y - 0.015, 0.01, 0.028, 0, 0, Math.PI * 2);
      g.fill();
      break;
    }
  }
}

/** Mean colour of each species' leaves, painted under the sprays so mip levels never darken their edges. */
const LEAF_BACKDROP: Record<TreeSpecies, string> = { oak: '#344a22', maple: '#3d5726', birch: '#58702e', pine: '#263a26' };

/** The foliage atlas: real leaf and needle sprays on transparent ground, mipmapped without dark fringes. */
export function leafAtlas(q: Quality): THREE.DataTexture {
  const cell = q === 'high' ? 512 : q === 'medium' ? 256 : 128;
  const W = cell * LEAF_ATLAS.cols, H = cell * LEAF_ATLAS.rows;
  const make = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    return c.getContext('2d', { willReadFrequently: true })!;
  };
  const colour = make(), mask = make();
  mask.fillStyle = '#000';
  mask.fillRect(0, 0, W, H);
  for (const species of Object.keys(SPECIES_COLUMN) as TreeSpecies[]) {
    const col = SPECIES_COLUMN[species];
    colour.fillStyle = LEAF_BACKDROP[species];
    colour.fillRect(col * cell, 0, cell, H);
    for (let row = 0; row < LEAF_ATLAS.rows; row++)
      for (const [g, isMask] of [[colour, false], [mask, true]] as const) {
        g.save();
        g.translate(col * cell + cell / 2, row * cell + cell * 0.97);
        g.scale(cell, cell);
        paintSpray(g, isMask, species, row);
        g.restore();
      }
  }
  const rgba = colour.getImageData(0, 0, W, H).data;
  const alpha = mask.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[i];
    data[i + 1] = rgba[i + 1];
    data[i + 2] = rgba[i + 2];
    data[i + 3] = alpha[i];
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
