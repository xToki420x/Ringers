import * as THREE from 'three';
import type { Quality } from './textures';
import type { TreeSpecies } from './trees';

/**
 * Procedural tree skeletons. Each species grows by recursive branching:
 * tapered limbs that wander as they grow (curvature), turn up toward the
 * light or sag under their own weight (gravitropism) and are pruned to the
 * species' crown envelope, with leaf or needle sprays on the outermost
 * twigs. The result is plain data (polylines and clusters) that treeMesh.ts
 * turns into geometry, so it can be built and checked without a GPU.
 */

export interface BranchNode {
  p: THREE.Vector3;
  r: number;
  /** How far this point swings with its limb in the wind (0 on the trunk). */
  bend: number;
}

export interface Branch {
  level: number;
  nodes: BranchNode[];
  /** Wind phase, shared by a limb and everything growing from it. */
  phase: number;
  /** Root flare and buttress strength (trunks only). */
  flare: number;
  /** A fine leaf-bearing shoot (meshed coarsely, or left to the painted sprays). */
  twig: boolean;
}

export interface LeafCluster {
  /** Where the spray attaches to its twig. */
  p: THREE.Vector3;
  /** Unit direction the spray grows. */
  dir: THREE.Vector3;
  size: number;
  bend: number;
  phase: number;
}

/** Overall crown volume, used for soft foliage normals and interior darkening. */
export type CrownShape =
  | { kind: 'ellipsoid'; centre: THREE.Vector3; radii: THREE.Vector3 }
  | { kind: 'cone'; base: number; top: number; radius: number };

export interface TreeSkeleton {
  species: TreeSpecies;
  branches: Branch[];
  clusters: LeafCluster[];
  height: number;
  crown: CrownShape;
}

/** Distinct shapes grown per species; each tree picks one by its seed. */
export const VARIANTS = 3;

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit vector perpendicular to unit `d`. */
export function perpendicular(d: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? UP : X_AXIS).normalize();
}

/** Turn `parent` by `angle` away from itself, toward the side picked by `roll`. */
function spread(parent: THREE.Vector3, roll: number, angle: number): THREE.Vector3 {
  const u = perpendicular(parent);
  const w = new THREE.Vector3().crossVectors(parent, u);
  const side = u.multiplyScalar(Math.cos(roll)).addScaledVector(w, Math.sin(roll));
  return parent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle)).normalize();
}

/** Point, direction, radius and wind bend at arc fraction `t` along a branch. */
function along(b: Branch, t: number) {
  const n = b.nodes;
  let total = 0;
  for (let i = 1; i < n.length; i++) total += n[i].p.distanceTo(n[i - 1].p);
  let left = t * total;
  for (let i = 1; i < n.length; i++) {
    const a = n[i - 1], c = n[i];
    const len = a.p.distanceTo(c.p);
    if (left <= len || i === n.length - 1) {
      const f = Math.min(1, Math.max(0, left / len));
      return {
        p: a.p.clone().lerp(c.p, f),
        dir: c.p.clone().sub(a.p).normalize(),
        r: a.r + (c.r - a.r) * f,
        bend: a.bend + (c.bend - a.bend) * f,
      };
    }
    left -= len;
  }
  throw new Error('branch has no segments');
}

/** Furthest distance along a ray (from inside) before it leaves an ellipsoid. */
function reachInEllipsoid(from: THREE.Vector3, dir: THREE.Vector3, c: THREE.Vector3, r: THREE.Vector3): number {
  const qx = (from.x - c.x) / r.x, qy = (from.y - c.y) / r.y, qz = (from.z - c.z) / r.z;
  const kx = dir.x / r.x, ky = dir.y / r.y, kz = dir.z / r.z;
  const A = kx * kx + ky * ky + kz * kz;
  const B = 2 * (qx * kx + qy * ky + qz * kz);
  const C = qx * qx + qy * qy + qz * qz - 1;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return 0;
  return Math.max(0, (-B + Math.sqrt(disc)) / (2 * A));
}

