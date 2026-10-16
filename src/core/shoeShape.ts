import { IN } from './constants';
import { MODELS, type CalkKind, type ModelId, type ShapeSpec } from './equipment';

/**
 * Shared horseshoe geometry used by physics, judging and rendering.
 *
 * Each model is built from its plan-view outline: a superellipse bow running
 * into straight legs, a band that narrows from toe to heel, and at each heel
 * an outer point, a diagonal heel cut and an inward hook with a curved
 * throat. Calks hang below the plate.
 *
 * Shoe local frame: +X across the shoe, +Y up (top face, calks hang below),
 * +Z points from the toe toward the open heels. The origin is the middle of
 * the bounding box at mid-thickness.
 */

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Sphere {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Part of the reduced set used for shoe-on-shoe contacts. */
  coarse: boolean;
}

/** A calk: a footprint on the bottom of the plate and the ring it rises to. */
export interface Calk {
  kind: CalkKind | 'toe';
  /** Footprint on the underside of the plate (y = -thickness / 2). */
  base: Vec2[];
  /** Matching ring at the bottom of the calk, one point per base point. */
  tip: Vec3[];
}

/** Centreline sample (right half, toe to heel). */
export interface CenterSample {
  s: number;
  p: Vec2;
  /** Outward unit normal. */
  n: Vec2;
  /** Half band width. */
  hb: number;
}

export interface ShoeGeometry {
  id: ModelId;
  spec: ShapeSpec;
  thickness: number;
  /** Measured outer dimensions. */
  width: number;
  length: number;
  /** Inside distance between the hook tips. */
  opening: number;
  /** Closed plan outline with rounded corners (counter-clockwise seen from above). */
  outline: Vec2[];
  /** Inside of the shoe closed by the straightedge across the heel points. */
  innerPolygon: Vec2[];
  /** The straightedge across both heel points. */
  heelLine: [Vec2, Vec2];
  /** Right-half centreline, toe to heel. */
  center: CenterSample[];
  calks: Calk[];
  /** Points on the bottom face used for sand interaction (local). */
  bottomSamples: Vec3[];
  /** Sphere-swept collision proxy (local). */
  spheres: Sphere[];
  /** Volume-weighted points used to integrate mass properties (local). */
  massSamples: (Vec3 & { w: number })[];
}

const cache = new Map<ModelId, ShoeGeometry>();

export function shoeGeometry(id: ModelId): ShoeGeometry {
  let g = cache.get(id);
  if (!g) {
    g = buildGeometry(id, MODELS[id].shape);
    cache.set(id, g);
  }
  return g;
}

// ------------------------------------------------------------ 2D helpers

const v2 = (x: number, z: number): Vec2 => ({ x, z });
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => v2(a.x + b.x * k, a.z + b.z * k);
const sub = (a: Vec2, b: Vec2): Vec2 => v2(a.x - b.x, a.z - b.z);
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;
const len = (a: Vec2) => Math.hypot(a.x, a.z);
const norm = (a: Vec2): Vec2 => {
  const l = len(a) || 1;
  return v2(a.x / l, a.z / l);
};
const mirror = (a: Vec2): Vec2 => v2(-a.x, a.z);
const smooth = (t: number) => {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
};

export function polygonArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j].x * poly[i].z - poly[i].x * poly[j].z;
  return a / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].z - poly[i].x * poly[j].z;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cz += (poly[j].z + poly[i].z) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return v2(poly.reduce((s, p) => s + p.x, 0) / n, poly.reduce((s, p) => s + p.z, 0) / n);
  }
  return v2(cx / (3 * a), cz / (3 * a));
}

/** Keep the part of a polygon on the side of a line where dot(p - origin, dir) >= 0. */
function clipHalfPlane(poly: Vec2[], origin: Vec2, dir: Vec2): Vec2[] {
  const out: Vec2[] = [];
  const side = (p: Vec2) => dot(sub(p, origin), dir);
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb);
      out.push(v2(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t));
    }
  }
  return out;
}

/** Drop points closer together than `eps`. */
function dedupe(poly: Vec2[], eps = 1e-5): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) if (!out.length || len(sub(p, out[out.length - 1])) > eps) out.push(p);
  while (out.length > 2 && len(sub(out[0], out[out.length - 1])) <= eps) out.pop();
  return out;
}

