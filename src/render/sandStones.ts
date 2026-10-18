import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BOX, PIT } from '../core/constants';
import { seededRandom } from './sandNoise';
import { hash, type Quality } from './textures';

/**
 * Loose stones and clods lying on a pit, drawn as one instanced mesh of
 * lumpy rounded pebbles: gravel resting on the raked fill, clods of damp
 * fill thrown round the rim of each impact, and a little spill on the frame
 * boards. When the fill under a stone is dug out or heaped over, the stone
 * drops with the surface or is lost in it. Hidden stones are left out of
 * the draw (never scaled to nothing, which would make degenerate normals).
 */

export interface PitSurface {
  heightAt(x: number, z: number): number;
}

const Kind = { Gravel: 0, Spill: 1, Clod: 2 } as const;

/** How many of each per quality tier: [gravel, spill, clods]. */
const COUNTS: Record<Quality, [number, number, number]> = {
  high: [150, 50, 48],
  medium: [90, 30, 32],
  low: [40, 14, 16],
};

/** sRGB colours: gravel by mineral, then the fill as clods and spill. */
const GRAVEL = [0x9c968c, 0xb59c7c, 0x7a5f4a, 0xd8d0c0, 0xa3644a, 0x5a5856, 0xc4a882];
const FILL = {
  sand: { clod: 0x5a4430, spill: 0x917657 },
  clay: { clod: 0x3e474e, spill: 0x666f75 },
};

/** Top of the timber frame and of the platforms beside it (see court.ts). */
const BOARD_TOP = 0.012;
const PLATFORM_TOP = 0.004;

const geometries = new Map<number, THREE.BufferGeometry>();

/**
 * A lumpy unit pebble: an icosphere pushed in and out by noise, with
 * vertices welded first so it shades smoothly, and mottled vertex colours.
 */
function pebbleGeometry(detail: number): THREE.BufferGeometry {
  const cached = geometries.get(detail);
  if (cached) return cached;
  const ico = new THREE.IcosahedronGeometry(1, detail);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  ico.dispose();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = [Math.round(x * 50), Math.round(y * 50), Math.round(z * 50)];
    // Radius stays within 0.8–1.2, so no face can collapse.
    const r = 0.8 + 0.4 * hash(key[0] + 7 * key[2], key[1], 3);
    pos.setXYZ(i, x * r, y * r, z * r);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0.84 + 0.3 * hash(key[0], key[1] + 5 * key[2], 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  geometries.set(detail, g);
  return g;
}

const materials = new Map<string, THREE.MeshStandardMaterial>();

function stoneMaterial(kind: 'sand' | 'clay'): THREE.MeshStandardMaterial {
  let m = materials.get(kind);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'sand' ? 0.72 : 0.5, metalness: 0 });
    materials.set(kind, m);
  }
  return m;
}

export class PitStones {
  readonly mesh: THREE.InstancedMesh;
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  /** Surface height under the stone when it was laid down. */
  private readonly base: Float32Array;
  private readonly y: Float32Array;
  private readonly size: Float32Array;
  /** How far the stone's centre sits below the surface (m). */
  private readonly sink: Float32Array;
  /** Rotation and scale, column-major 3×3. */
  private readonly basis: Float32Array;
  private readonly color: Float32Array;
  private readonly kind: Uint8Array;
  private readonly shown: Uint8Array;
  private readonly gravel: number;
  private readonly spill: number;
  private nextClod: number;
  private readonly colors: { clod: number; spill: number };
  private readonly rotation = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scale = new THREE.Vector3();
  private readonly m3 = new THREE.Matrix3();
  private readonly m4 = new THREE.Matrix4();
  private readonly c = new THREE.Color();