interface GrowSpec {
  from: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
  r0: number;
  r1: number;
  segs: number;
  level: number;
  /** Random wander of the growth direction per segment. */
  curve: number;
  /** Change of the direction's vertical component per metre grown (+ up, − sag), by position 0..1. */
  tropism: (s: number) => number;
  bend0: number;
  /** Wind bend gained from base to tip. */
  flex: number;
  phase: number;
  flare?: number;
  twig?: boolean;
  /** Radius profile exponent (below 1 keeps the base thick for longer). */
  taper?: number;
}

class Grower {
  readonly branches: Branch[] = [];
  readonly clusters: LeafCluster[] = [];
  constructor(readonly rnd: () => number) {}

  range(a: number, b: number) {
    return a + (b - a) * this.rnd();
  }

  grow(g: GrowSpec): Branch {
    const nodes: BranchNode[] = [{ p: g.from.clone(), r: g.r0, bend: g.bend0 }];
    const d = g.dir.clone().normalize();
    const prev = d.clone();
    const p = g.from.clone();
    const step = Math.max(0.02, g.length / g.segs);
    for (let i = 1; i <= g.segs; i++) {
      const s = i / g.segs;
      d.x += (this.rnd() - 0.5) * 2 * g.curve;
      d.y += (this.rnd() - 0.5) * g.curve + g.tropism(s) * step;
      d.z += (this.rnd() - 0.5) * 2 * g.curve;
      // Nothing grows down into the lawn.
      if (p.y < 1.2 && d.y < 0) d.y *= 0.2;
      if (d.lengthSq() < 1e-6) d.copy(prev);
      d.normalize();
      prev.copy(d);
      p.addScaledVector(d, step);
      const r = g.r1 + (g.r0 - g.r1) * Math.pow(1 - s, g.taper ?? 1);
      nodes.push({ p: p.clone(), r, bend: g.bend0 + g.flex * Math.pow(s, 1.5) });
    }
    const b: Branch = { level: g.level, nodes, phase: g.phase, flare: g.flare ?? 0, twig: g.twig ?? false };
    this.branches.push(b);
    return b;
  }

  /** A spray at arc fraction `t` of a twig, aimed out of the crown. */
  spray(b: Branch, t: number, size: number, centre: THREE.Vector3, outward: number, lift: number) {
    const at = along(b, t);
    const out = at.p.clone().sub(centre);
    out.y *= 0.4;
    if (out.lengthSq() < 1e-6) out.copy(at.dir);
    out.normalize();
    const dir = at.dir
      .clone()
      .multiplyScalar(0.6)
      .addScaledVector(out, outward)
      .add(new THREE.Vector3((this.rnd() - 0.5) * 0.5, lift + (this.rnd() - 0.5) * 0.3, (this.rnd() - 0.5) * 0.5));
    if (dir.lengthSq() < 1e-6) dir.copy(UP);
    this.clusters.push({ p: at.p, dir: dir.normalize(), size, bend: at.bend, phase: b.phase });
  }
}

/** Branch and leaf density for a quality tier (1 on high). */
const detail = (q: Quality) => (q === 'high' ? 1 : q === 'medium' ? 0.72 : 0.45);

export function growTree(species: TreeSpecies, variant: number, q: Quality): TreeSkeleton {
  const g = new Grower(rng(101 + variant * 7919 + species.length * 104729 + species.charCodeAt(0) * 31));
  switch (species) {
    case 'oak':
      return broadleaf(g, OAK, species, variant, q);
    case 'maple':
      return broadleaf(g, MAPLE, species, variant, q);
    case 'birch':
      return birch(g, variant, q);
    case 'pine':
      return pine(g, variant, q);
  }
}

interface BroadleafSpec {
  /** Crown envelope (centre y and radii, metres). */
  crownY: number;
  crownR: [number, number];
  trunkLength: [number, number];
  trunkR: number;
  flare: number;
  limbs: number[];
  limbAt: [number, number];
  limbAngle: [number, number];
  limbLength: [number, number];
  limbCurve: number;
  limbTropism: (s: number) => number;
  branches: number;
  branchAngle: [number, number];
  twigs: number;
  twigLength: [number, number];
  sprays: number;
  spraySize: [number, number];
}

