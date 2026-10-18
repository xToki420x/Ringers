import * as THREE from 'three';

/**
 * Template geometry for instanced lawn plants. Each is authored in a small
 * abstract space (along/across/part codes) that the vegetation shader bends,
 * sizes and places per instance, so one draw renders thousands of plants.
 * Triangles are wound so their front face matches the normal the shader
 * computes, and no template triangle is degenerate.
 */

/**
 * An instanced template from authored positions and triangles. The
 * placeholder normal keeps three on smooth (not flat, derivative-based)
 * shading; the vegetation shader computes the real normal per vertex.
 */
function template(pos: number[], idx: number[]): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

/** Blade outline: half-width (fraction of the root width) at `t` up the blade; parallel-sided, then tapering to the tip. */
const bladeWidth = (t: number) => 1 - 0.15 * t - 0.5 * Math.pow(Math.max(0, (t - 0.4) / 0.6), 1.5);

/** Seed stalk levels: [t, half-width, seed head 0/1]: a thin stem swelling into a spike. */
const SEED_LEVELS = [
  [0, 0.5, 0],
  [0.4, 0.45, 0],
  [0.7, 0.4, 0],
  [0.76, 1.6, 1],
  [0.9, 1.3, 1],
];

export interface ShootBlade {
  /** Splay direction relative to the shoot (radians, scaled by its spread). */
  fan: number;
  height: number;
  width: number;
  /** Bend multiplier (seed stalks stand straighter than leaves). */
  bend: number;
  /** Root offset from the shoot centre, metres (across, forward). */
  root: [number, number];
  /** True for a seed stalk: narrow stem, ripe head near the top. */
  seed?: boolean;
  /** Thinning order with camera distance, 0 (kept longest) .. 1 (first to go). */
  rank: number;
}

/**
 * A grass shoot: a few blades from one root, each a tapered strip of `segs`
 * segments ending in a point. Attributes: position = (across, t, seedHead),
 * blade = (fan, height, width, bend), bladeRoot = root offset, bladeRank =
 * thinning order.
 */
export function shootGeometry(blades: ShootBlade[], segs: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const info: number[] = [];
  const roots: number[] = [];
  const ranks: number[] = [];
  const idx: number[] = [];
  for (const b of blades) {
    const base = pos.length / 3;
    const levels = b.seed ? SEED_LEVELS : Array.from({ length: segs }, (_, i) => Math.pow(i / segs, 0.85)).map((t) => [t, bladeWidth(t), 0]);
    for (const [t, w, head] of levels) {
      pos.push(-w, t, head, w, t, head);
      for (let k = 0; k < 2; k++) {
        info.push(b.fan, b.height, b.width, b.bend);
        roots.push(...b.root);
        ranks.push(b.rank);
      }
    }
    pos.push(0, 1, b.seed ? 1 : 0);
    info.push(b.fan, b.height, b.width, b.bend);
    roots.push(...b.root);
    ranks.push(b.rank);
    for (let i = 0; i < levels.length - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const last = base + (levels.length - 1) * 2;
    idx.push(last, last + 1, last + 2);
  }
  const g = template(pos, idx);
  g.setAttribute('blade', new THREE.Float32BufferAttribute(info, 4));
  g.setAttribute('bladeRoot', new THREE.Float32BufferAttribute(roots, 2));
  g.setAttribute('bladeRank', new THREE.Float32BufferAttribute(ranks, 1));
  return g;
}

/** Blades of a lawn shoot at each detail level: three splayed blades, or two on lighter tiers. */
export function lawnShoot(blades: number, segs: number) {
  const all: ShootBlade[] = [
    { fan: 0, height: 1, width: 1, bend: 1, root: [0, 0], rank: 0 },
    { fan: 2.15, height: 0.84, width: 0.92, bend: 1.15, root: [0.017, 0.008], rank: 0.5 },
    { fan: -2.05, height: 0.7, width: 0.86, bend: 1.3, root: [-0.011, 0.016], rank: 1 },
  ];
  return shootGeometry(all.slice(0, blades), segs);
}

/**
 * A tussock of long meadow grass: ripe seed stalks standing up out of
 * arching blades, the outer ones shorter and more bent. Blades are spread
 * around the root by the golden angle, so the leading ones (kept longest
 * as the tussock thins with distance) are still evenly spread.
 */
export function meadowClump(blades: number, segs: number, seeds: number) {
  const list: ShootBlade[] = [];
  for (let s = 0; s < seeds; s++) {
    const a = 0.6 + s * 2.5;
    list.push({ fan: a, height: 1.3 + 0.12 * s, width: 0.5, bend: 0.25 + 0.2 * s, root: [Math.sin(a) * 0.006, Math.cos(a) * 0.006], seed: true, rank: 0 });
  }
  for (let i = 0; i < blades; i++) {
    const k = (i + 0.5) / blades;
    const a = i * 2.39996;
    const r = 0.006 + 0.05 * Math.sqrt(k);
    const jitter = Math.sin(i * 12.9898) * 0.5;
    list.push({
      fan: a,
      height: 1 - 0.42 * k + 0.12 * jitter,
      width: 0.85 + 0.3 * Math.abs(jitter),
      bend: 0.6 + 1.1 * k,
      root: [Math.sin(a) * r, Math.cos(a) * r],
      rank: blades > 1 ? i / (blades - 1) : 0,
    });
  }
  return shootGeometry(list, segs);
}

/**
 * Three leaflets on a short stalk (clover), or, stretched and laid flat, a
 * broadleaf weed rosette. Leaflet vertices: position = (along, side,
 * leaflet index); stalk vertices: position = (across, t, -1).
 */
export function leafGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const rim: [number, number][] = [
    [0.4, -0.55],
    [0.95, -0.45],
    [0.85, 0],
    [0.95, 0.45],
    [0.4, 0.55],
  ];
  for (let l = 0; l < 3; l++) {
    const base = pos.length / 3;
    pos.push(0.02, 0, l);
    for (const [a, s] of rim) pos.push(a, s, l);
    for (let k = 0; k < rim.length - 1; k++) idx.push(base, base + k + 2, base + k + 1);
  }
  const s = pos.length / 3;
  pos.push(-1, 0, -1, 1, 0, -1, -1, 1, -1, 1, 1, -1);
  idx.push(s, s + 1, s + 2, s + 1, s + 3, s + 2);
  return template(pos, idx);
}

/**
 * A flower on a stem: the stem is a two-segment strip (position = (across,
 * t, -1)); the head is a star of `petals` rounded petals around a centre
 * (position = (dirX, dirY, 0 centre | 1 petal tip | 2 notch between petals)).
 */
export function flowerGeometry(petals: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= 2; i++) pos.push(-1, i / 2, -1, 1, i / 2, -1);
  idx.push(0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4);
  const c = pos.length / 3;
  pos.push(0, 0, 0);
  const n = petals * 2;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    pos.push(Math.cos(a), Math.sin(a), k % 2 === 0 ? 1 : 2);
  }
  for (let k = 0; k < n; k++) idx.push(c, c + 1 + ((k + 1) % n), c + 1 + k);
  return template(pos, idx);
}
