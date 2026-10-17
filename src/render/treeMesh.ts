import * as THREE from 'three';
import type { Quality } from './textures';
import type { TreeSpecies } from './trees';
import { perpendicular, rng, type Branch, type CrownShape, type LeafCluster, type TreeSkeleton } from './treeGrowth';

/**
 * Geometry for one grown tree: bark-mapped tubes for every limb (with root
 * buttresses on the trunk) and folded alpha cards for the leaf sprays. Every
 * normal is built analytically and never zero, and nothing here touches the
 * DOM, so the meshes can be validated in tests.
 *
 * Extra vertex data drives the shaders in trees.ts:
 * - `color`: ambient occlusion (darker deep in the crown and near the ground) times a bark tint;
 * - `wind`: (bend, sway phase, flutter amount, flutter phase).
 */

/** Foliage atlas layout: one column per species, one row per spray layout. */
export const LEAF_ATLAS = { cols: 4, rows: 2 } as const;
export const SPECIES_COLUMN: Record<TreeSpecies, number> = { oak: 0, maple: 1, birch: 2, pine: 3 };

export interface TreeGeometry {
  wood: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
  /** Radius of the crown's footprint (metres at scale 1), for its contact shadow. */
  spread: number;
}

const UP = new THREE.Vector3(0, 1, 0);

