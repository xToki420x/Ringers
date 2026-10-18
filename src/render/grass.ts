import * as THREE from 'three';
import { BOX, HALF_COURT, PIT } from '../core/constants';
import { mulberry32 } from '../physics/errorModel';
import { COURT_SPACING } from './court';
import type { Quality } from './textures';
import type { GrassStyle } from './lawn';
import { GRASS_LOOKS, WILD, type GrassLook } from './grassStyles';
import { lawnFields, noiseAt, type LawnFields } from './lawnFields';
import { flowerGeometry, lawnShoot, leafGeometry, meadowClump } from './grassGeometry';
import { plantMaterial, type PlantLook, type PlantUniforms } from './grassMaterial';

/**
 * Instanced 3D grass: shoots of curved, tapered blades grown in natural
 * clumps over the lawn around the court, tinted from the same fields as the
 * ground (stripes, clover, dry patches, worn ground), plus clover and weeds,
 * flowers, and long seeding meadow grass where the style has them. Blade
 * height fades out toward the edges of the grass areas and with distance
 * from the camera, so the blades melt into the ground texture with no edge.
 * Each plant type is one instanced draw.
 */

export interface GrassArea {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Grass shoots (a few blades each) per square metre at high quality. */
  perM2: number;
}

export interface GrassOptions {
  style: GrassStyle;
  /** Where blades grow (defaults: the playing court and the lawn around it). */
  areas?: GrassArea[];
  /** Extra places grass must not grow (props, paths), on top of the pitching boxes. */
  blocked?: (x: number, z: number) => boolean;
  /**
   * Centre x of each court; pass the same list as `buildLawn`. Every
   * court's pitching boxes are kept clear, and worn ground and the edge of a
   * meadow's long grass follow the courts, matching the ground. Defaults to
   * the five-court row the stage builds (-2..2 court spacings).
   */
  courts?: number[];
}

export interface GrassTier {
  /** Density multiplier and the most shoots a lawn may have. */
  density: number;
  budget: number;
  /** Blades per shoot, segments per blade, blade width multiplier (fewer, broader blades on lighter tiers). */
  blades: number;
  segs: number;
  width: number;
  /** Lawn plants are full size within `fade[0]` metres of the camera and gone by `fade[1]`. */
  fade: [number, number];
  /** Long meadow grass: blades and seed stalks per tussock, segments, density multiplier, view distance, thinning (see PlantLook). */
  wild: { blades: number; seeds: number; segs: number; density: number; fade: [number, number]; thin: [number, number, number] };
  /** Clover, weeds and flowers density multiplier. */
  extras: number;
}

/** Blade counts, sizes and view distances per quality tier (the ground shades its long meadow grass to match). */
export const GRASS_TIERS: Record<Quality, GrassTier> = {
  high: { density: 1, budget: 108_000, blades: 3, segs: 3, width: 1, fade: [16, 26], wild: { blades: 10, seeds: 2, segs: 4, density: 1, fade: [55, 85], thin: [9, 30, 0.9] }, extras: 1 },
  medium: { density: 0.42, budget: 47_000, blades: 2, segs: 3, width: 1.2, fade: [12, 19], wild: { blades: 7, seeds: 1, segs: 3, density: 0.45, fade: [38, 58], thin: [7, 22, 0.8] }, extras: 0.5 },
  low: { density: 0.18, budget: 20_000, blades: 2, segs: 2, width: 1.4, fade: [8, 13], wild: { blades: 5, seeds: 1, segs: 3, density: 0.2, fade: [26, 40], thin: [5, 15, 0.6] }, extras: 0.25 },
};

/** The lawn surface the plants root in. */
const GROUND_Y = -0.02;