/** Oak: short massive trunk, heavy sinuous limbs spreading wide into a broad crown. */
const OAK: BroadleafSpec = {
  crownY: 5.1,
  crownR: [4.7, 3.2],
  trunkLength: [2.9, 3.4],
  trunkR: 0.36,
  flare: 0.6,
  limbs: [4, 5, 4],
  limbAt: [0.62, 1],
  limbAngle: [0.75, 1.15],
  limbLength: [3.8, 4.8],
  limbCurve: 0.2,
  limbTropism: (s) => -0.06 + 0.2 * s,
  branches: 6,
  branchAngle: [0.5, 0.95],
  twigs: 4,
  twigLength: [0.7, 1.15],
  sprays: 3,
  spraySize: [1.2, 1.55],
};

/** Maple: taller trunk, more upright limbs, a dense rounded crown. */
const MAPLE: BroadleafSpec = {
  crownY: 5.2,
  crownR: [3.6, 3.3],
  trunkLength: [2.4, 2.9],
  trunkR: 0.28,
  flare: 0.42,
  limbs: [5, 6, 5],
  limbAt: [0.7, 1],
  limbAngle: [0.4, 0.75],
  limbLength: [3.4, 4.3],
  limbCurve: 0.12,
  limbTropism: () => 0.12,
  branches: 6,
  branchAngle: [0.5, 0.85],
  twigs: 4,
  twigLength: [0.6, 1.0],
  sprays: 3,
  spraySize: [1.1, 1.4],
};

