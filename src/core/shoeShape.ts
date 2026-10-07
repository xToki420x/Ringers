import { IN } from './constants';
import { SHAPES, type ShapeId, type ShapeSpec } from './equipment';

/**
 * Shared horseshoe geometry used by physics, judging and rendering.
 *
 * Shoe local frame: +X across the shoe, +Y up (top face, calks hang below),
 * +Z points from the toe toward the open heels. The origin is the middle of
 * the bounding box at mid-thickness.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface ShoeGeometry {
  id: ShapeId;
  spec: ShapeSpec;
  a: number;
  c: number;
  thetaMax: number;
  thickness: number;
  zOffset: number;
  toeCalk: number;
  heelCalk: number;
  hook: number;
  innerLip: number;
  /** Measured outer dimensions. */
  width: number;
  length: number;
  /** Inside distance between the heel points (hooks included). */
  opening: number;
  /** Closed inner contour from heel to heel (counter-clockwise), plus the heel line. */
  innerPolygon: Vec2[];
  /** Outer contour heel to heel. */
  outerContour: Vec2[];
  /** The straightedge across both heel calks. */
  heelLine: [Vec2, Vec2];
  /** Collider boxes (in shoe local frame). */
  segments: SegmentBox[];
  /** Points on the bottom face used for sand interaction (local). */
  bottomSamples: { x: number; y: number; z: number }[];
  /** Sphere-swept collision proxy (local). */
  spheres: Sphere[];
  /** Volume-weighted points used to integrate mass properties (local). */
  massSamples: { x: number; y: number; z: number; w: number }[];
}

export interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface SegmentBox {
  cx: number;
  cy: number;
  cz: number;
  /** Rotation about local Y (radians). */
  yaw: number;
  hx: number;
  hy: number;
  hz: number;
}

const cache = new Map<ShapeId, ShoeGeometry>();

export function shoeGeometry(id: ShapeId): ShoeGeometry {
  let g = cache.get(id);
  if (!g) {
    g = buildGeometry(SHAPES[id]);
    cache.set(id, g);
  }
  return g;
}

export function bandWidth(g: Pick<ShoeGeometry, 'thetaMax' | 'spec'>, theta: number): number {
  const t = Math.min(1, Math.abs(theta) / g.thetaMax);
  return (g.spec.bandToe + (g.spec.bandHeel - g.spec.bandToe) * Math.pow(t, 1.4)) * IN;
}

/** Centerline point (local, with zOffset applied). */
export function centerline(g: Pick<ShoeGeometry, 'a' | 'c' | 'zOffset'>, theta: number): Vec2 {
  return { x: g.a * Math.sin(theta), z: -g.c * Math.cos(theta) + g.zOffset };
}

/** Outward unit normal of the centerline. */
export function centerNormal(g: Pick<ShoeGeometry, 'a' | 'c'>, theta: number): Vec2 {
  const nx = Math.sin(theta) / g.a;
  const nz = -Math.cos(theta) / g.c;
  const l = Math.hypot(nx, nz);
  return { x: nx / l, z: nz / l };
}

/** Unit tangent in the direction of increasing theta. */
export function centerTangent(g: Pick<ShoeGeometry, 'a' | 'c'>, theta: number): Vec2 {
  const tx = g.a * Math.cos(theta);
  const tz = g.c * Math.sin(theta);
  const l = Math.hypot(tx, tz);
  return { x: tx / l, z: tz / l };
}

