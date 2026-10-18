import * as THREE from 'three';
import { PIT } from '../core/constants';
import type { MapSet } from './textures';
import { fbm, hash, vnoise } from './textures';
import { sandPitMaterial } from './sandMaterial';
import { seededRandom, smoothstep } from './sandNoise';
import { spillDusting } from './sandSpill';
import { PitStones } from './sandStones';
import { SAND_TILE, sandMapsQuality } from './sandTextures';

/**
 * A deformable pit surface. Shoes carve real trenches as they plow in,
 * impacts leave craters with lumpy thrown-up rims and scatter clods, and
 * freshly turned fill is darker, damper and glossier than the raked
 * surface. The heightfield is edited on the CPU and only the dirty region
 * is recomputed and uploaded.
 */

/** Lowest the visible fill can be dug (the lawn sits just below). */
const SAND_FLOOR = -0.018;
/** Fill banked up against the frame boards, and packed down round the stake (m). */
const BANK = 0.005;
const PACK = 0.0015;
/** Outer edge of an impact's thrown-up rim, in crater radii. */
const CRATER_RIM = 1.7;
/** Fill a sliding shoe pushes aside (sum of cell depths, m) for each clod it heaps up. */
const CLOD_SPOIL = 0.12;
/** Darkening per unit of surface curvature (1/m) in hollows, and its limit. */
const CAVITY = 0.03;
const CAVITY_MAX = 0.25;
/** Cells out to measure curvature: one rake-tine pitch, so furrows cancel and only real hollows count. */
const CAVITY_REACH = 4;
/** Vertex-colour multipliers for fully damp fill. */
const DAMP_TINT = { sand: [0.56, 0.5, 0.45], clay: [0.74, 0.77, 0.81] } as const;

/** One pull of the rake: a curved band of tine grooves, in pit coordinates (stake at the origin). */
interface Stroke {
  x: number;
  z: number;
  /** Unit direction of the pull. */
  dx: number;
  dz: number;
  len: number;
  half: number;
  /** Curvature (1/m) and a hand wobble across the stroke. */
  bend: number;
  wobble: number;
  wobbleFreq: number;
  wobblePhase: number;
  depth: number;
  /** Tine offset across the stroke, in tine spacings. */
  phase: number;
  /** Sand gathered where the rake lifted out. */
  berm: number;
  id: number;
}

/** A spot of clay patted down flat with the back of a shovel. */
interface Pat {
  x: number;
  z: number;
  rx: number;
  rz: number;
  cos: number;
  sin: number;
  level: number;
}

/** Smooth bump on (-1, 1). */
const bump = (x: number) => (x > -1 && x < 1 ? (1 - x * x) ** 2 : 0);

export class SandPit {
  readonly mesh: THREE.Mesh;
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly height: Float32Array;
  readonly disturb: Float32Array;
  /** Moisture the rake left (damper sand in the furrows, packed fill round the stake). */
  private readonly moist: Float32Array;
  /** Broad colour variation across the pit (vertex colour before damp). */
  private readonly tint: Float32Array;
  private readonly stones: PitStones;
  private readonly geo: THREE.BufferGeometry;
  private dirty = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
  private readonly origin: THREE.Vector3;
  private rakeSeed = 1;
  private impacts = 0;
  /** Fill pushed aside by sliding shoes since the last heaped clod. */
  private spoil = 0;