function broadleaf(g: Grower, s: BroadleafSpec, species: TreeSpecies, variant: number, q: Quality): TreeSkeleton {
  const k = detail(q);
  const centre = new THREE.Vector3(g.range(-0.3, 0.3), s.crownY + g.range(-0.2, 0.2), g.range(-0.3, 0.3));
  const radii = new THREE.Vector3(s.crownR[0] * g.range(0.92, 1.08), s.crownR[1] * g.range(0.94, 1.06), s.crownR[0] * g.range(0.92, 1.08));
  const lean = spread(UP, g.range(0, Math.PI * 2), g.range(0.02, 0.07));
  const trunk = g.grow({
    from: new THREE.Vector3(0, -0.25, 0),
    dir: lean,
    length: g.range(...s.trunkLength),
    r0: s.trunkR,
    r1: s.trunkR * 0.62,
    segs: 5,
    level: 0,
    curve: 0.05,
    tropism: () => 0.04,
    bend0: 0,
    flex: 0,
    phase: 0,
    flare: s.flare,
    taper: 0.8,
  });
  const nLimbs = s.limbs[variant % s.limbs.length];
  const roll0 = g.range(0, Math.PI * 2);
  // The leader carries on up the middle; the other limbs fan out around it.
  for (let i = 0; i <= nLimbs; i++) {
    const leader = i === nLimbs;
    const t = leader ? 1 : g.range(...s.limbAt);
    const at = along(trunk, t);
    const dir = leader
      ? spread(at.dir, g.range(0, Math.PI * 2), g.range(0.05, 0.2))
      : spread(UP, roll0 + (i / nLimbs) * Math.PI * 2 + g.range(-0.35, 0.35), g.range(...s.limbAngle));
    const length = Math.min(g.range(...s.limbLength) * (leader ? 0.85 : 1), reachInEllipsoid(at.p, dir, centre, radii) * 0.92);
    if (length < 0.8) continue;
    const limb = g.grow({
      from: at.p,
      dir,
      length,
      r0: at.r * (leader ? 0.75 : g.range(0.55, 0.7)),
      r1: 0.035,
      segs: 6,
      level: 1,
      curve: s.limbCurve,
      tropism: leader ? () => 0.15 : s.limbTropism,
      bend0: 0,
      flex: leader ? 0.25 : 0.35,
      phase: g.range(0, Math.PI * 2),
      taper: 0.85,
    });
    const nBranch = Math.max(3, Math.round(s.branches * (0.6 + 0.4 * k)));
    for (let j = 0; j < nBranch; j++) {
      const tb = 0.22 + (0.74 * (j + g.rnd() * 0.6)) / nBranch;
      const ab = along(limb, tb);
      const bdir = spread(ab.dir, j * GOLDEN * 2 + g.range(-0.4, 0.4), g.range(...s.branchAngle));
      bdir.y += 0.2;
      bdir.normalize();
      const blen = Math.min(length * g.range(0.38, 0.58) * (1.15 - 0.5 * tb), reachInEllipsoid(ab.p, bdir, centre, radii) * 0.95);
      if (blen < 0.45) continue;
      const branch = g.grow({
        from: ab.p,
        dir: bdir,
        length: blen,
        r0: Math.max(0.014, ab.r * 0.6),
        r1: 0.01,
        segs: 3,
        level: 2,
        curve: 0.22,
        tropism: () => 0.12,
        bend0: ab.bend,
        flex: 0.3,
        phase: limb.phase,
      });
      if (q === 'low') {
        // No twigs on low: larger sprays straight on the branches.
        for (let m = 0; m < 3; m++) g.spray(branch, 0.45 + m * 0.27, g.range(...s.spraySize) * 1.35, centre, 0.6, 0.25);
        continue;
      }
      const nTwig = Math.max(2, Math.round(s.twigs * k));
      for (let m = 0; m < nTwig; m++) {
        const tt = 0.35 + (0.65 * (m + g.rnd() * 0.7)) / nTwig;
        const at2 = along(branch, tt);
        const tdir = spread(at2.dir, m * GOLDEN * 2 + g.range(-0.5, 0.5), g.range(0.45, 0.85));
        tdir.y += 0.15;
        tdir.normalize();
        const tlen = Math.min(g.range(...s.twigLength), Math.max(0.3, reachInEllipsoid(at2.p, tdir, centre, radii) * 1.05));
        const twig = g.grow({
          from: at2.p,
          dir: tdir,
          length: tlen,
          r0: Math.max(0.008, at2.r * 0.6),
          r1: 0.005,
          segs: 2,
          level: 3,
          twig: true,
          curve: 0.2,
          tropism: () => 0.15,
          bend0: at2.bend,
          flex: 0.25,
          phase: limb.phase,
        });
        const nSpray = Math.max(1, Math.round(s.sprays * (0.55 + 0.45 * k)));
        for (let n = 0; n < nSpray; n++) g.spray(twig, 0.5 + (0.5 * (n + 1)) / nSpray, g.range(...s.spraySize) / Math.sqrt(0.55 + 0.45 * k), centre, 0.6, 0.25);
      }
    }
  }
  return finish(g, species, { kind: 'ellipsoid', centre, radii });
}