function buildGeometry(spec: ShapeSpec): ShoeGeometry {
  const a = spec.a * IN;
  const c = spec.c * IN;
  const thetaMax = (spec.thetaMaxDeg * Math.PI) / 180;
  const thickness = spec.thickness * IN;
  const base = { a, c, zOffset: 0, thetaMax, spec };

  // First pass to find the bounding box and centre it.
  const N = 96;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i <= N; i++) {
    const th = -thetaMax + (2 * thetaMax * i) / N;
    const p = centerline(base, th);
    const n = centerNormal(base, th);
    const hb = bandWidth(base, th) / 2;
    for (const s of [hb, -hb]) {
      const x = p.x + n.x * s;
      const z = p.z + n.z * s;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
  }
  const zOffset = -(minZ + maxZ) / 2;
  const g0 = { a, c, zOffset, thetaMax, spec };

  const outerContour: Vec2[] = [];
  const innerContour: Vec2[] = [];
  for (let i = 0; i <= N; i++) {
    const th = -thetaMax + (2 * thetaMax * i) / N;
    const p = centerline(g0, th);
    const n = centerNormal(g0, th);
    const hb = bandWidth(g0, th) / 2;
    outerContour.push({ x: p.x + n.x * hb, z: p.z + n.z * hb });
    innerContour.push({ x: p.x - n.x * hb, z: p.z - n.z * hb });
  }

  const hook = spec.hook * IN;
  // Hooks protrude inward at the heel tips.
  const heelR = innerContour[N];
  const heelL = innerContour[0];
  const nR = centerNormal(g0, thetaMax);
  const hookTipR = { x: heelR.x - nR.x * hook, z: heelR.z - nR.z * hook };
  const hookTipL = { x: -hookTipR.x, z: hookTipR.z };
  const opening = hookTipR.x - hookTipL.x;
  void heelL;

  const heelCenterR = centerline(g0, thetaMax);
  const heelCenterL = centerline(g0, -thetaMax);
  const heelLine: [Vec2, Vec2] = [heelCenterL, heelCenterR];

  // Inner polygon: inner contour from left heel round the toe to the right
  // heel, closed by the heel line.
  const innerPolygon = [heelCenterL, ...innerContour, heelCenterR];

  // Collider segments.
  const SEG = 9;
  const segments: SegmentBox[] = [];
  for (let i = 0; i < SEG; i++) {
    const t0 = -thetaMax + (2 * thetaMax * i) / SEG;
    const t1 = -thetaMax + (2 * thetaMax * (i + 1)) / SEG;
    const p0 = centerline(g0, t0);
    const p1 = centerline(g0, t1);
    const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const mid = (t0 + t1) / 2;
    const b = bandWidth(g0, mid);
    // Box local X = radial (band width), Z = tangent.
    const yaw = Math.atan2(p1.x - p0.x, p1.z - p0.z);
    segments.push({
      cx: (p0.x + p1.x) / 2,
      cy: 0,
      cz: (p0.z + p1.z) / 2,
      yaw,
      hx: b / 2,
      hy: thickness / 2,
      hz: len / 2 + 0.002,
    });
  }

  // Calks: toe calk across the toe, heel calks at both heels (below the shoe).
  const toeCalk = spec.toeCalk * IN;
  const heelCalk = spec.heelCalk * IN;
  {
    const p = centerline(g0, 0);
    segments.push({ cx: p.x, cy: -thickness / 2 - toeCalk / 2, cz: p.z - 0.002, yaw: Math.PI / 2, hx: 0.16 * IN, hy: toeCalk / 2, hz: 1.1 * IN });
  }
  for (const s of [-1, 1]) {
    const th = s * (thetaMax - 0.1);
    const p = centerline(g0, th);
    const tng = centerTangent(g0, th);
    segments.push({
      cx: p.x,
      cy: -thickness / 2 - heelCalk / 2,
      cz: p.z,
      yaw: Math.atan2(tng.x, tng.z),
      hx: bandWidth(g0, th) / 2 - 0.0005,
      hy: heelCalk / 2,
      hz: 0.22 * IN,
    });
  }
  if (hook > 0.15 * IN) {
    for (const s of [-1, 1]) {
      const tip = s > 0 ? hookTipR : hookTipL;
      const root = s > 0 ? heelR : { x: -heelR.x, z: heelR.z };
      segments.push({
        cx: (tip.x + root.x) / 2,
        cy: 0,
        cz: (tip.z + root.z) / 2 + 0.002,
        yaw: Math.atan2(tip.x - root.x, tip.z - root.z),
        hx: 0.11 * IN,
        hy: thickness / 2,
        hz: hook / 2 + 0.002,
      });
    }
  }

  // Bottom sample points (used by sand drag / carving).
  const bottomSamples: { x: number; y: number; z: number }[] = [];
  const SS = 20;
  for (let i = 0; i <= SS; i++) {
    const th = -thetaMax + (2 * thetaMax * i) / SS;
    const p = centerline(g0, th);
    const n = centerNormal(g0, th);
    const hb = bandWidth(g0, th) / 2 - 0.002;
    for (const s of [-hb, 0, hb]) {
      bottomSamples.push({ x: p.x + n.x * s, y: -thickness / 2, z: p.z + n.z * s });
    }
  }

  // Calk tips reach deepest into the pit and dominate sand contact.
  {
    const p0 = centerline(g0, 0);
    for (let i = -2; i <= 2; i++) bottomSamples.push({ x: p0.x + i * 0.5 * IN, y: -thickness / 2 - toeCalk, z: p0.z });
    for (const s of [-1, 1]) {
      const p = centerline(g0, s * (thetaMax - 0.1));
      bottomSamples.push({ x: p.x, y: -thickness / 2 - heelCalk, z: p.z });
      bottomSamples.push({ x: p.x * 0.97, y: -thickness / 2 - heelCalk, z: p.z - 0.2 * IN });
    }
  }

  // Collision proxy: two rows of spheres riding the band, end caps,
  // calks and hooks. Sphere radius equals half the plate thickness so the
  // proxy has the shoe's rounded edges.
  const spheres: Sphere[] = [];
  const r = thickness / 2;
  const arcSteps = 400;
  const arcLen: number[] = [0];
  for (let i = 1; i <= arcSteps; i++) {
    const t0 = -thetaMax + (2 * thetaMax * (i - 1)) / arcSteps;
    const t1 = -thetaMax + (2 * thetaMax * i) / arcSteps;
    const p0 = centerline(g0, t0);
    const p1 = centerline(g0, t1);
    arcLen.push(arcLen[i - 1] + Math.hypot(p1.x - p0.x, p1.z - p0.z));
  }
  const total = arcLen[arcSteps];
  const spacing = 0.0072;
  const count = Math.ceil(total / spacing);
  let k = 0;
  for (let i = 0; i <= count; i++) {
    const target = (total * i) / count;
    while (k < arcSteps - 1 && arcLen[k + 1] < target) k++;
    const th = -thetaMax + (2 * thetaMax * (k + (target - arcLen[k]) / Math.max(1e-9, arcLen[k + 1] - arcLen[k]))) / arcSteps;
    const p = centerline(g0, th);
    const n = centerNormal(g0, th);
    const off = Math.max(0, bandWidth(g0, th) / 2 - r);
    spheres.push({ x: p.x + n.x * off, y: 0, z: p.z + n.z * off, r });
    spheres.push({ x: p.x - n.x * off, y: 0, z: p.z - n.z * off, r });
  }
  {
    const rc = 0.0042;
    const p0 = centerline(g0, 0);
    for (let i = -4; i <= 4; i++) spheres.push({ x: p0.x + i * 0.0062, y: -thickness / 2 - toeCalk + rc, z: p0.z, r: rc });
    for (const sgn of [-1, 1]) {
      const th = sgn * (thetaMax - 0.1);
      const p = centerline(g0, th);
      const n = centerNormal(g0, th);
      const off = bandWidth(g0, th) / 2 - rc;
      spheres.push({ x: p.x + n.x * off, y: -thickness / 2 - heelCalk + rc, z: p.z + n.z * off, r: rc });
      spheres.push({ x: p.x - n.x * off, y: -thickness / 2 - heelCalk + rc, z: p.z - n.z * off, r: rc });
    }
    if (hook > 0.004) {
      const rh = 0.0034;
      for (const sgn of [-1, 1]) {
        const tip = sgn > 0 ? hookTipR : hookTipL;
        const root = sgn > 0 ? heelR : { x: -heelR.x, z: heelR.z };
        const steps = Math.max(1, Math.round(hook / 0.004));
        for (let j = 1; j <= steps; j++) {
          const f = j / steps;
          spheres.push({ x: root.x + (tip.x - root.x) * f - Math.sign(tip.x - root.x) * rh * 0.5, y: 0, z: root.z + (tip.z - root.z) * f, r: rh });
        }
      }
    }
  }

  // Mass samples: integrate over the band volume (plus calks).
  const massSamples: { x: number; y: number; z: number; w: number }[] = [];
  const MA = 160;
  const MS = 6;
  const MY = 3;
  for (let i = 0; i < MA; i++) {
    const th = -thetaMax + (2 * thetaMax * (i + 0.5)) / MA;
    const p = centerline(g0, th);
    const n = centerNormal(g0, th);
    const tg = centerTangent(g0, th);
    const dC = Math.hypot(g0.a * Math.cos(th), g0.c * Math.sin(th)) * ((2 * thetaMax) / MA);
    void tg;
    const b = bandWidth(g0, th);
    for (let j = 0; j < MS; j++) {
      const sOff = -b / 2 + (b * (j + 0.5)) / MS;
      for (let l = 0; l < MY; l++) {
        const y = -thickness / 2 + (thickness * (l + 0.5)) / MY;
        massSamples.push({ x: p.x + n.x * sOff, y, z: p.z + n.z * sOff, w: (dC * b * thickness) / (MS * MY) });
      }
    }
  }
  for (const sgm of segments.slice(SEG)) {
    // Calks and hooks: box volume at their centres.
    massSamples.push({ x: sgm.cx, y: sgm.cy, z: sgm.cz, w: 8 * sgm.hx * sgm.hy * sgm.hz });
  }

  let width = 0;
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const p of outerContour) {
    width = Math.max(width, Math.abs(p.x) * 2);
    zmin = Math.min(zmin, p.z);
    zmax = Math.max(zmax, p.z);
  }

  return {
    id: spec.id,
    spec,
    a,
    c,
    thetaMax,
    thickness,
    zOffset,
    toeCalk,
    heelCalk,
    hook,
    innerLip: spec.innerLip * IN,
    width,
    length: zmax - zmin,
    opening,
    innerPolygon,
    outerContour,
    heelLine,
    segments,
    bottomSamples,
    spheres,
    massSamples,
  };
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a segment in 2D. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
}