const DEFAULT_COURTS = [-2, -1, 0, 1, 2].map((c) => c * COURT_SPACING);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Linear RGB of an sRGB hex colour. */
const linear = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** Default grass: dense around both pitching boxes, a little lighter down the court, thinning over the surrounding lawn. */
function defaultAreas(court: number): GrassArea[] {
  const inner = HALF_COURT - 3.2;
  return [
    { x0: court - 2.6, x1: court + 2.6, z0: inner, z1: HALF_COURT + 3.4, perM2: 1000 },
    { x0: court - 2.6, x1: court + 2.6, z0: -HALF_COURT - 3.4, z1: -inner, perM2: 1000 },
    { x0: court - 2.6, x1: court + 2.6, z0: -inner, z1: inner, perM2: 560 },
    { x0: court - 6.5, x1: court + 6.5, z0: -HALF_COURT - 6, z1: HALF_COURT + 6, perM2: 150 },
  ];
}

/**
 * Shoot density and area coverage on a grid, both blurred so density
 * changes and the outer edge of the grass fade smoothly instead of
 * stepping at area borders.
 */
class AreaGrid {
  readonly cell = 0.25;
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly density: Float32Array;
  readonly cover: Float32Array;

  constructor(areas: GrassArea[]) {
    const pad = 1.5;
    this.x0 = Math.min(...areas.map((a) => a.x0)) - pad;
    this.z0 = Math.min(...areas.map((a) => a.z0)) - pad;
    this.nx = Math.ceil((Math.max(...areas.map((a) => a.x1)) + pad - this.x0) / this.cell);
    this.nz = Math.ceil((Math.max(...areas.map((a) => a.z1)) + pad - this.z0) / this.cell);
    this.density = new Float32Array(this.nx * this.nz);
    this.cover = new Float32Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * this.cell, z = this.z0 + (j + 0.5) * this.cell;
        for (const a of areas)
          if (x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1) {
            this.density[j * this.nx + i] = Math.max(this.density[j * this.nx + i], a.perM2);
            this.cover[j * this.nx + i] = 1;
          }
      }
    for (let k = 0; k < 2; k++) {
      this.blur(this.density, 3);
      this.blur(this.cover, 4);
    }
  }

  private blur(f: Float32Array, r: number) {
    const { nx, nz } = this;
    const tmp = new Float32Array(f.length);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += f[j * nx + Math.min(nx - 1, Math.max(0, i + k))];
        tmp[j * nx + i] = s / (2 * r + 1);
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[Math.min(nz - 1, Math.max(0, j + k)) * nx + i];
        f[j * nx + i] = s / (2 * r + 1);
      }
  }

  /** Bilinear coverage (0 outside the grass areas .. 1 well inside). */
  coverAt(x: number, z: number): number {
    return this.sample(this.cover, x, z);
  }

  densityAt(x: number, z: number): number {
    return this.sample(this.density, x, z);
  }

  private sample(c: Float32Array, x: number, z: number): number {
    const fx = Math.min(this.nx - 1.001, Math.max(0, (x - this.x0) / this.cell - 0.5));
    const fz = Math.min(this.nz - 1.001, Math.max(0, (z - this.z0) / this.cell - 0.5));
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const n = this.nx;
    return lerp(lerp(c[j * n + i], c[j * n + i + 1], tx), lerp(c[(j + 1) * n + i], c[(j + 1) * n + i + 1], tx), tz);
  }
}

/** Per-instance attribute arrays for one plant type. */
class Batch {
  readonly pos: number[] = [];
  readonly shape: number[] = [];
  readonly col: number[] = [];
  readonly col2: number[] = [];

  get count() {
    return this.pos.length / 4;
  }

  add(pos: [number, number, number, number], shape: [number, number, number, number], col: number[], col2?: number[]) {
    this.pos.push(...pos);
    this.shape.push(...shape);
    this.col.push(col[0], col[1], col[2]);
    if (col2) this.col2.push(col2[0], col2[1], col2[2]);
  }

  mesh(geo: THREE.InstancedBufferGeometry, mat: THREE.Material): THREE.Mesh {
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(this.pos), 4));
    geo.setAttribute('iShape', new THREE.InstancedBufferAttribute(new Float32Array(this.shape), 4));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(this.col), 3));
    if (this.col2.length) geo.setAttribute('iColor2', new THREE.InstancedBufferAttribute(new Float32Array(this.col2), 3));
    geo.instanceCount = this.count;
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    return m;
  }
}

