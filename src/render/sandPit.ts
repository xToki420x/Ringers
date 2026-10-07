import * as THREE from 'three';
import { PIT } from '../core/constants';
import type { MapSet } from './textures';
import { fbm } from './textures';

/**
 * A deformable pit surface. Shoes carve real trenches as they plow in,
 * impacts leave craters with thrown-up rims, and freshly turned fill is
 * darker and damper than the raked surface. The heightfield is edited on
 * the CPU and only the dirty region's normals are recomputed.
 */
/** Lowest the visible fill can be dug (the lawn sits just below). */
const SAND_FLOOR = -0.018;

export class SandPit {
  readonly mesh: THREE.Mesh;
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly height: Float32Array;
  readonly disturb: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private dirty = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
  private readonly origin: THREE.Vector3;
  private rakeSeed = 1;

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
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const col = new Float32Array(n * 3);
    const tile = kind === 'sand' ? 0.42 : 0.6;
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        pos[k * 3] = this.origin.x + i * cell;
        pos[k * 3 + 2] = this.origin.z + j * cell;
        nor[k * 3 + 1] = 1;
        uv[k * 2] = (i * cell) / tile;
        uv[k * 2 + 1] = (j * cell) / tile;
        col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1;
      }
    const idx: number[] = [];
    for (let j = 0; j < this.nz - 1; j++)
      for (let i = 0; i < this.nx - 1; i++) {
        const a = j * this.nx + i;
        const b = a + 1;
        const c = a + this.nx;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.setIndex(idx);
    const mat = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughnessMap: maps.roughnessMap ?? null,
      roughness: 1,
      metalness: 0,
      vertexColors: true,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = `pit-${end}`;
    this.rake();
  }

  /** Rake the pit smooth: fine furrows, a slight crown, packed fill around the stake. */
  rake() {
    const seed = this.rakeSeed++;
    const sz = this.origin.z + PIT.length / 2;
    for (let j = 0; j < this.nz; j++)
      for (let i = 0; i < this.nx; i++) {
        const k = j * this.nx + i;
        const x = this.origin.x + i * this.cell;
        const z = this.origin.z + j * this.cell;
        const u = i / (this.nx - 1), v = j / (this.nz - 1);
        let h = (fbm(u * 3, v * 5, 64, 3, seed) - 0.5) * (this.kind === 'sand' ? 0.006 : 0.003);
        if (this.kind === 'sand') {
          // Rake tines leave furrows across the pit, slightly wavy.
          const wav = Math.sin((z * 2 * Math.PI) / 0.019 + fbm(u * 4, v * 2, 32, 2, seed + 3) * 5);
          h += wav * 0.0011 * (0.6 + 0.4 * fbm(u * 6, v * 3, 32, 2, seed + 5));
        }
        // Gentle dish near the walls (fill gets kicked out over time).
        const edge = Math.min(u, 1 - u, v * 1.6, (1 - v) * 1.6);
        h -= Math.max(0, 0.08 - edge) * 0.05;
        // Packed, slightly lower fill right around the stake.
        const ds = Math.hypot(x, z - sz);
        h -= Math.max(0, 0.12 - ds) * 0.03;
        this.height[k] = h;
        this.disturb[k] = Math.max(0, 0.25 - ds * 2) * (this.kind === 'sand' ? 1 : 0.5);
      }
    this.markDirty(0, 0, this.nx - 1, this.nz - 1);
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

  /** Impact crater with a raised rim. */
  crater(x: number, z: number, energy: number, dirX = 0, dirZ = 0) {
    const r = Math.min(0.07, 0.02 + energy * 0.006);
    const depth = Math.min(0.012, 0.002 + energy * 0.0012);
    const ci = (x - this.origin.x) / this.cell;
    const cj = (z - this.origin.z) / this.cell;
    const R = Math.ceil((r * 1.8) / this.cell);
    for (let j = Math.floor(cj) - R; j <= Math.ceil(cj) + R; j++) {
      if (j < 1 || j >= this.nz - 1) continue;
      for (let i = Math.floor(ci) - R; i <= Math.ceil(ci) + R; i++) {
        if (i < 1 || i >= this.nx - 1) continue;
        // Elongated along the direction of travel.
        const dx = (i - ci) * this.cell, dz = (j - cj) * this.cell;
        const along = dx * dirX + dz * dirZ;
        const across = -dx * dirZ + dz * dirX;
        const d = Math.hypot(across, along * (dirX || dirZ ? 0.6 : 1)) / r;
        const k = j * this.nx + i;
        if (d < 1) this.height[k] = Math.max(SAND_FLOOR, this.height[k] - depth * (1 - d * d));
        else if (d < 1.8) this.height[k] += depth * 0.45 * Math.sin(((d - 1) / 0.8) * Math.PI);
        if (d < 1.8) this.disturb[k] = Math.min(1, this.disturb[k] + 0.6 * (1.8 - d));
      }
    }
    this.markDirty(Math.floor(ci) - R - 1, Math.floor(cj) - R - 1, Math.ceil(ci) + R + 1, Math.ceil(cj) + R + 1);
  }

  /** Push changes to the GPU. */
  update() {
    const d = this.dirty;
    if (d.x0 > d.x1) return;
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = this.geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const P = pos.array as Float32Array, N = nor.array as Float32Array, C = col.array as Float32Array;
    const h = this.height, nx = this.nx, c2 = 2 * this.cell;
    const damp = this.kind === 'sand' ? [0.78, 0.74, 0.7] : [0.8, 0.82, 0.85];
    for (let j = d.z0; j <= d.z1; j++)
      for (let i = d.x0; i <= d.x1; i++) {
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
        const t = this.disturb[k];
        C[k * 3] = 1 + (damp[0] - 1) * t;
        C[k * 3 + 1] = 1 + (damp[1] - 1) * t;
        C[k * 3 + 2] = 1 + (damp[2] - 1) * t;
      }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    col.needsUpdate = true;
    this.geo.computeBoundingSphere();
    d.x0 = d.z0 = Infinity;
    d.x1 = d.z1 = -Infinity;
  }
}