  constructor(
    private readonly fill: 'sand' | 'clay',
    quality: Quality,
    private readonly centerZ: number,
  ) {
    const [gravel, spill, clods] = COUNTS[quality];
    // Blue clay carries no gravel; only dried crumbs of itself.
    this.gravel = fill === 'sand' ? gravel : Math.round(gravel * 0.3);
    this.spill = spill;
    const cap = this.gravel + spill + clods;
    this.nextClod = this.gravel + spill;
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.base = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.sink = new Float32Array(cap);
    this.basis = new Float32Array(cap * 9);
    this.color = new Float32Array(cap * 3);
    this.kind = new Uint8Array(cap);
    this.shown = new Uint8Array(cap);
    this.colors = FILL[fill];
    this.mesh = new THREE.InstancedMesh(pebbleGeometry(quality === 'low' ? 0 : 1), stoneMaterial(fill), cap);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'pit-stones';
    // Fixed bounds: the pit and its frame (the stones never leave it).
    const reach = Math.hypot(PIT.width / 2 + BOX.frameWidth + 0.08, PIT.length / 2 + BOX.frameWidth + 0.08);
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, centerZ), reach);
  }

  /** Lay out fresh gravel and spill (after a rake) and clear any clods. */
  scatter(seed: number, surface: PitSurface) {
    const rand = seededRandom(seed);
    this.shown.fill(0);
    const hw = PIT.width / 2, hl = PIT.length / 2;
    for (let s = 0; s < this.gravel; s++) {
      let x = 0, z = 0;
      do {
        x = (rand() * 2 - 1) * (hw - 0.012);
        z = (rand() * 2 - 1) * (hl - 0.012);
      } while (Math.hypot(x, z) < 0.04);
      const r = this.fill === 'sand' ? 0.0018 + 0.003 * rand() ** 2 : 0.002 + 0.003 * rand();
      const col = this.fill === 'sand' ? GRAVEL[Math.floor(rand() * GRAVEL.length)] : this.colors.spill;
      this.place(s, Kind.Gravel, x, this.centerZ + z, r, 0.72 + 0.28 * rand(), 0.35, col, 0.85 + 0.25 * rand(), rand, surface.heightAt(x, this.centerZ + z));
    }
    // Spill: sand kicked onto the boards (mostly the side boards, where the
    // pitchers stand) and a little over onto the platforms.
    const fw = BOX.frameWidth;
    for (let s = 0; s < this.spill; s++) {
      const i = this.gravel + s;
      const side = rand() < 0.75;
      const onPlatform = side && rand() < 0.25;
      const out = onPlatform ? fw + 0.003 + rand() * 0.06 : 0.004 + rand() * (fw - 0.008);
      const along = (rand() * 2 - 1) * (side ? hl : hw) * 0.95;
      const sign = rand() < 0.5 ? -1 : 1;
      const x = side ? sign * (hw + out) : along;
      const z = this.centerZ + (side ? along : sign * (hl + out));
      const top = onPlatform ? PLATFORM_TOP : BOARD_TOP;
      this.place(i, Kind.Spill, x, z, 0.0012 + 0.0022 * rand(), 0.4 + 0.2 * rand(), 0.25, this.colors.spill, 0.9 + 0.2 * rand(), rand, top);
    }
    this.nextClod = this.gravel + this.spill;
    this.rebuild();
  }

  /** Clods of damp fill thrown out round an impact crater of radius `r`, mostly ahead of the shoe. */
  throwClods(x: number, z: number, r: number, dirX: number, dirZ: number, energy: number, surface: PitSurface) {
    const clods = this.x.length - this.gravel - this.spill;
    const count = Math.min(Math.round(clods / 6), Math.round(1 + energy * 0.22));
    const rand = seededRandom(Math.floor(x * 7919 + z * 104729 + energy * 31));
    const heading = dirX || dirZ ? Math.atan2(dirZ, dirX) : rand() * Math.PI * 2;
    const spread = dirX || dirZ ? 1.4 : Math.PI;
    for (let k = 0; k < count; k++) {
      const a = heading + (rand() * 2 - 1) * spread * (0.4 + 0.6 * rand());
      const d = r * (1.15 + 1.3 * rand() ** 1.5);
      const cx = x + Math.cos(a) * d, cz = z + Math.sin(a) * d;
      if (Math.abs(cx) > PIT.width / 2 - 0.01 || Math.abs(cz - this.centerZ) > PIT.length / 2 - 0.01) continue;
      const size = (this.fill === 'sand' ? 0.003 : 0.004) + 0.005 * rand() * Math.min(1, energy / 20);
      this.spawn(cx, cz, size, rand, surface);
    }
    this.rebuild();
  }

  /** A single clod pushed up where a sliding shoe heaps the fill. */
  heapClod(x: number, z: number, seed: number, surface: PitSurface) {
    if (Math.abs(x) > PIT.width / 2 - 0.01 || Math.abs(z - this.centerZ) > PIT.length / 2 - 0.01) return;
    const rand = seededRandom(seed);
    this.spawn(x, z, 0.002 + 0.003 * rand(), rand, surface);
    this.rebuild();
  }

  private spawn(x: number, z: number, size: number, rand: () => number, surface: PitSurface) {
    const i = this.nextClod;
    this.nextClod = i + 1 < this.x.length ? i + 1 : this.gravel + this.spill;
    this.place(i, Kind.Clod, x, z, size, 0.45 + 0.2 * rand(), 0.3, this.colors.clod, 0.8 + 0.3 * rand(), rand, surface.heightAt(x, z));
  }

  private place(i: number, kind: number, x: number, z: number, size: number, flat: number, sink: number, hex: number, shade: number, rand: () => number, ground: number) {
    this.kind[i] = kind;
    this.x[i] = x;
    this.z[i] = z;
    this.size[i] = size;
    this.sink[i] = sink * size * flat;
    this.base[i] = ground;
    this.y[i] = ground - this.sink[i];
    this.shown[i] = 1;
    // Lying flat-side down, turned at random, a little tilted.
    this.euler.set((rand() - 0.5) * 0.5, rand() * Math.PI * 2, (rand() - 0.5) * 0.5);
    this.rotation.setFromEuler(this.euler);
    this.scale.set(size * (0.85 + 0.3 * rand()), size * flat, size * (0.85 + 0.3 * rand()));
    this.m3.setFromMatrix4(this.m4.makeRotationFromQuaternion(this.rotation).scale(this.scale));
    this.basis.set(this.m3.elements, i * 9);
    this.c.setHex(hex).multiplyScalar(shade);
    this.color[i * 3] = this.c.r;
    this.color[i * 3 + 1] = this.c.g;
    this.color[i * 3 + 2] = this.c.b;
  }

  /**
   * The fill changed between (x0, z0) and (x1, z1): stones there follow the
   * surface down or up a little, and vanish if it was dug out from under
   * them or heaped over them.
   */
  settle(x0: number, z0: number, x1: number, z1: number, surface: PitSurface) {
    let changed = false;
    for (let i = 0; i < this.x.length; i++) {
      if (!this.shown[i] || this.kind[i] === Kind.Spill) continue;
      const x = this.x[i], z = this.z[i];
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const h = surface.heightAt(x, z);
      const rise = h - this.base[i];
      const s = this.size[i];
      if (rise < -Math.max(0.004, 1.5 * s) || rise > 0.8 * s) this.shown[i] = 0;
      else this.y[i] = h - this.sink[i];
      changed = true;
    }
    if (changed) this.rebuild();
  }

  /** Write the shown stones into the front of the instance buffers. */
  private rebuild() {
    const M = this.mesh.instanceMatrix.array as Float32Array;
    const C = this.mesh.instanceColor!.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.x.length; i++) {
      if (!this.shown[i]) continue;
      const b = i * 9, o = n * 16;
      M[o] = this.basis[b];
      M[o + 1] = this.basis[b + 1];
      M[o + 2] = this.basis[b + 2];
      M[o + 3] = 0;
      M[o + 4] = this.basis[b + 3];
      M[o + 5] = this.basis[b + 4];
      M[o + 6] = this.basis[b + 5];
      M[o + 7] = 0;
      M[o + 8] = this.basis[b + 6];
      M[o + 9] = this.basis[b + 7];
      M[o + 10] = this.basis[b + 8];
      M[o + 11] = 0;
      M[o + 12] = this.x[i];
      M[o + 13] = this.y[i];
      M[o + 14] = this.z[i];
      M[o + 15] = 1;
      C[n * 3] = this.color[i * 3];
      C[n * 3 + 1] = this.color[i * 3 + 1];
      C[n * 3 + 2] = this.color[i * 3 + 2];
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  /** Free the per-pit instance buffers (the geometry and material are shared). */
  dispose() {
    this.mesh.dispose();
  }
}