/** Flower varieties: petal colour, centre colour, notch between petals (1 = round), head radius and stem height ranges. */
const FLOWERS = {
  dandelion: { petal: 0xf2c51c, centre: 0xe9a512, notch: 0.62, radius: [0.013, 0.019], stem: [0.08, 0.15] },
  cloverFlower: { petal: 0xd8d2c4, centre: 0xc9b9a0, notch: 0.88, radius: [0.007, 0.01], stem: [0.07, 0.11] },
  daisy: { petal: 0xe4e0d6, centre: 0xe0ae20, notch: 0.38, radius: [0.009, 0.013], stem: [0.05, 0.09] },
  oxeye: { petal: 0xe4e0d6, centre: 0xdca81c, notch: 0.36, radius: [0.02, 0.028], stem: [0.3, 0.5] },
  buttercup: { petal: 0xf3cf1d, centre: 0xd9a514, notch: 0.6, radius: [0.01, 0.014], stem: [0.25, 0.42] },
  redClover: { petal: 0xb5507c, centre: 0x9c3f68, notch: 0.9, radius: [0.011, 0.015], stem: [0.18, 0.3] },
  cornflower: { petal: 0x5c72d6, centre: 0x3e4ea8, notch: 0.42, radius: [0.013, 0.018], stem: [0.3, 0.48] },
} as const;
type FlowerKind = keyof typeof FLOWERS;

export class Grass {
  readonly mesh = new THREE.Group();
  private readonly uniforms: PlantUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  private readonly look: GrassLook;
  private readonly courts: number[];
  private readonly rnd = mulberry32(1234);
  /** Instances per plant type (for performance logging). */
  readonly counts: Record<string, number> = {};

  constructor(q: Quality, opts: GrassOptions = { style: 'manicured' }) {
    const tier = GRASS_TIERS[q];
    this.look = GRASS_LOOKS[opts.style];
    this.courts = opts.courts?.length ? opts.courts : DEFAULT_COURTS;
    const playing = this.courts.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
    const extra = opts.blocked;
    const blocked = (x: number, z: number) => this.inBox(x, z) || !!extra?.(x, z);
    const grid = new AreaGrid(opts.areas ?? defaultAreas(playing));
    this.grow(tier, grid, blocked);
    this.shadeGround(tier, grid);
    if (this.look.cloverCover > 0 || this.look.weeds > 0) this.growLeaves(tier, grid, blocked);
    if (this.look.flowers > 0) this.growFlowers(tier, grid, blocked);
    if (this.look.wild) this.growMeadow(tier, blocked);
  }

  /** Pitching boxes (pit, frame, platforms), backboard footings and 30 ft platforms of every court. */
  private inBox(x: number, z: number): boolean {
    for (const cx of this.courts) {
      const ax = Math.abs(x - cx);
      if (ax > BOX.width / 2 + 0.06) continue;
      for (const zc of [-HALF_COURT, HALF_COURT]) {
        const dz = Math.abs(z - zc);
        if (dz < BOX.length / 2 + 0.03) return true;
        if (Math.abs(dz - BOX.backboardDistance) < 0.06) return true;
        const inner = PIT.width / 2 + BOX.frameWidth;
        if (ax > inner - 0.02 && ax < BOX.width / 2 + 0.03 && dz > BOX.length / 2 - 0.05 && dz < BOX.length / 2 + 3.06 && Math.sign(z - zc) === -Math.sign(zc)) return true;
      }
    }
    return false;
  }

  /** Distance from (x, z) to the nearest pitching box. */
  private boxDistance(x: number, z: number): number {
    let d = Infinity;
    for (const cx of this.courts) {
      const ox = Math.max(0, Math.abs(x - cx) - BOX.width / 2);
      const oz = Math.max(0, Math.abs(Math.abs(z) - HALF_COURT) - BOX.length / 2);
      d = Math.min(d, Math.hypot(ox, oz));
    }
    return d;
  }