/** Birch: one to three slender leaning stems, ascending branches with weeping twigs, an airy crown. */
function birch(g: Grower, variant: number, q: Quality): TreeSkeleton {
  const k = detail(q);
  const stems = variant + 1;
  const centre = new THREE.Vector3(0, 5.7, 0);
  const radii = new THREE.Vector3(2.5 + stems * 0.35, 3.7, 2.5 + stems * 0.35);
  const roll0 = g.range(0, Math.PI * 2);
  for (let st = 0; st < stems; st++) {
    const a = roll0 + (st / stems) * Math.PI * 2 + g.range(-0.3, 0.3);
    const off = stems > 1 ? 0.13 : 0;
    const from = new THREE.Vector3(Math.cos(a) * off, -0.25, Math.sin(a) * off);
    const dir = spread(UP, a, stems > 1 ? g.range(0.08, 0.17) : g.range(0.02, 0.06));
    const height = g.range(8.4, 9.6) - st * 0.6;
    const r0 = stems > 1 ? 0.105 : 0.14;
    const stem = g.grow({
      from,
      dir,
      length: height,
      r0,
      r1: 0.012,
      segs: 9,
      level: 0,
      curve: 0.035,
      tropism: () => 0.025,
      bend0: 0,
      flex: 0,
      phase: 0,
      flare: stems > 1 ? 0.3 : 0.4,
      taper: 0.9,
    });
    const nBranch = Math.round((stems > 1 ? 12 : 17) * (0.55 + 0.45 * k));
    for (let j = 0; j < nBranch; j++) {
      const t = 0.3 + (0.66 * (j + g.rnd() * 0.8)) / nBranch;
      const at = along(stem, t);
      const bdir = spread(at.dir, a + j * GOLDEN + g.range(-0.3, 0.3), g.range(0.6, 0.95));
      const length = (2.8 * Math.pow(1 - t, 0.55) + 0.45) * g.range(0.75, 1.1);
      const branch = g.grow({
        from: at.p,
        dir: bdir,
        length,
        r0: Math.max(0.012, at.r * 0.42),
        r1: 0.005,
        segs: 4,
        level: 1,
        curve: 0.16,
        tropism: (s) => 0.1 - 0.75 * s,
        bend0: 0,
        flex: 0.75,
        phase: g.range(0, Math.PI * 2),
      });
      const nTwig = q === 'low' ? 0 : Math.max(2, Math.round(3 * k + 0.4));
      for (let m = 0; m < nTwig; m++) {
        const tt = 0.4 + (0.6 * (m + g.rnd() * 0.6)) / nTwig;
        const at2 = along(branch, tt);
        const twig = g.grow({
          from: at2.p,
          dir: spread(at2.dir, m * 2.4 + g.range(-0.6, 0.6), g.range(0.4, 0.8)),
          length: g.range(0.7, 1.25),
          r0: 0.006,
          r1: 0.003,
          segs: 3,
          level: 2,
          twig: true,
          curve: 0.15,
          tropism: () => -1.1,
          bend0: at2.bend,
          flex: 0.35,
          phase: branch.phase,
        });
        for (let n = 0; n < 3; n++) g.spray(twig, 0.35 + n * 0.32, g.range(0.62, 0.85) / Math.sqrt(0.55 + 0.45 * k), centre, 0.3, -0.25);
      }
      if (q === 'low') for (let n = 0; n < 4; n++) g.spray(branch, 0.35 + n * 0.21, g.range(0.95, 1.25), centre, 0.35, -0.2);
      else g.spray(branch, 1, g.range(0.6, 0.8), centre, 0.3, -0.1);
    }
  }
  return finish(g, 'birch', { kind: 'ellipsoid', centre, radii });
}