/** Round every corner sharper than `minTurn` radians with an arc of radius `r`. */
export function filletPolygon(poly: Vec2[], r: number, minTurn = 0.35): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const a = poly[(i + n - 1) % n];
    const b = poly[(i + 1) % n];
    const da = norm(sub(a, p));
    const db = norm(sub(b, p));
    const cos = Math.max(-1, Math.min(1, dot(da, db)));
    const inner = Math.acos(cos); // interior angle between the two edges
    const turn = Math.PI - inner;
    if (turn < minTurn || inner < 1e-3) {
      out.push(p);
      continue;
    }
    // Distance along each edge to the tangent points, limited by edge length.
    let t = r / Math.tan(inner / 2);
    const lim = 0.45 * Math.min(len(sub(a, p)), len(sub(b, p)));
    const rr = t > lim ? (r * lim) / t : r;
    t = Math.min(t, lim);
    const pa = add(p, da, t);
    const pb = add(p, db, t);
    const bis = norm(add(da, db));
    const c = add(p, bis, rr / Math.sin(inner / 2));
    const a0 = Math.atan2(pa.z - c.z, pa.x - c.x);
    let d = Math.atan2(pb.z - c.z, pb.x - c.x) - a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil(Math.abs(d) / 0.3));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + (d * k) / steps;
      out.push(v2(c.x + Math.cos(ang) * rr, c.z + Math.sin(ang) * rr));
    }
  }
  return dedupe(out);
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

export function distToPolygon(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, distToSegment(p, poly[j], poly[i]));
  return d;
}

/** Distance along a ray to the first polygon edge it meets. */
function rayToPolygon(o: Vec2, dir: Vec2, poly: Vec2[], tMin: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const e = sub(poly[i], a);
    const den = dir.x * e.z - dir.z * e.x;
    if (Math.abs(den) < 1e-12) continue;
    const w = sub(a, o);
    const t = (w.x * e.z - w.z * e.x) / den;
    const u = (w.x * dir.z - w.z * dir.x) / den;
    if (t > tMin && u >= 0 && u <= 1) best = Math.min(best, t);
  }
  return best;
}

/** Evenly spaced points around a closed polygon. */
function walk(poly: Vec2[], spacing: number): { p: Vec2; t: Vec2 }[] {
  let total = 0;
  for (let i = 0; i < poly.length; i++) total += len(sub(poly[(i + 1) % poly.length], poly[i]));
  const count = Math.max(1, Math.round(total / spacing));
  const step = total / count;
  const out: { p: Vec2; t: Vec2 }[] = [];
  let i = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    let seg = len(sub(poly[(i + 1) % poly.length], poly[i]));
    while (acc + seg < target && i < poly.length - 1) {
      acc += seg;
      i++;
      seg = len(sub(poly[(i + 1) % poly.length], poly[i]));
    }
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const f = seg > 0 ? (target - acc) / seg : 0;
    out.push({ p: v2(a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f), t: norm(sub(b, a)) });
  }
  return out;
}

// --------------------------------------------------------------- builder