  /** Mowing stripe direction at x: +1 laid toward +z, -1 toward -z (matches the ground shader). */
  private stripeDir(x: number): number {
    const lane = Math.floor(x / this.look.stripeWidth + 0.5);
    return ((lane % 2) + 2) % 2 === 0 ? 1 : -1;
  }

  /** Tip colour of a shoot: the style's blade colour with the ground's tonal fields and per-shoot variety. */
  private tipColour(f: LawnFields, base: number, dryChance: number): number[] {
    const look = this.look, rnd = this.rnd;
    const tip = linear(base);
    const hue = [lerp(0.9, 1.12, f.hue), lerp(1, 1.02, f.hue), lerp(1.08, 0.8, f.hue)];
    const bright = (0.8 + 0.42 * f.macro) * (1 + (rnd() - 0.5) * 0.4 * look.variety);
    const shift = (rnd() - 0.5) * look.variety;
    let c = tip.map((v, i) => v * hue[i] * bright);
    c[0] *= 1 + 0.3 * shift;
    c[2] *= 1 - 0.35 * shift;
    const clover = linear(look.clover);
    c = c.map((v, i) => lerp(v, clover[i] * bright, f.clover * 0.35));
    const worn = smooth(0, 0.5, f.wear);
    c = c.map((v, i) => v * lerp(1, [1.15, 1.08, 0.85][i], worn));
    const dry = Math.min(1, f.dry * 0.6 + (rnd() < dryChance ? 0.4 + rnd() * 0.5 : 0));
    const straw = linear(look.dry);
    return c.map((v, i) => lerp(v, straw[i] * bright, dry));
  }