  constructor(
    readonly end: 0 | 1,
    centerZ: number,
    maps: MapSet,
    readonly kind: 'sand' | 'clay',
    cell = 0.0075,
  ) {
    this.cell = cell;
    this.nx = Math.round(PIT.width / cell) + 1;
    this.nz = Math.round(PIT.length / cell) + 1;
    this.origin = new THREE.Vector3(-PIT.width / 2, 0, centerZ - PIT.length / 2);
    const n = this.nx * this.nz;
    this.height = new Float32Array(n);
    this.disturb = new Float32Array(n);
    this.moist = new Float32Array(n);
    this.tint = new Float32Array(n * 3);
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    const state = new Float32Array(n * 2);
    const tile = SAND_TILE[kind];
    const seed = 7 + end * 31;
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        const u = i * cell, v = j * cell;
        pos[k * 3] = this.origin.x + u;
        pos[k * 3 + 2] = this.origin.z + v;
        nor[k * 3 + 1] = 1;
        uv[k * 2] = u / tile;
        uv[k * 2 + 1] = v / tile;
        // Broad patches of lighter or darker, warmer or greyer fill.
        const tone = 0.9 + 0.13 * fbm(u * 3, v * 3, 1024, 3, seed) + 0.07 * fbm(u * 11, v * 11, 1024, 2, seed + 3);
        const warm = (fbm(u * 2.5, v * 2.5, 1024, 2, seed + 5) - 0.5) * (kind === 'sand' ? 0.12 : 0.06);
        this.tint[k * 3] = tone * (1 + warm);
        this.tint[k * 3 + 1] = tone;
        this.tint[k * 3 + 2] = tone * (1 - warm);
        // Which texture layer shows where (see sandMaterial).
        state[k * 2 + 1] = smoothstep(0.38, 0.62, fbm(u * 4, v * 4, 1024, 2, seed + 9));
      }
    // Diagonals alternate cell by cell, so slanting furrows don't stair-step.
    const idx: number[] = [];
    for (let j = 0; j < this.nz - 1; j++)
      for (let i = 0; i < this.nx - 1; i++) {
        const a = j * this.nx + i;
        const b = a + 1;
        const c = a + this.nx;
        const d = c + 1;
        if ((i + j) & 1) idx.push(a, c, d, a, d, b);
        else idx.push(a, c, b, b, c, d);
      }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.setAttribute('sandState', new THREE.BufferAttribute(state, 2));
    this.geo.setIndex(idx);
    // Heights stay within a few centimetres, so the bounds never need recomputing.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, centerZ), Math.hypot(PIT.width / 2, PIT.length / 2, 0.05));
    this.mesh = new THREE.Mesh(this.geo, sandPitMaterial(maps, kind));
    this.mesh.receiveShadow = true;
    this.mesh.name = `pit-${end}`;
    this.stones = new PitStones(kind, sandMapsQuality(maps), centerZ);
    const dust = spillDusting(maps, kind, centerZ, seed);
    this.mesh.add(this.stones.mesh, dust);
    this.geo.addEventListener('dispose', () => {
      this.stones.dispose();
      dust.geometry.dispose();
    });
    this.rake();
  }

  /**
   * Rake the pit: overlapping, slightly curved pulls of the rake with tine
   * furrows (and a cross stroke or two), fill banked against the boards and
   * packed round the stake. Clay is chopped, then patted flat in places.
   */
  rake() {
    const seed = this.rakeSeed++;
    const rand = seededRandom(seed * 7919 + this.end * 104729);
    const sand = this.kind === 'sand';
    const strokes = sand ? this.layStrokes(rand) : [];
    const pats = sand ? [] : this.layPats(rand);
    const pitch = Math.max(0.028, this.cell * 4); // tine spacing the heightfield resolves cleanly
    const hw = PIT.width / 2, hl = PIT.length / 2;
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        const x = i * this.cell - hw;
        const z = j * this.cell - hl;
        const edge = Math.min(hw - Math.abs(x), hl - Math.abs(z));
        const ds = Math.hypot(x, z);
        const bank = 1 - smoothstep(0, 0.07, edge);
        let base =
          (fbm(x * 3 + 50, z * 3 + 50, 1024, 3, seed) - 0.5) * 0.004 +
          BANK * bank * bank * (0.7 + 0.6 * fbm(x * 12 + 9, z * 12 + 9, 1024, 2, seed + 1)) -
          PACK * (1 - smoothstep(0.02, 0.16, ds));
        let moist = 0;
        if (!sand) {
          // Chopped clay: lumps a few centimetres across, moist throughout.
          base += (fbm(x * 25 + 3, z * 25 + 3, 1024, 2, seed + 2) - 0.5) * 0.003;
          moist = 0.22 + 0.12 * fbm(x * 6, z * 6, 1024, 2, seed + 4);
        }
        let h = base;
        // The rake can't quite reach into the corners against the boards.
        const reach = smoothstep(0.012, 0.05, edge);
        for (const s of strokes) {
          const px = x - s.x, pz = z - s.z;
          const a = px * s.dx + pz * s.dz;
          if (a < 0 || a > s.len) continue;
          const c = -px * s.dz + pz * s.dx - 0.5 * s.bend * a * a + s.wobble * Math.sin(a * s.wobbleFreq + s.wobblePhase);
          const fc = Math.abs(c) / s.half;
          if (fc >= 1) continue;
          const fa = a / s.len;
          const cover = (1 - smoothstep(0.8, 1, fc)) * smoothstep(0, 0.03, fa) * reach;
          const t = c / pitch + s.phase;
          const tine = Math.round(t);
          // Each tine bites in and lifts out at its own point, so the ends are ragged.
          const ragged = 0.08 * hash(tine, s.id, 6);
          const bite = smoothstep(ragged, ragged + 0.1, fa) * (1 - smoothstep(0.86 - ragged, 0.98 - ragged, fa));
          const groove = 0.5 + 0.5 * Math.cos(t * Math.PI * 2); // 1 down a furrow, 0 on a ridge
          // Pressure on the rake comes and goes along the pull.
          const press = 0.55 + 0.9 * fbm(a * 5 + s.id * 7, tine * 0.15, 1024, 2, s.id);
          const depth = s.depth * bite * press * (0.7 + 0.6 * hash(tine, s.id, 5));
          const berm = s.berm * bump((fa - 0.95) / 0.07) * (1 - fc * fc);
          h += (base + depth * (0.35 - 1.35 * groove) + berm - h) * cover;
          // Furrow bottoms turn up damper sand.
          moist += (groove * 0.32 * bite - moist) * cover;
        }
        for (const p of pats) {
          const px = x - p.x, pz = z - p.z;
          const u = (px * p.cos + pz * p.sin) / p.rx;
          const v = (-px * p.sin + pz * p.cos) / p.rz;
          const r = Math.sqrt(u * u + v * v);
          if (r >= 1.25) continue;
          const m = 1 - smoothstep(0.7, 1, r);
          // Pressed flat and glossy, with clay squeezed up round the rim.
          h += (p.level + base * 0.25 - h) * m + 0.0008 * bump((r - 1.02) / 0.18);
          moist += (0.36 - moist) * m;
        }
        // Round the stake the fill is packed by landing shoes, not raked.
        const packed = 1 - smoothstep(0.08, 0.17, ds);
        h += (base - h) * packed;
        moist += ((sand ? 0.16 : 0.45) - moist) * packed;
        this.height[k] = h + (hash(i, j, seed) - 0.5) * 0.0003;
        this.moist[k] = moist;
        this.disturb[k] = 0;
      }
    this.markDirty(0, 0, this.nx - 1, this.nz - 1);
    this.stones.scatter(seed * 13 + this.end, this);
  }

  /** Three lanes of two overlapping lengthwise pulls each, in random order, then a cross stroke along one or both ends. */
  private layStrokes(rand: () => number): Stroke[] {
    const hw = PIT.width / 2, hl = PIT.length / 2;
    const strokes: Stroke[] = [];
    const add = (x: number, z: number, angle: number, len: number, half: number) =>
      strokes.push({
        x,
        z,
        dx: Math.cos(angle),
        dz: Math.sin(angle),
        len,
        half,
        bend: (rand() - 0.5) * 0.7,
        wobble: 0.002 + 0.003 * rand(),
        wobbleFreq: (Math.PI * 2) / (0.25 + 0.4 * rand()),
        wobblePhase: rand() * Math.PI * 2,
        depth: 0.0018 + 0.0008 * rand(),
        phase: rand(),
        berm: 0.0012 + 0.0015 * rand(),
        id: strokes.length,
      });
    for (let lane = 0; lane < 3; lane++) {
      const x = (lane - 1) * 0.29 + (rand() - 0.5) * 0.06;
      for (let part = 0; part < 2; part++) {
        // Pulled toward whichever end the raker stood at.
        const toward = rand() < 0.5 ? 1 : -1;
        const len = hl + 0.12 + 0.15 * rand();
        const far = part === 0 ? -hl - 0.04 : hl + 0.04;
        const near = part === 0 ? far + len : far - len;
        const start = toward > 0 === (part === 0) ? far : near;
        add(x, start, (toward * Math.PI) / 2 + (rand() - 0.5) * 0.3, len, 0.19 + 0.025 * rand());
      }
    }
    for (let i = strokes.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [strokes[i], strokes[j]] = [strokes[j], strokes[i]];
    }
    // Tidying strokes across one or both ends, along the end boards.
    for (const end of rand() < 0.6 ? [rand() < 0.5 ? -1 : 1] : [-1, 1]) {
      const toward = rand() < 0.5 ? 1 : -1;
      const z = end * (hl - 0.1 - 0.12 * rand());
      add(-toward * (hw + 0.03), z, (toward > 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.4, PIT.width * (0.55 + 0.5 * rand()), 0.15 + 0.03 * rand());
    }
    return strokes;
  }

  private layPats(rand: () => number): Pat[] {
    const pats: Pat[] = [];
    for (let i = 10 + Math.floor(rand() * 5); i > 0; i--) {
      const rx = 0.05 + 0.06 * rand();
      const a = rand() * Math.PI;
      pats.push({
        x: (rand() * 2 - 1) * PIT.width * 0.45,
        z: (rand() * 2 - 1) * PIT.length * 0.45,
        rx,
        rz: rx * (0.6 + 0.4 * rand()),
        cos: Math.cos(a),
        sin: Math.sin(a),
        level: (rand() - 0.5) * 0.002,
      });
    }
    return pats;
  }

  private markDirty(i0: number, j0: number, i1: number, j1: number) {
    this.dirty.x0 = Math.max(0, Math.min(this.dirty.x0, i0));
    this.dirty.z0 = Math.max(0, Math.min(this.dirty.z0, j0));
    this.dirty.x1 = Math.min(this.nx - 1, Math.max(this.dirty.x1, i1));
    this.dirty.z1 = Math.min(this.nz - 1, Math.max(this.dirty.z1, j1));
  }

  contains(x: number, z: number): boolean {
    const i = (x - this.origin.x) / this.cell;
    const j = (z - this.origin.z) / this.cell;
    return i >= 0 && j >= 0 && i <= this.nx - 1 && j <= this.nz - 1;
  }

  heightAt(x: number, z: number): number {
    const fi = (x - this.origin.x) / this.cell;
    const fj = (z - this.origin.z) / this.cell;
    const i = Math.max(0, Math.min(this.nx - 2, Math.floor(fi)));
    const j = Math.max(0, Math.min(this.nz - 2, Math.floor(fj)));
    const tx = Math.min(1, Math.max(0, fi - i)), tz = Math.min(1, Math.max(0, fj - j));
    const k = j * this.nx + i;
    const h = this.height;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + this.nx] * (1 - tx) + h[k + this.nx + 1] * tx) * tz;
  }

  /**
   * Press a contact point into the fill: cells above `y` within `radius` are
   * cut down to it, and the displaced fill is heaped ahead of the motion.
   */
  carve(x: number, y: number, z: number, radius: number, dirX: number, dirZ: number): number {
    const ci = (x - this.origin.x) / this.cell;
    const cj = (z - this.origin.z) / this.cell;
    const R = Math.max(1, Math.ceil(radius / this.cell));
    const i0 = Math.floor(ci) - R, i1 = Math.ceil(ci) + R;
    const j0 = Math.floor(cj) - R, j1 = Math.ceil(cj) + R;
    let removed = 0;
    for (let j = j0; j <= j1; j++) {
      if (j < 1 || j >= this.nz - 1) continue;
      for (let i = i0; i <= i1; i++) {
        if (i < 1 || i >= this.nx - 1) continue;
        const d = Math.hypot(i - ci, j - cj) * this.cell;
        if (d > radius) continue;
        const k = j * this.nx + i;
        // Spherical contact: deeper at the centre.
        const floor = Math.max(SAND_FLOOR, y + (radius - Math.sqrt(Math.max(0, radius * radius - d * d))));
        if (this.height[k] > floor) {
          removed += this.height[k] - floor;
          this.height[k] = floor;
          this.disturb[k] = Math.min(1, this.disturb[k] + 0.5);
        }
      }
    }
    if (removed > 0) {
      const len = Math.hypot(dirX, dirZ);
      const fx = len > 1e-4 ? dirX / len : 0, fz = len > 1e-4 ? dirZ / len : 0;
      // Heap the fill in a crescent ahead (or a ring if not moving).
      const spots = len > 1e-4 ? 5 : 8;
      for (let s = 0; s < spots; s++) {
        let ax: number, az: number;
        if (len > 1e-4) {
          const a = (s - (spots - 1) / 2) * 0.45;
          ax = fx * Math.cos(a) - fz * Math.sin(a);
          az = fx * Math.sin(a) + fz * Math.cos(a);
        } else {
          ax = Math.cos((s / spots) * Math.PI * 2);
          az = Math.sin((s / spots) * Math.PI * 2);
        }
        const di = Math.round(ci + ax * (R + 1.5));
        const dj = Math.round(cj + az * (R + 1.5));
        this.deposit(di, dj, (removed * 0.85) / spots);
      }
      this.markDirty(i0 - R - 3, j0 - R - 3, i1 + R + 3, j1 + R + 3);
      // Now and then the heap breaks into a clod.
      this.spoil += removed;
      if (this.spoil > CLOD_SPOIL && len > 1e-4) {
        this.spoil = 0;
        const ahead = radius + 2 * this.cell;
        this.stones.heapClod(x + fx * ahead, z + fz * ahead, ++this.impacts * 131 + this.rakeSeed, this);
      }
    }
    return removed;
  }

  private deposit(ci: number, cj: number, amount: number) {
    const w = [0.4, 0.15, 0.15, 0.15, 0.15];
    const off = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let n = 0; n < 5; n++) {
      const i = ci + off[n][0], j = cj + off[n][1];
      if (i < 1 || j < 1 || i >= this.nx - 1 || j >= this.nz - 1) continue;
      const k = j * this.nx + i;
      this.height[k] += amount * w[n];
      this.disturb[k] = Math.min(1, this.disturb[k] + 0.25);
    }
  }

  /** Impact crater with a lumpy raised rim, throwing a few clods of fill. */
  crater(x: number, z: number, energy: number, dirX = 0, dirZ = 0) {
    const r = Math.min(0.07, 0.02 + energy * 0.006);
    const depth = Math.min(0.012, 0.002 + energy * 0.0012);
    const ci = (x - this.origin.x) / this.cell;
    const cj = (z - this.origin.z) / this.cell;
    // Elongated along the direction of travel; the bounds cover the long axis.
    const stretch = dirX || dirZ ? 0.6 : 1;
    const R = Math.ceil((r * CRATER_RIM) / stretch / this.cell);
    const seed = ++this.impacts * 977 + this.rakeSeed;
    for (let j = Math.floor(cj) - R; j <= Math.ceil(cj) + R; j++) {
      if (j < 1 || j >= this.nz - 1) continue;
      for (let i = Math.floor(ci) - R; i <= Math.ceil(ci) + R; i++) {
        if (i < 1 || i >= this.nx - 1) continue;
        const dx = (i - ci) * this.cell, dz = (j - cj) * this.cell;
        const along = dx * dirX + dz * dirZ;
        const across = -dx * dirZ + dz * dirX;
        const d = Math.hypot(across, along * stretch) / r;
        if (d >= CRATER_RIM) continue;
        const k = j * this.nx + i;
        // Thrown fill lands in clumps a couple of centimetres across, not as a smooth ring.
        const lump = vnoise(i * 0.4, j * 0.4, 4096, seed);
        // A flat-bottomed dent with steep walls, and a clumpy rim of thrown fill.
        if (d < 1) this.height[k] = Math.max(SAND_FLOOR, this.height[k] - depth * (1 - d * d * d) + (lump - 0.5) * depth * 0.25 * (1 - d));
        else this.height[k] += depth * 0.6 * Math.sin(((d - 1) / (CRATER_RIM - 1)) * Math.PI) * (0.5 + lump);
        this.disturb[k] = Math.min(1, this.disturb[k] + 1.1 * (1 - d / CRATER_RIM));
      }
    }
    this.markDirty(Math.floor(ci) - R - 1, Math.floor(cj) - R - 1, Math.ceil(ci) + R + 1, Math.ceil(cj) + R + 1);
    this.stones.throwClods(x, z, r, dirX, dirZ, energy, this);
  }

  /** Push changes to the GPU (only the rows that changed). */
  update() {
    const d = this.dirty;
    if (d.x0 > d.x1) return;
    // Shading reads heights a few cells away, so refresh a little beyond the edit.
    const r = CAVITY_REACH;
    const x0 = Math.max(0, d.x0 - r), x1 = Math.min(this.nx - 1, d.x1 + r);
    const z0 = Math.max(0, d.z0 - r), z1 = Math.min(this.nz - 1, d.z1 + r);
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = this.geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const state = this.geo.getAttribute('sandState') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, N = nor.array as Float32Array, C = col.array as Float32Array, W = state.array as Float32Array;
    const h = this.height, nx = this.nx, c2 = 2 * this.cell;
    const damp = DAMP_TINT[this.kind];
    const cavityScale = CAVITY / (CAVITY_REACH * CAVITY_REACH * this.cell * this.cell);
    for (let j = z0; j <= z1; j++)
      for (let i = x0; i <= x1; i++) {
        const k = j * nx + i;
        P[k * 3 + 1] = h[k];
        const hl = h[k - (i > 0 ? 1 : 0)], hr = h[k + (i < nx - 1 ? 1 : 0)];
        const hd = h[k - (j > 0 ? nx : 0)], hu = h[k + (j < this.nz - 1 ? nx : 0)];
        let ax = (hl - hr) / c2, az = (hd - hu) / c2;
        const l = Math.hypot(ax, 1, az);
        ax /= l;
        az /= l;
        N[k * 3] = ax;
        N[k * 3 + 1] = 1 / l;
        N[k * 3 + 2] = az;
        // Hollows (craters, trenches) see less sky: darken them by curvature.
        const ring = h[j * nx + Math.max(0, i - r)] + h[j * nx + Math.min(nx - 1, i + r)] + h[Math.max(0, j - r) * nx + i] + h[Math.min(this.nz - 1, j + r) * nx + i];
        const cavity = 1 - Math.min(CAVITY_MAX, Math.max(0, (ring - 4 * h[k]) * cavityScale));
        // Damp fill darkens quickly, then saturates.
        const wet = Math.min(1, this.disturb[k] + this.moist[k]);
        const t = wet * (2 - wet);
        C[k * 3] = this.tint[k * 3] * (1 + (damp[0] - 1) * t) * cavity;
        C[k * 3 + 1] = this.tint[k * 3 + 1] * (1 + (damp[1] - 1) * t) * cavity;
        C[k * 3 + 2] = this.tint[k * 3 + 2] * (1 + (damp[2] - 1) * t) * cavity;
        W[k * 2] = wet;
      }
    const rows = (a: THREE.BufferAttribute) => {
      a.clearUpdateRanges();
      a.addUpdateRange(z0 * nx * a.itemSize, (z1 - z0 + 1) * nx * a.itemSize);
      a.needsUpdate = true;
    };
    rows(pos);
    rows(nor);
    rows(col);
    rows(state);
    const c = this.cell;
    this.stones.settle(this.origin.x + x0 * c, this.origin.z + z0 * c, this.origin.x + x1 * c, this.origin.z + z1 * c, this);
    d.x0 = d.z0 = Infinity;
    d.x1 = d.z1 = -Infinity;
  }
}