class MeshData {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly wind: number[] = [];
  readonly idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: THREE.Color, wind: [number, number, number, number]) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c.r, c.g, c.b);
    this.wind.push(...wind);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('wind', new THREE.Float32BufferAttribute(this.wind, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function crownSpan(c: CrownShape): [number, number] {
  return c.kind === 'ellipsoid' ? [c.centre.y - c.radii.y, c.centre.y + c.radii.y] : [c.base, c.top];
}

/** Outward direction of the crown's surface nearest `p` (unit, never zero). */
function crownNormal(c: CrownShape, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (c.kind === 'ellipsoid') {
    out.set((p.x - c.centre.x) / c.radii.x ** 2, (p.y - c.centre.y) / c.radii.y ** 2, (p.z - c.centre.z) / c.radii.z ** 2);
    if (out.lengthSq() < 1e-8) return out.copy(UP);
    // A little upward bias keeps the crown's top bright and its underside soft.
    return out.normalize().addScaledVector(UP, 0.3).normalize();
  }
  const h = Math.hypot(p.x, p.z);
  if (h < 1e-4) return out.copy(UP);
  const tall = c.top - c.base;
  const k = 1 / Math.hypot(tall, c.radius);
  return out.set((p.x / h) * tall * k, c.radius * k, (p.z / h) * tall * k);
}

/** How far out from the crown's core `p` sits: 0 at the centre or axis, 1 on the surface. */
function crownDepth(c: CrownShape, p: THREE.Vector3): number {
  if (c.kind === 'ellipsoid') {
    const dx = (p.x - c.centre.x) / c.radii.x, dy = (p.y - c.centre.y) / c.radii.y, dz = (p.z - c.centre.z) / c.radii.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const r = c.radius * Math.min(1, Math.max(0, (c.top - p.y) / (c.top - c.base)));
  return Math.hypot(p.x, p.z) / Math.max(r, 0.35);
}

/** Ambient occlusion: dark deep inside the crown, under it and where wood meets the ground. */
function occlusion(c: CrownShape, p: THREE.Vector3, deep: number): number {
  const [bottom, top] = crownSpan(c);
  const d = crownDepth(c, p);
  const inner = deep + (1 - deep) * smooth(0.2, 1.05, d);
  const sky = 0.68 + 0.32 * smooth(bottom - 1, top, p.y);
  const ground = 0.55 + 0.45 * smooth(-0.05, 0.8, p.y);
  return inner * sky * ground;
}

/** Radial segments by limb thickness and quality tier. */
function radialSegments(r: number, q: Quality): number {
  const tiers = q === 'high' ? [12, 8, 5, 3] : q === 'medium' ? [9, 6, 4, 3] : [7, 5, 3, 3];
  return r >= 0.2 ? tiers[0] : r >= 0.07 ? tiers[1] : r >= (q === 'high' ? 0.035 : 0.05) ? tiers[2] : tiers[3];
}

/** Arc-length positions of the rings along a branch. */
function stations(b: Branch, lengths: number[], q: Quality): number[] {
  const total = lengths[lengths.length - 1];
  const r0 = b.nodes[0].r;
  const s: number[] = [];
  if (b.twig) {
    // A ring at each end is plenty for a twig.
    s.push(0, total);
  } else {
    // Trunks get a ring between every node; limbs are smooth enough without.
    const split = r0 >= 0.2 && q === 'high' ? 2 : 1;
    for (let i = 0; i < lengths.length - 1; i++)
      for (let k = 0; k < split; k++) s.push(lengths[i] + ((lengths[i + 1] - lengths[i]) * k) / split);
    s.push(total);
    // Dense rings where the root flare swells.
    if (b.flare > 0) for (const extra of [0.15, 0.25, 0.33, 0.42, 0.55, 0.75, 1.0, 1.35]) if (extra < total) s.push(extra);
  }
  s.sort((a, c) => a - c);
  const out = [s[0]];
  for (const x of s) if (x - out[out.length - 1] > 0.04) out.push(x);
  if (total - out[out.length - 1] > 1e-6) out[out.length - 1] = total;
  return out;
}

/** Catmull-Rom point on a branch polyline at arc length `s`. */
function curvePoint(b: Branch, lengths: number[], s: number, out: THREE.Vector3) {
  const n = b.nodes;
  let i = 0;
  while (i < n.length - 2 && lengths[i + 1] < s) i++;
  const t = Math.min(1, Math.max(0, (s - lengths[i]) / (lengths[i + 1] - lengths[i])));
  const p1 = n[i].p, p2 = n[i + 1].p;
  const p0 = i > 0 ? n[i - 1].p : p1.clone().multiplyScalar(2).sub(p2);
  const p3 = i + 2 < n.length ? n[i + 2].p : p2.clone().multiplyScalar(2).sub(p1);
  const t2 = t * t, t3 = t2 * t;
  const a = -0.5 * t3 + t2 - 0.5 * t, bb = 1.5 * t3 - 2.5 * t2 + 1, c = -1.5 * t3 + 2 * t2 + 0.5 * t, d = 0.5 * t3 - 0.5 * t2;
  out.set(0, 0, 0).addScaledVector(p0, a).addScaledVector(p1, bb).addScaledVector(p2, c).addScaledVector(p3, d);
  return { r: n[i].r + (n[i + 1].r - n[i].r) * t, bend: n[i].bend + (n[i + 1].bend - n[i].bend) * t };
}

/** Bark colour multiplier: birch limbs darken away from the white stems, pine trunks turn orange up high. */
function barkTint(species: TreeSpecies, b: Branch, p: THREE.Vector3, height: number, out: THREE.Color): THREE.Color {
  switch (species) {
    case 'birch':
      if (b.level > 0) return out.setRGB(0.36, 0.3, 0.27);
      // Dark, rough bark at the foot of each stem.
      return out.setRGB(1, 1, 1).lerp(new THREE.Color(0.3, 0.27, 0.25), 1 - smooth(0.05, 0.9, p.y));
    case 'pine':
      if (b.level > 0) return out.setRGB(0.95, 0.85, 0.78);
      return out.setRGB(0.82, 0.8, 0.8).lerp(new THREE.Color(1.3, 1.02, 0.8), smooth(height * 0.35, height * 0.75, p.y));
    default:
      return out.setRGB(1, 1, 1);
  }
}

function addBranch(m: MeshData, b: Branch, sk: TreeSkeleton, q: Quality) {
  const n = b.nodes;
  const lengths = [0];
  for (let i = 1; i < n.length; i++) lengths.push(lengths[i - 1] + n[i].p.distanceTo(n[i - 1].p));
  const ss = stations(b, lengths, q);
  const radial = b.twig ? 3 : radialSegments(n[0].r, q);
  const ring = ss.map((s) => {
    const p = new THREE.Vector3();
    const { r, bend } = curvePoint(b, lengths, s, p);
    return { s, p, r, bend, t: new THREE.Vector3(), nx: new THREE.Vector3(), bx: new THREE.Vector3() };
  });
  // Tangents and parallel-transported frames (no twisting between rings).
  for (let k = 0; k < ring.length; k++) {
    const a = ring[Math.max(0, k - 1)].p, c = ring[Math.min(ring.length - 1, k + 1)].p;
    ring[k].t.subVectors(c, a);
    if (ring[k].t.lengthSq() < 1e-12) ring[k].t.copy(k > 0 ? ring[k - 1].t : UP);
    ring[k].t.normalize();
    const nx = k === 0 ? perpendicular(ring[0].t) : ring[k - 1].nx.clone();
    nx.addScaledVector(ring[k].t, -nx.dot(ring[k].t));
    ring[k].nx.copy(nx.lengthSq() < 1e-8 ? perpendicular(ring[k].t) : nx.normalize());
    ring[k].bx.crossVectors(ring[k].t, ring[k].nx);
  }
  // Root flare: buttresses swelling into the ground.
  const buttress = 4 + (b.nodes.length % 3);
  const twist = b.phase + n[0].p.x * 13.1;
  const radiusAt = (k: number, theta: number) => {
    const { r, p } = ring[k];
    if (b.flare <= 0) return r;
    const swell = Math.exp(-Math.max(0, p.y) / 0.42);
    const ridge = Math.pow(0.5 + 0.5 * Math.cos(buttress * theta + twist), 2.2);
    return r * (1 + b.flare * swell * (0.35 + 0.9 * ridge) + 0.03 * Math.sin(3 * theta + twist));
  };
  const circumference = 2 * Math.PI * n[0].r;
  const base = m.count;
  const pos = new THREE.Vector3(), nrm = new THREE.Vector3(), radialDir = new THREE.Vector3(), side = new THREE.Vector3();
  const tint = new THREE.Color(), col = new THREE.Color();
  for (let k = 0; k < ring.length; k++) {
    const R = ring[k];
    const prev = Math.max(0, k - 1), next = Math.min(ring.length - 1, k + 1);
    const ds = Math.max(1e-4, ring[next].s - ring[prev].s);
    barkTint(sk.species, b, R.p, sk.height, tint);
    for (let j = 0; j <= radial; j++) {
      const theta = (j / radial) * Math.PI * 2;
      const cs = Math.cos(theta), sn = Math.sin(theta);
      radialDir.copy(R.nx).multiplyScalar(cs).addScaledVector(R.bx, sn);
      side.copy(R.nx).multiplyScalar(-sn).addScaledVector(R.bx, cs);
      const r = radiusAt(k, theta);
      const slope = (radiusAt(next, theta) - radiusAt(prev, theta)) / ds;
      const dTheta = (radiusAt(k, theta + 0.01) - radiusAt(k, theta - 0.01)) / 0.02;
      // Lean the normal back where the limb tapers or flares, and sideways across buttress ridges.
      nrm.copy(radialDir).addScaledVector(R.t, -slope).addScaledVector(side, -dTheta / r).normalize();
      pos.copy(R.p).addScaledVector(radialDir, r);
      const ao = occlusion(sk.crown, pos, 0.55);
      col.copy(tint).multiplyScalar(ao);
      m.vertex(pos, nrm, j / radial, R.s / (2 * circumference), col, [R.bend, b.phase, 0, 0]);
    }
  }
  const stride = radial + 1;
  for (let k = 0; k < ring.length - 1; k++)
    for (let j = 0; j < radial; j++) {
      const a = base + k * stride + j, c = a + stride;
      m.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  // Close thick ends with a short rounded cap.
  const end = ring[ring.length - 1];
  if (end.r > 0.012) {
    const tip = m.count;
    col.copy(barkTint(sk.species, b, end.p, sk.height, tint)).multiplyScalar(occlusion(sk.crown, end.p, 0.55));
    m.vertex(pos.copy(end.p).addScaledVector(end.t, end.r * 0.7), end.t, 0.5, end.s / (2 * circumference), col, [end.bend, b.phase, 0, 0]);
    const last = base + (ring.length - 1) * stride;
    for (let j = 0; j < radial; j++) m.idx.push(last + j, last + j + 1, tip);
  }
}

/** Card fold (radians either side of the spray's spine) by species. */
const FOLD: Record<TreeSpecies, number> = { oak: 0.5, maple: 0.45, birch: 0.4, pine: 0.3 };

/**
 * One leaf spray: a card folded along its twig (so it keeps some width seen
 * from any side), facing up to the light or out of the crown. Pine shoots
 * are bottle-brushes, so they get a second card crossed at right angles.
 */
function addSpray(m: MeshData, c: LeafCluster, sk: TreeSkeleton, rnd: () => number) {
  const out = crownNormal(sk.crown, c.p, new THREE.Vector3());
  const jitter = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
  const face =
    sk.species === 'pine'
      ? UP.clone().addScaledVector(jitter, 0.4)
      : sk.species === 'birch'
        ? out.clone().multiplyScalar(0.8).addScaledVector(UP, 0.4).addScaledVector(jitter, 0.9)
        : out.clone().multiplyScalar(0.7).addScaledVector(UP, 0.7).addScaledVector(jitter, 0.8);
  face.addScaledVector(c.dir, -face.dot(c.dir));
  if (face.lengthSq() < 1e-4) face.copy(perpendicular(c.dir));
  face.normalize();
  addCard(m, c, sk, out, face, rnd);
  if (sk.species === 'pine') addCard(m, c, sk, out, new THREE.Vector3().crossVectors(c.dir, face).normalize(), rnd);
}

/** A card along the spray's direction, folded toward `face` (unit, perpendicular to the direction). */
function addCard(m: MeshData, c: LeafCluster, sk: TreeSkeleton, out: THREE.Vector3, face: THREE.Vector3, rnd: () => number) {
  const dir = c.dir;
  const across = new THREE.Vector3().crossVectors(dir, face).normalize();
  const fold = FOLD[sk.species];
  const s = c.size;
  const half = s * 0.5;
  const left = across.clone().multiplyScalar(-Math.cos(fold) * half).addScaledVector(face, Math.sin(fold) * half);
  const right = across.clone().multiplyScalar(Math.cos(fold) * half).addScaledVector(face, Math.sin(fold) * half);
  const base = c.p.clone().addScaledVector(dir, -0.08 * s);
  const tip = base.clone().addScaledVector(dir, s);
  // Atlas cell: this species' column, a random spray layout, sometimes mirrored.
  const row = Math.floor(rnd() * LEAF_ATLAS.rows);
  const col = SPECIES_COLUMN[sk.species];
  let u0 = col / LEAF_ATLAS.cols, u1 = (col + 1) / LEAF_ATLAS.cols;
  if (rnd() < 0.5) [u0, u1] = [u1, u0];
  const vBase = (row + 0.97) / LEAF_ATLAS.rows, vTip = row / LEAF_ATLAS.rows;
  // Per-spray colour jitter (a few sprays catch more sun or are a touch yellower).
  const bright = 0.9 + rnd() * 0.2, warm = (rnd() - 0.5) * 0.12;
  const flutterPhase = rnd() * Math.PI * 2;
  const panel = (edge: THREE.Vector3) => {
    const nrm = new THREE.Vector3().crossVectors(dir, edge).normalize();
    return nrm.dot(out) < 0 ? nrm.negate() : nrm;
  };
  const nLeft = panel(left), nRight = panel(right);
  const nMid = nLeft.clone().add(nRight).normalize();
  const p = new THREE.Vector3(), n = new THREE.Vector3(), cn = new THREE.Vector3(), colour = new THREE.Color();
  const corner = (along: number, edge: THREE.Vector3 | null, panelN: THREE.Vector3, u: number) => {
    p.copy(along ? tip : base);
    if (edge) p.add(edge);
    // Mostly the crown's normal, so the whole crown shades as one soft volume.
    n.copy(panelN).multiplyScalar(0.25).addScaledVector(crownNormal(sk.crown, p, cn), 0.75).normalize();
    const ao = occlusion(sk.crown, p, 0.38) * bright;
    colour.setRGB(ao * (1 + warm), ao, ao * (1 - warm));
    const reach = (along ? 0.85 : 0.1) + (edge ? 0.35 : 0);
    m.vertex(p, n, u, along ? vTip : vBase, colour, [c.bend + 0.12 * along, c.phase, reach, flutterPhase]);
  };
  const i = m.count;
  const uMid = (u0 + u1) / 2;
  corner(0, left, nLeft, u0);
  corner(0, null, nMid, uMid);
  corner(0, right, nRight, u1);
  corner(1, left, nLeft, u0);
  corner(1, null, nMid, uMid);
  corner(1, right, nRight, u1);
  m.idx.push(i, i + 1, i + 4, i, i + 4, i + 3, i + 1, i + 2, i + 5, i + 1, i + 5, i + 4);
}

export function buildTreeGeometry(sk: TreeSkeleton, q: Quality, seed: number): TreeGeometry {
  const wood = new MeshData();
  // Twigs are only meshed on high; below that the sprays' painted twigs stand in for them.
  for (const b of sk.branches) if (q === 'high' || !b.twig) addBranch(wood, b, sk, q);
  const foliage = new MeshData();
  const rnd = rng(seed);
  for (const c of sk.clusters) addSpray(foliage, c, sk, rnd);
  const spread = sk.crown.kind === 'ellipsoid' ? Math.max(sk.crown.radii.x, sk.crown.radii.z) : sk.crown.radius;
  return { wood: wood.geometry(), foliage: foliage.geometry(), spread };
}