  /** The lawn: shoots of blades over the grass areas. */
  private grow(tier: GrassTier, grid: AreaGrid, blocked: (x: number, z: number) => boolean) {
    const look = this.look, rnd = this.rnd, courts = this.courts;
    const batch = new Batch();
    const area = grid.cell * grid.cell;
    let total = 0;
    for (const d of grid.density) total += d * area;
    const k = Math.min(tier.density * look.density, tier.budget / Math.max(1, total));
    for (let j = 0; j < grid.nz; j++)
      for (let i = 0; i < grid.nx; i++) {
        const dens = grid.density[j * grid.nx + i];
        if (dens < 1 || grid.cover[j * grid.nx + i] < 0.3) continue;
        const cx = grid.x0 + i * grid.cell, cz = grid.z0 + j * grid.cell;
        const fc = lawnFields(look, courts, cx + grid.cell / 2, cz + grid.cell / 2);
        const mod = (0.55 + 0.9 * fc.clump) * (1 - 0.8 * fc.wear * look.soilShow) * (1 - fc.wild) * (1 - 0.6 * fc.clover);
        const n = Math.floor(dens * area * k * mod + rnd());
        let px = cx, pz = cz;
        for (let s = 0; s < n; s++) {
          // Shoots gather in small clumps.
          let x: number, z: number;
          if (s > 0 && rnd() < 0.3) {
            x = px + (rnd() + rnd() - 1) * 0.025;
            z = pz + (rnd() + rnd() - 1) * 0.025;
          } else {
            x = cx + rnd() * grid.cell;
            z = cz + rnd() * grid.cell;
          }
          px = x;
          pz = z;
          if (blocked(x, z)) continue;
          const fade = smooth(0.3, 0.85, grid.coverAt(x, z));
          if (fade <= 0.01) continue;
          const f = lawnFields(look, courts, x, z);
          let h = lerp(look.height[0], look.height[1], rnd()) * (1 + look.uneven * (noiseAt(x, z, 4.3, 3) - 0.5) * 1.6);
          h *= (1 - 0.45 * f.wear) * (1 - 0.6 * f.wild);
          // Kept short around the boxes so a landed shoe is never hidden.
          h = Math.min(h, lerp(0.062, 1, smooth(1.6, 2.6, this.boxDistance(x, z))));
          const yaw = look.stripes > 0 ? (this.stripeDir(x) > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 0.9 : rnd() * Math.PI * 2;
          const bend = lerp(look.lean[0], look.lean[1], rnd()) * (1 + 0.7 * f.wear);
          // Mixed species: some broad-bladed, some fine.
          const sp = rnd();
          const width = look.width * tier.width * (0.8 + 0.4 * rnd()) * (sp < 0.25 * look.variety ? 1.45 : sp > 1 - 0.2 * look.variety ? 0.7 : 1);
          batch.add([x, z, h, yaw], [bend, look.spread * (0.75 + 0.5 * rnd()), width, fade], this.tipColour(f, look.tip, 0.04 * look.variety));
        }
      }
    const tip = linear(look.tip), root = linear(look.root);
    const plant: PlantLook = {
      groundY: GROUND_Y,
      fade: tier.fade,
      sway: 0.12,
      rootMul: new THREE.Color(root[0] / tip[0], root[1] / tip[1], root[2] / tip[2]),
      stripes: [look.stripes, look.stripeWidth],
      translucency: 1,
      upBlend: 0.6,
      roughness: 0.7,
    };
    this.add('shoots', batch, lawnShoot(tier.blades, tier.segs), plantMaterial('blade', this.uniforms, plant));
  }

  /**
   * Shade under the blades: darkens the ground where blades grow, as you
   * look down into the turf between them. It follows blade density and
   * fades with camera distance just as the blades do, so the field has
   * depth up close and no edge where it ends.
   */
  private shadeGround(tier: GrassTier, grid: AreaGrid) {
    const step = 2;
    const nx = Math.floor(grid.nx / step), nz = Math.floor(grid.nz / step);
    const w = nx * step * grid.cell, d = nz * step * grid.cell;
    const geo = new THREE.PlaneGeometry(w, d, nx, nz);
    geo.rotateX(-Math.PI / 2);
    geo.translate(grid.x0 + w / 2, GROUND_Y + 0.0012, grid.z0 + d / 2);
    const p = geo.getAttribute('position');
    const maxDensity = grid.density.reduce((m, v) => Math.max(m, v), 1);
    const rgba = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const dense = Math.sqrt(grid.densityAt(x, z) / maxDensity);
      rgba[i * 4 + 3] = 0.42 * dense * smooth(0.3, 0.85, grid.coverAt(x, z)) * smooth(0.2, 0.6, this.boxDistance(x, z)) * (1 - lawnFields(this.look, this.courts, x, z).wild);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    const fade = { value: new THREE.Vector2(...tier.fade) };
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, vertexColors: true, transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFade = fade;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uFade;\nvarying float vShadeFade;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShadeFade = 1.0 - smoothstep(uFade.x, uFade.y, length(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz));');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vShadeFade;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vShadeFade;');
    };
    const shade = new THREE.Mesh(geo, mat);
    shade.renderOrder = -1;
    this.mesh.add(shade);
  }

  /** Clover in its patches and broadleaf weed rosettes scattered through the lawn. */
  private growLeaves(tier: GrassTier, grid: AreaGrid, blocked: (x: number, z: number) => boolean) {
    const look = this.look, rnd = this.rnd;
    const batch = new Batch();
    const area = grid.cell * grid.cell;
    const clover = linear(look.clover), weed = linear(0x2b4a1a);
    for (let j = 0; j < grid.nz; j++)
      for (let i = 0; i < grid.nx; i++) {
        if (grid.cover[j * grid.nx + i] < 0.5) continue;
        const cx = grid.x0 + i * grid.cell, cz = grid.z0 + j * grid.cell;
        const f = lawnFields(look, this.courts, cx + grid.cell / 2, cz + grid.cell / 2);
        const nClover = Math.floor(f.clover * 420 * area * tier.extras * (1 - f.wild) + rnd());
        const nWeed = Math.floor(look.weeds * area * tier.extras * (1 + f.wear + f.dry) * (1 - f.wild) + rnd());
        for (let s = 0; s < nClover + nWeed; s++) {
          const x = cx + rnd() * grid.cell, z = cz + rnd() * grid.cell;
          if (blocked(x, z) || this.boxDistance(x, z) < 0.15) continue;
          const fade = smooth(0.5, 0.9, grid.coverAt(x, z));
          const b = 0.8 + 0.35 * rnd();
          if (s < nClover) {
            const stalk = lerp(look.height[0], look.height[1], rnd()) * (0.7 + 0.3 * rnd());
            batch.add([x, z, 0.011 + rnd() * 0.006, rnd() * Math.PI * 2], [stalk, 1, 0.22, fade], clover.map((v) => v * b));
          } else {
            // A rosette: two whorls of three leaves pressed flat into the turf, the inner one shorter.
            const size = 0.02 + rnd() * 0.012, yaw = rnd() * Math.PI * 2, elong = 1.7 + rnd() * 0.5;
            batch.add([x, z, size, yaw], [0.004, elong, -0.25, fade], weed.map((v) => v * b));
            batch.add([x, z, size * 0.72, yaw + Math.PI / 3], [0.007, elong * 0.9, -0.3, fade], weed.map((v) => v * b * 1.12));
          }
        }
      }
    const plant: PlantLook = { groundY: GROUND_Y, fade: tier.fade, sway: 0.05, translucency: 0.5, upBlend: 0.25, roughness: 0.5 };
    this.add('leaves', batch, leafGeometry(), plantMaterial('leaf', this.uniforms, plant));
  }

  /** Dandelions and daisies in the lawn, clover flowers in clover patches, wildflowers in long meadow grass. */
  private growFlowers(tier: GrassTier, grid: AreaGrid, blocked: (x: number, z: number) => boolean) {
    const look = this.look, rnd = this.rnd;
    const batch = new Batch();
    const add = (kind: FlowerKind, x: number, z: number, fade: number, scale = 1) => {
      const fl = FLOWERS[kind];
      const b = 0.9 + 0.2 * rnd();
      batch.add(
        [x, z, lerp(fl.stem[0], fl.stem[1], rnd()) * scale, rnd() * Math.PI * 2],
        [0.15 + rnd() * 0.35, lerp(fl.radius[0], fl.radius[1], rnd()), fl.notch, fade],
        linear(fl.petal).map((v) => v * b),
        linear(fl.centre),
      );
    };
    const area = grid.cell * grid.cell;
    const lawnKinds: FlowerKind[] = look.wild ? ['daisy'] : look.dryCover > 0.1 ? ['dandelion', 'daisy', 'dandelion'] : ['dandelion'];
    for (let j = 0; j < grid.nz; j++)
      for (let i = 0; i < grid.nx; i++) {
        if (grid.cover[j * grid.nx + i] < 0.5) continue;
        const cx = grid.x0 + i * grid.cell, cz = grid.z0 + j * grid.cell;
        const f = lawnFields(look, this.courts, cx + grid.cell / 2, cz + grid.cell / 2);
        const nLawn = Math.floor(look.flowers * area * tier.extras * (1 - f.wear) * (1 - f.wild) + rnd());
        const nClover = Math.floor(f.clover * 18 * area * tier.extras * (1 - f.wild) + rnd());
        for (let s = 0; s < nLawn + nClover; s++) {
          const x = cx + rnd() * grid.cell, z = cz + rnd() * grid.cell;
          if (blocked(x, z) || this.boxDistance(x, z) < 0.6) continue;
          const kind = s < nLawn ? lawnKinds[Math.floor(rnd() * lawnKinds.length)] : 'cloverFlower';
          add(kind, x, z, smooth(0.5, 0.9, grid.coverAt(x, z)));
        }
      }
    if (look.wild) {
      const wildKinds: FlowerKind[] = ['oxeye', 'buttercup', 'buttercup', 'redClover', 'cornflower', 'oxeye'];
      this.scatterMeadow(1.4 * tier.extras, blocked, (x, z, w) => {
        // Wildflowers grow in drifts.
        if (noiseAt(x, z, 13, 2) < 0.45) return;
        add(wildKinds[Math.floor(rnd() * wildKinds.length)], x, z, 1, 0.6 + 0.4 * w);
      });
    }
    const plant: PlantLook = { groundY: GROUND_Y, fade: look.wild ? tier.wild.fade : tier.fade, sway: 0.2, translucency: 0.8, upBlend: 0.3, roughness: 0.6 };
    this.add('flowers', batch, flowerGeometry(8), plantMaterial('flower', this.uniforms, plant));
  }

  /**
   * Calls `plant` for random points in the meadow's long grass around the
   * mown courts, at `perM2` weighted by how wild the ground is there and
   * thinning out gradually with distance from the courts, so there is no
   * edge where the plants stop and the ground's own meadow takes over.
   */
  private scatterMeadow(perM2: number, blocked: (x: number, z: number) => boolean, plant: (x: number, z: number, wild: number) => void) {
    const rnd = this.rnd;
    const reach = 26;
    const cMin = Math.min(...this.courts), cMax = Math.max(...this.courts);
    const cell = 0.5;
    for (let z = -HALF_COURT - reach; z < HALF_COURT + reach; z += cell)
      for (let x = cMin - reach; x < cMax + reach; x += cell) {
        const far = Math.hypot(Math.max(0, cMin - x, x - cMax), Math.max(0, Math.abs(z) - HALF_COURT));
        const thin = (0.2 + 0.8 * smooth(21, 7, far)) * smooth(reach, reach - 7, far);
        if (thin <= 0) continue;
        const w = lawnFields(this.look, this.courts, x + cell / 2, z + cell / 2).wild;
        const n = Math.floor(perM2 * w * thin * cell * cell + rnd());
        for (let s = 0; s < n; s++) {
          const px = x + rnd() * cell, pz = z + rnd() * cell;
          if (!blocked(px, pz)) plant(px, pz, w);
        }
      }
  }

  /** Long meadow grass: tussocks of arching blades and seed stalks beyond the mown area. */
  private growMeadow(tier: GrassTier, blocked: (x: number, z: number) => boolean) {
    const rnd = this.rnd;
    const batch = new Batch();
    const tip = linear(WILD.tip), root = linear(WILD.root), straw = linear(this.look.dry);
    this.scatterMeadow(15 * tier.wild.density, blocked, (x, z, w) => {
      // Drifts of taller and shorter grass, cut lower toward the mown edge.
      const tall = smooth(0.3, 1, w) * (0.7 + 0.6 * noiseAt(x, z, 7, 3));
      const h = lerp(0.16, 0.34, rnd()) * (0.35 + 0.65 * tall);
      const b = 0.82 + 0.36 * rnd();
      // Patches ripening to straw, and a few bluer or yellower tussocks.
      const dry = Math.min(1, rnd() * 0.5 * noiseAt(x, z, 23, 2) + (rnd() < 0.08 ? 0.5 : 0));
      const hue = (rnd() - 0.5) * 0.25;
      const c = tip.map((v, i) => lerp(v, straw[i], dry) * b * (1 + hue * [1, 0, -1.4][i]));
      batch.add([x, z, h, rnd() * Math.PI * 2], [lerp(0.6, 1.1, rnd()), 1, 0.0045 + rnd() * 0.0025, 1], c);
    });
    const plant: PlantLook = {
      groundY: GROUND_Y,
      fade: tier.wild.fade,
      thin: tier.wild.thin,
      sway: 0.3,
      rootMul: new THREE.Color(root[0] / tip[0], root[1] / tip[1], root[2] / tip[2]),
      seed: new THREE.Color(WILD.seed),
      translucency: 1,
      upBlend: 0.6,
      roughness: 0.6,
    };
    this.add('meadow', batch, meadowClump(tier.wild.blades, tier.wild.segs, tier.wild.seeds), plantMaterial('blade', this.uniforms, plant));
  }

  private add(name: string, batch: Batch, geo: THREE.InstancedBufferGeometry, mat: THREE.Material) {
    this.counts[name] = batch.count;
    if (batch.count) this.mesh.add(batch.mesh(geo, mat));
  }

  /** Plant instances across every type. */
  get count() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  update(time: number) {
    this.uniforms.uTime.value = time;
  }
}