/** Pine: a tall straight trunk, bare below, then whorls of drooping branches in a narrowing cone. */
function pine(g: Grower, variant: number, q: Quality): TreeSkeleton {
  const k = detail(q);
  const height = [11.2, 10.4, 12.2][variant % 3] * g.range(0.97, 1.03);
  const base = height * g.range(0.3, 0.36);
  const radius = g.range(2.7, 3.2);
  const trunk = g.grow({
    from: new THREE.Vector3(0, -0.25, 0),
    dir: spread(UP, g.range(0, Math.PI * 2), g.range(0.01, 0.035)),
    length: height,
    r0: 0.3,
    r1: 0.02,
    segs: 14,
    level: 0,
    curve: 0.018,
    tropism: () => 0.03,
    bend0: 0,
    flex: 0,
    phase: 0,
    flare: 0.38,
    taper: 0.95,
  });
  // Dead stubs where the lowest whorls self-pruned.
  for (let i = 0; i < 6; i++) {
    const at = along(trunk, g.range(1.2, base - 0.4) / height);
    g.grow({
      from: at.p,
      dir: spread(at.dir, g.range(0, Math.PI * 2), g.range(1.45, 1.8)),
      length: g.range(0.18, 0.5),
      r0: Math.max(0.016, at.r * 0.14),
      r1: 0.008,
      segs: 1,
      level: 1,
      curve: 0.05,
      tropism: () => 0,
      bend0: 0,
      flex: 0.1,
      phase: g.range(0, Math.PI * 2),
    });
  }
  const spacing = q === 'high' ? 0.58 : q === 'medium' ? 0.72 : 0.92;
  const perWhorl = q === 'low' ? 4 : 5;
  let whorlRoll = g.range(0, Math.PI * 2);
  for (let y = base; y < height - 0.45; y += spacing * g.range(0.85, 1.15)) {
    const h = (y - base) / (height - base);
    const at = along(trunk, y / height);
    whorlRoll += g.range(0.5, 1.4);
    for (let i = 0; i < perWhorl; i++) {
      if (g.rnd() < 0.1) continue;
      const dir = spread(UP, whorlRoll + (i / perWhorl) * Math.PI * 2 + g.range(-0.3, 0.3), 1.72 - 0.62 * h + g.range(-0.1, 0.1));
      const length = (radius * Math.pow(1 - h, 0.9) * g.range(0.8, 1.08) + 0.3) * (h < 0.08 ? 0.85 : 1);
      const droop = 0.35 * (1 - h);
      const branch = g.grow({
        from: at.p,
        dir,
        length,
        r0: Math.max(0.016, at.r * 0.32),
        r1: 0.007,
        segs: 3,
        level: 1,
        curve: 0.1,
        tropism: (s) => -droop + (0.4 + droop) * s * s,
        bend0: 0,
        flex: 0.45 + 0.3 * (1 - h),
        phase: g.range(0, Math.PI * 2),
      });
      const size = (0.82 + 0.25 * (1 - h)) * g.range(0.9, 1.1) / Math.sqrt(0.6 + 0.4 * k);
      const n = Math.max(1, Math.round((length / 0.62) * (0.6 + 0.4 * k)));
      for (let m = 0; m < n; m++) {
        const t = 0.32 + (0.68 * (m + 1)) / n;
        const a = along(branch, t);
        g.clusters.push({ p: a.p, dir: a.dir, size: size * (0.8 + 0.2 * t), bend: a.bend, phase: branch.phase });
      }
      // Side shoots fill out the pad (needles only, too fine for wood).
      const shoots = length > 1 ? Math.round(3 * k) : 0;
      for (let m = 0; m < shoots; m++) {
        const t = g.range(0.35, 0.85);
        const a = along(branch, t);
        const side = new THREE.Vector3().crossVectors(UP, a.dir);
        if (side.lengthSq() < 1e-6) continue;
        side.normalize().multiplyScalar(m % 2 ? 1 : -1);
        const sdir = a.dir.clone().multiplyScalar(0.55).add(side).normalize();
        const p = a.p.clone().addScaledVector(sdir, length * 0.16);
        g.clusters.push({ p, dir: sdir, size: size * 0.8, bend: a.bend + 0.1, phase: branch.phase });
      }
    }
  }
  // The leader: a narrow tuft at the very top.
  for (let i = 0; i < 4; i++) {
    const at = along(trunk, 1 - i * 0.045);
    const dir = i === 0 ? at.dir.clone() : spread(at.dir, i * 2.1 + g.range(-0.3, 0.3), 0.5);
    g.clusters.push({ p: at.p.clone().addScaledVector(dir, -0.2), dir, size: 0.75 - i * 0.05, bend: 0.25, phase: 0 });
  }
  return finish(g, 'pine', { kind: 'cone', base, top: height, radius: radius + 0.4 });
}

function finish(g: Grower, species: TreeSpecies, crown: CrownShape): TreeSkeleton {
  let height = 0;
  for (const b of g.branches) for (const n of b.nodes) height = Math.max(height, n.p.y);
  for (const c of g.clusters) height = Math.max(height, c.p.y + c.dir.y * c.size);
  return { species, branches: g.branches, clusters: g.clusters, height, crown };
}