function buildGeometry(id: ModelId, spec: ShapeSpec): ShoeGeometry {
  const thickness = spec.thickness * IN;
  const bandToe = spec.bandToe * IN, bandLeg = spec.bandLeg * IN, bandHeel = spec.bandHeel * IN;
  const hbHeel = bandHeel / 2;
  const R = (spec.hookTip * IN) / 2;
  const reach = spec.hookReach * IN;
  const throat = spec.hookThroat * IN;
  const curl = spec.hookCurl * IN;
  const hp = spec.heelPoint * IN;
  const flare = spec.heelFlare * IN;
  const lean = (spec.legLean * Math.PI) / 180;

  // Centreline, right half: superellipse bow from the toe, then a straight leg.
  const A = (spec.width * IN) / 2 - bandLeg / 2 - flare * 0.5;
  const B = spec.bowDepth * IN;
  const legLen = Math.max(0.01, (spec.length * IN - bandToe / 2 - B - hp) / Math.cos(lean));
  const raw: Vec2[] = [];
  const NB = 240;
  const e = 2 / spec.squareness;
  for (let i = 0; i <= NB; i++) {
    const phi = (i / NB) * (Math.PI / 2);
    raw.push(v2(A * Math.pow(Math.sin(phi), e), -B * Math.pow(Math.cos(phi), e)));
  }
  const legDir = v2(-Math.sin(lean), Math.cos(lean));
  const NL = 60;
  for (let i = 1; i <= NL; i++) raw.push(add(raw[NB], legDir, (legLen * i) / NL));
  // Resample by arc length.
  const acc = [0];
  for (let i = 1; i < raw.length; i++) acc.push(acc[i - 1] + len(sub(raw[i], raw[i - 1])));
  const total = acc[acc.length - 1];
  const sJunction = acc[NB];
  const M = 100;
  const center: CenterSample[] = [];
  let k = 0;
  for (let i = 0; i <= M; i++) {
    const s = (total * i) / M;
    while (k < raw.length - 2 && acc[k + 1] < s) k++;
    const f = (s - acc[k]) / Math.max(1e-12, acc[k + 1] - acc[k]);
    const p = v2(raw[k].x + (raw[k + 1].x - raw[k].x) * f, raw[k].z + (raw[k + 1].z - raw[k].z) * f);
    const hb =
      s < sJunction
        ? bandToe / 2 + (bandLeg / 2 - bandToe / 2) * smooth(s / sJunction)
        : bandLeg / 2 + (hbHeel - bandLeg / 2) * ((s - sJunction) / Math.max(1e-9, total - sJunction));
    center.push({ s, p, n: v2(0, 0), hb });
  }
  for (let i = 0; i <= M; i++) {
    const a = center[Math.max(0, i - 1)].p;
    const b = center[Math.min(M, i + 1)].p;
    const t = i === 0 ? v2(1, 0) : norm(sub(b, a));
    center[i].n = v2(t.z, -t.x);
  }

  // Heel frame at the end of the right leg: o = outward, t = toward the heel tip.
  const E = center[M].p;
  const o = center[M].n;
  const tH = v2(-o.z, o.x);
  const H = (a: number, b: number): Vec2 => add(add(E, o, a), tH, b);

  // Toe notch: a low bump on the inside of the toe.
  const notchW = 0.55 * IN;
  const notch = (s: number) => (spec.toeNotch > 0 && s < notchW ? spec.toeNotch * IN * Math.cos((s / notchW) * Math.PI * 0.5) ** 2 : 0);

  // Right-hand chain: outer edge toe→heel, round the heel, inner edge heel→toe.
  const outer = center.map((c) => add(c.p, c.n, c.hb));
  const outerPoint = H(hbHeel + flare, hp);
  const aTip = -hbHeel - reach + R;
  const heel: Vec2[] = [outerPoint];
  // Diagonal heel cut from the outer point to the bottom of the hook tip.
  for (let i = 1; i < 6; i++) heel.push(H(hbHeel + flare + (aTip - hbHeel - flare) * (i / 6), hp + (-curl - hp) * (i / 6)));
  // Rounded tip.
  const tipC = { a: aTip, b: -curl - R };
  for (let i = 0; i <= 10; i++) {
    const ang = Math.PI / 2 + (Math.PI * i) / 10;
    heel.push(H(tipC.a + Math.cos(ang) * R, tipC.b + Math.sin(ang) * R));
  }
  // Throat: concave curve from the top of the tip back to the inside of the leg.
  const bTop = -curl - 2 * R;
  const p0 = { a: aTip, b: bTop }, p1 = { a: -hbHeel, b: bTop }, p2 = { a: -hbHeel, b: bTop - throat };
  for (let i = 1; i <= 12; i++) {
    const u = i / 12;
    const w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
    heel.push(H(p0.a * w0 + p1.a * w1 + p2.a * w2, p0.b * w0 + p1.b * w1 + p2.b * w2));
  }
  const bRoot = bTop - throat;
  const inner: Vec2[] = [];
  for (let i = M; i >= 0; i--) {
    const c = center[i];
    const q = add(c.p, c.n, -(c.hb + notch(c.s)));
    if (dot(sub(q, E), tH) < bRoot - 1e-4) inner.push(q);
  }
  const chainR = dedupe([...outer, ...heel, ...inner]);
  // Full outline: right chain, then the mirrored chain reversed (inner toe → left heel → outer toe).
  const leftRev = chainR.map(mirror).reverse();
  let outline = dedupe([...chainR, ...leftRev.slice(1, -1)]);
  if (polygonArea(outline) < 0) outline.reverse();

  // Centre on the bounding box.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of outline) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const zOff = -(minZ + maxZ) / 2;
  const shift = (p: Vec2): Vec2 => v2(p.x, p.z + zOff);
  outline = outline.map(shift);
  for (const c of center) c.p = shift(c.p);
  const Es = shift(E);
  const Hs = (a: number, b: number): Vec2 => add(add(Es, o, a), tH, b);
  const heelR = heel.map(shift);
  const innerR = inner.map(shift);
  const outerPointR = shift(outerPoint);

  // Judging: the inside of the shoe (heel cuts, hooks and inner edge) closed
  // by the straightedge across the heel points. Left outer point → left hook
  // → left inner edge → toe → right inner edge → right hook → right outer point.
  const judge = dedupe([...heelR.map(mirror), ...innerR.map(mirror), ...[...innerR].reverse(), ...[...heelR].reverse()]);
  const heelLine: [Vec2, Vec2] = [mirror(outerPointR), outerPointR];

  const rounded = filletPolygon(outline, 0.0016);

  // ------------------------------------------------------------- calks
  const calks: Calk[] = [];
  const baseY = -thickness / 2;
  const hc = spec.heelCalk;
  const calkH = hc.height * IN;
  for (const side of [1, -1]) {
    const toWorld = (p: Vec2) => (side > 0 ? p : mirror(p));
    // The end of the right leg as a simple polygon (leg sides, heel cut, hook,
    // throat), clipped to the calk's length and reach in the heel frame.
    const far = -3 * IN;
    let fp = [Hs(-hbHeel, far), Hs(hbHeel, far), Hs(hbHeel, 0), ...heelR];
    fp = clipHalfPlane(fp, Hs(0, -hc.length * IN), tH);
    fp = clipHalfPlane(fp, Hs(-hbHeel - reach * hc.reach - 1e-4, 0), o);
    fp = dedupe(fp, 2e-4);
    if (polygonArea(fp) < 0) fp.reverse();
    if (fp.length < 3) continue;
    fp = filletPolygon(fp, 0.0022, 0.5);
    const c = polygonCentroid(fp);
    // Pull the footprint in slightly so the calk sits inside the plate's rounded edge.
    fp = fp.map((p) => add(c, sub(p, c), 0.94));
    const local = (p: Vec2) => ({ a: dot(sub(p, Es), o), b: dot(sub(p, Es), tH) });
    let bMin = Infinity, bMax = -Infinity;
    for (const p of fp) {
      const l = local(p);
      bMin = Math.min(bMin, l.b);
      bMax = Math.max(bMax, l.b);
    }
    let apex: Vec2, shrink: number;
    const height = (p: Vec2) => {
      const f = (local(p).b - bMin) / Math.max(1e-9, bMax - bMin);
      if (hc.kind === 'wedge') return calkH * (0.45 + 0.55 * f);
      if (hc.kind === 'bevel') return calkH * (0.62 + 0.38 * Math.min(1, f * 1.6));
      return calkH;
    };
    if (hc.kind === 'pyramid') {
      apex = Hs(-hbHeel * 0.55, hp * 0.15);
      shrink = 0.06;
    } else if (hc.kind === 'wedge') {
      apex = Hs(0, hp * 0.4);
      shrink = 0.72;
    } else {
      apex = c;
      shrink = hc.kind === 'bevel' ? 0.8 : 0.88;
    }
    const tip = fp.map((p) => {
      const q = add(apex, sub(p, apex), shrink);
      return { x: q.x, y: baseY - height(p), z: q.z };
    });
    calks.push({ kind: hc.kind, base: fp.map(toWorld), tip: tip.map((p) => ({ ...p, x: side > 0 ? p.x : -p.x })) });
  }
  {
    // Toe calk: a bar along the toe, just in from the outer edge.
    const tc = spec.toeCalk;
    const halfLen = (tc.length * IN) / 2;
    const w = tc.width * IN;
    const inset = 0.07 * IN;
    const samp = center.filter((c) => c.s <= halfLen);
    const outerEdge: Vec2[] = [];
    const innerEdge: Vec2[] = [];
    for (const c of [...samp].reverse().map((c) => ({ ...c, p: mirror(c.p), n: mirror(c.n) })).concat(samp.slice(1))) {
      outerEdge.push(add(c.p, c.n, c.hb - inset));
      innerEdge.push(add(c.p, c.n, c.hb - inset - w));
    }
    let fp = dedupe([...outerEdge, ...innerEdge.reverse()]);
    if (polygonArea(fp) < 0) fp.reverse();
    fp = filletPolygon(fp, 0.002, 0.5);
    const c = polygonCentroid(fp);
    const h = tc.height * IN;
    calks.push({ kind: 'toe', base: fp, tip: fp.map((p) => { const q = add(c, sub(p, c), 0.9); return { x: q.x, y: baseY - h, z: q.z }; }) });
  }
  for (const ck of calks) if (polygonArea(ck.base) < 0) {
    ck.base.reverse();
    ck.tip.reverse();
  }

  // ------------------------------------------------- collision proxy
  const r = thickness / 2;
  const spheres: Sphere[] = [];
  const edge = walk(rounded, 0.0062);
  const ccw = polygonArea(rounded) > 0;
  edge.forEach(({ p, t }, i) => {
    // Inward normal of a counter-clockwise outline (x right, z down when seen from above).
    const m = ccw ? v2(-t.z, t.x) : v2(t.z, -t.x);
    const inward = pointInPolygon(add(p, m, 5e-4), rounded) ? m : v2(-m.x, -m.z);
    const w = rayToPolygon(p, inward, rounded, 3e-4);
    const rr = Math.max(0.0025, Math.min(r, (Number.isFinite(w) ? w : 2 * r) / 2));
    const c = add(p, inward, rr);
    spheres.push({ x: c.x, y: 0, z: c.z, r: rr, coarse: i % 2 === 0 });
  });
  // Fill wide areas so nothing can slip between the two edge rows.
  for (let x = minX; x <= maxX; x += 0.008)
    for (let z = minZ + zOff; z <= maxZ + zOff; z += 0.008) {
      const p = v2(x, z);
      if (pointInPolygon(p, rounded) && distToPolygon(p, rounded) >= r + 0.0025) spheres.push({ x, y: 0, z, r, coarse: true });
    }
  const rc = 0.0042;
  for (const ck of calks) {
    const ring = ck.tip.map((p) => v2(p.x, p.z));
    const cc = polygonCentroid(ring);
    const span = Math.max(...ring.map((p) => len(sub(p, cc))));
    if (span < rc * 1.5) {
      const y = Math.min(...ck.tip.map((p) => p.y));
      spheres.push({ x: cc.x, y: y + rc, z: cc.z, r: rc, coarse: true });
      continue;
    }
    for (const { p } of walk(ring, 0.007)) {
      const q = add(p, norm(sub(cc, p)), Math.min(rc, len(sub(cc, p))));
      // Height of the ring at this point: nearest tip vertex.
      let y = 0, best = Infinity;
      for (const tp of ck.tip) {
        const d = Math.hypot(tp.x - p.x, tp.z - p.z);
        if (d < best) {
          best = d;
          y = tp.y;
        }
      }
      spheres.push({ x: q.x, y: y + rc, z: q.z, r: rc, coarse: true });
    }
  }

  // ------------------------------------------------- sand contact
  const bottomSamples: Vec3[] = [];
  for (let x = minX + 0.004; x <= maxX; x += 0.0085)
    for (let z = minZ + zOff + 0.004; z <= maxZ + zOff; z += 0.0085)
      if (pointInPolygon(v2(x, z), rounded)) bottomSamples.push({ x, y: -thickness / 2, z });
  for (const ck of calks) for (const { p } of walk(ck.tip.map((q) => v2(q.x, q.z)), 0.008)) {
    let y = 0, best = Infinity;
    for (const tp of ck.tip) {
      const d = Math.hypot(tp.x - p.x, tp.z - p.z);
      if (d < best) {
        best = d;
        y = tp.y;
      }
    }
    bottomSamples.push({ x: p.x, y, z: p.z });
  }

  // ------------------------------------------------- mass properties
  const massSamples: (Vec3 & { w: number })[] = [];
  const G = 0.003;
  for (let x = minX + G / 2; x <= maxX; x += G)
    for (let z = minZ + zOff + G / 2; z <= maxZ + zOff; z += G)
      if (pointInPolygon(v2(x, z), rounded))
        for (let l = 0; l < 3; l++) massSamples.push({ x, y: -thickness / 2 + (thickness * (l + 0.5)) / 3, z, w: (G * G * thickness) / 3 });
  for (const ck of calks) {
    const area = Math.abs(polygonArea(ck.base));
    const depth = -thickness / 2 - ck.tip.reduce((s, p) => s + p.y, 0) / ck.tip.length;
    const fill = ck.kind === 'pyramid' ? 0.36 : 0.8;
    const c = polygonCentroid(ck.base);
    massSamples.push({ x: c.x, y: -thickness / 2 - depth * 0.4, z: c.z, w: area * depth * fill });
  }

  // ------------------------------------------------- measurements
  const opening = 2 * Math.min(...heelR.map((p) => p.x));

  return {
    id,
    spec,
    thickness,
    width: maxX - minX,
    length: maxZ - minZ,
    opening,
    outline: rounded,
    innerPolygon: judge,
    heelLine,
    center,
    calks,
    bottomSamples,
    spheres,
    massSamples,
  };
}
