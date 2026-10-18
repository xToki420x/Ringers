import * as THREE from 'three';

/**
 * Generates a smooth, seamless, skinned human body.
 *
 * The body is sculpted as a signed distance field — ellipsoids and rounded
 * cones for anatomy, slightly inflated shapes for clothing so sleeves, belt
 * and cuffs read as real garment edges — blended with smooth unions. The
 * surface is extracted with narrow-band surface nets, every vertex is
 * projected back onto the exact field, normals come from the field gradient,
 * ambient occlusion is baked from the field, and skin weights come from the
 * distance to each bone. The result is a single organic mesh with no seams
 * between limbs, ready for a THREE.SkinnedMesh.
 */

export type BodyMat = 'skin' | 'shirt' | 'pants' | 'belt' | 'shoe' | 'sole' | 'hair';
export const BODY_MATS: BodyMat[] = ['skin', 'shirt', 'pants', 'belt', 'shoe', 'sole', 'hair'];

type V3 = [number, number, number];

export interface BoneDef {
  name: string;
  head: V3;
  tail: V3;
  parent: number;
}

/** Body type: the skeleton's proportions and the outfit sculpted on it. */
export type Build = 'male' | 'female';

/** Bind-pose skeleton (metres, facing +Z, left side = +X): narrower shoulders and wider hips for the female build. */
export function bonesFor(build: Build): BoneDef[] {
  const arm = build === 'female' ? 0.9 : 1.03;
  const hip = build === 'female' ? 1.05 : 1;
  const b: BoneDef[] = [
    { name: 'hips', head: [0, 0.9, 0], tail: [0, 1.02, 0], parent: -1 },
    { name: 'spine', head: [0, 1.02, 0], tail: [0, 1.22, 0], parent: 0 },
    { name: 'chest', head: [0, 1.22, 0], tail: [0, 1.46, 0], parent: 1 },
    { name: 'neck', head: [0, 1.46, 0], tail: [0, 1.56, 0.005], parent: 2 },
    { name: 'head', head: [0, 1.56, 0.005], tail: [0, 1.77, 0.01], parent: 3 },
  ];
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const ua = b.length;
    b.push({ name: `upperArm${side}`, head: [s * 0.192 * arm, 1.405, -0.005], tail: [s * 0.24 * arm, 1.13, -0.015], parent: 2 });
    b.push({ name: `forearm${side}`, head: [s * 0.24 * arm, 1.13, -0.015], tail: [s * 0.272 * arm, 0.885, 0.012], parent: ua });
    b.push({ name: `hand${side}`, head: [s * 0.272 * arm, 0.885, 0.012], tail: [s * 0.282 * arm, 0.78, 0.022], parent: ua + 1 });
  }
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const th = b.length;
    b.push({ name: `thigh${side}`, head: [s * 0.093 * hip, 0.93, 0], tail: [s * 0.1, 0.5, 0.012], parent: 0 });
    b.push({ name: `shin${side}`, head: [s * 0.1, 0.5, 0.012], tail: [s * 0.1, 0.088, -0.022], parent: th });
    b.push({ name: `foot${side}`, head: [s * 0.1, 0.088, -0.022], tail: [s * 0.106, 0.03, 0.13], parent: th + 1 });
  }
  return b;
}

/** The male skeleton (bone indices are the same for every build). */
export const BONES: BoneDef[] = bonesFor('male');

export const BONE = Object.fromEntries(BONES.map((b, i) => [b.name, i])) as Record<string, number>;

/** Eye centres (bind pose); the sculpt carves sockets for eyeballs placed here. */
export function eyeCentres(build: Build): [V3, V3] {
  const e = (s: number): V3 => (build === 'female' ? headScale([s * 0.0315, 1.656, 0.071], 0.95) : [s * 0.0315, 1.656, 0.071]);
  return [e(1), e(-1)];
}

/** Scale a head-region point about the centre of the head. */
function headScale(p: V3, k: number): V3 {
  return [p[0] * k, 1.66 + (p[1] - 1.66) * k, 0.01 + (p[2] - 0.01) * k];
}

interface Prim {
  kind: 'ell' | 'cone';
  a: V3;
  b: V3;
  r: V3;
  r1: number;
  r2: number;
  mat: BodyMat;
  bone: number;
  k: number;
  min: V3;
  max: V3;
  /** Carved away (smooth subtraction) instead of added. */
  neg?: boolean;
}

function ell(c: V3, r: V3, mat: BodyMat, bone: number, k = 0.03): Prim {
  const m = Math.max(...r) + k;
  return { kind: 'ell', a: c, b: c, r, r1: 0, r2: 0, mat, bone, k, min: [c[0] - m, c[1] - m, c[2] - m], max: [c[0] + m, c[1] + m, c[2] + m] };
}

function cone(a: V3, b: V3, r1: number, r2: number, mat: BodyMat, bone: number, k = 0.03): Prim {
  const m = Math.max(r1, r2) + k;
  return {
    kind: 'cone', a, b, r: [0, 0, 0], r1, r2, mat, bone, k,
    min: [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.min(a[2], b[2]) - m],
    max: [Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, Math.max(a[2], b[2]) + m],
  };
}

const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export type Pose = 'standing' | 'seated';

/**
 * Sculpt: anatomy plus clothing as slightly proud shapes. The male build
 * wears a short-sleeved polo, belted work pants and a short crop under a cap;
 * the female build a sleeveless polo over leggings, with long hair drawn back
 * (the braid itself is a separate mesh).
 */
function sculpt(pose: Pose, build: Build = 'male'): Prim[] {
  const P: Prim[] = [];
  const B = BONE;
  const F = build === 'female';
  const BN = bonesFor(build);
  // Head features of the female build are sculpted 5% smaller about the head's centre.
  const hk = F ? 0.95 : 1;
  const hp = (c: V3): V3 => (F ? headScale(c, hk) : c);
  const hr = (r: V3): V3 => [r[0] * hk, r[1] * hk, r[2] * hk];
  const head = (c: V3, r: V3, mat: BodyMat, k: number) => P.push(ell(hp(c), hr(r), mat, B.head, k * hk));
  if (F) {
    // Athletic torso in a sleeveless polo: bust, narrow waist, hem over the leggings.
    P.push(ell([0, 1.315, -0.005], [0.136, 0.135, 0.098], 'shirt', B.chest, 0.05));
    P.push(cone([-0.13, 1.39, -0.012], [0.13, 1.39, -0.012], 0.058, 0.058, 'shirt', B.chest, 0.045));
    P.push(ell([0, 1.145, 0.004], [0.116, 0.14, 0.087], 'shirt', B.spine, 0.06));
    P.push(ell([0, 1.0, 0.004], [0.146, 0.08, 0.103], 'shirt', B.hips, 0.04));
    P.push(ell([0, 0.955, 0.004], [0.156, 0.034, 0.108], 'shirt', B.hips, 0.01)); // hem
    for (const s of [1, -1]) P.push(ell([s * 0.05, 1.29, 0.058], [0.056, 0.052, 0.048], 'shirt', B.chest, 0.04)); // bust
    P.push(ell([0, 1.3, -0.07], [0.11, 0.09, 0.04], 'shirt', B.chest, 0.05)); // shoulder blades
    for (const s of [1, -1]) P.push(ell([s * 0.074, 1.42, -0.018], [0.062, 0.034, 0.048], 'shirt', B.chest, 0.04)); // trapezius
    P.push(ell([0, 1.445, -0.004], [0.062, 0.02, 0.058], 'shirt', B.chest, 0.012)); // collar
    // Leggings: waistband, pelvis and glutes.
    P.push(ell([0, 0.9, 0], [0.16, 0.095, 0.108], 'pants', B.hips, 0.04));
    for (const s of [1, -1]) P.push(ell([s * 0.064, 0.87, -0.055], [0.082, 0.09, 0.072], 'pants', B.hips, 0.04));
  } else {
    // Broad-shouldered torso with a slight V-taper, polo tucked into belted work pants.
    P.push(ell([0, 1.33, -0.005], [0.166, 0.145, 0.11], 'shirt', B.chest, 0.05));
    P.push(cone([-0.155, 1.405, -0.012], [0.155, 1.405, -0.012], 0.07, 0.07, 'shirt', B.chest, 0.05));
    P.push(ell([0, 1.15, 0.006], [0.138, 0.15, 0.098], 'shirt', B.spine, 0.06));
    P.push(ell([0, 1.03, 0.004], [0.146, 0.07, 0.102], 'shirt', B.hips, 0.04));
    P.push(ell([0, 1.27, 0.07], [0.125, 0.08, 0.05], 'shirt', B.chest, 0.05)); // pecs
    P.push(ell([0, 1.3, -0.075], [0.135, 0.1, 0.045], 'shirt', B.chest, 0.05)); // shoulder blades
    for (const s of [1, -1]) P.push(ell([s * 0.11, 1.26, -0.03], [0.06, 0.12, 0.07], 'shirt', B.chest, 0.05)); // lats
    for (const s of [1, -1]) P.push(ell([s * 0.088, 1.44, -0.018], [0.078, 0.043, 0.056], 'shirt', B.chest, 0.04)); // trapezius
    P.push(ell([0, 1.46, -0.004], [0.07, 0.022, 0.066], 'shirt', B.chest, 0.012)); // collar
    P.push(ell([0, 0.965, 0.002], [0.152, 0.024, 0.106], 'belt', B.hips, 0.008));
    P.push(ell([0, 0.9, 0], [0.156, 0.09, 0.106], 'pants', B.hips, 0.04));
    for (const s of [1, -1]) P.push(ell([s * 0.06, 0.865, -0.05], [0.078, 0.085, 0.068], 'pants', B.hips, 0.04));
  }
  // Neck.
  P.push(cone([0, 1.43, -0.005], F ? [0, 1.57, 0.006] : [0, 1.575, 0.008], F ? 0.047 : 0.056, F ? 0.043 : 0.051, 'skin', B.neck, 0.03));
  // Head: cranium, face, jaw and chin (square for him, heart-shaped for her), cheekbones, brow, nose, lips, ears.
  head([0, 1.69, -0.008], [0.076, 0.083, 0.094], 'skin', 0.03);
  head([0, 1.628, 0.03], [0.057, 0.068, 0.07], 'skin', 0.04);
  if (F) {
    head([0, 1.592, 0.035], [0.049, 0.03, 0.05], 'skin', 0.04);
    head([0, 1.568, 0.068], [0.019, 0.017, 0.018], 'skin', 0.022);
    for (const s of [1, -1]) head([s * 0.044, 1.645, 0.06], [0.026, 0.017, 0.022], 'skin', 0.022);
    head([0, 1.677, 0.078], [0.046, 0.009, 0.012], 'skin', 0.02);
    P.push(cone(hp([0, 1.666, 0.09]), hp([0, 1.63, 0.105]), 0.0068 * hk, 0.0094 * hk, 'skin', B.head, 0.012));
    head([0, 1.627, 0.097], [0.0145, 0.009, 0.01], 'skin', 0.01);
    head([0, 1.6, 0.09], [0.022, 0.0085, 0.01], 'skin', 0.009);
    head([0, 1.588, 0.087], [0.02, 0.009, 0.011], 'skin', 0.009);
  } else {
    head([0, 1.586, 0.035], [0.058, 0.036, 0.057], 'skin', 0.04);
    head([0, 1.564, 0.07], [0.03, 0.02, 0.021], 'skin', 0.022);
    for (const s of [1, -1]) head([s * 0.041, 1.641, 0.06], [0.022, 0.015, 0.02], 'skin', 0.02);
    head([0, 1.676, 0.079], [0.05, 0.011, 0.015], 'skin', 0.02);
    P.push(cone([0, 1.668, 0.09], [0, 1.629, 0.107], 0.0072, 0.0094, 'skin', B.head, 0.01));
    head([0, 1.626, 0.098], [0.0135, 0.0085, 0.0095], 'skin', 0.009);
    head([0, 1.599, 0.091], [0.021, 0.0075, 0.009], 'skin', 0.009);
    head([0, 1.588, 0.088], [0.018, 0.007, 0.009], 'skin', 0.009);
  }
  for (const s of [1, -1]) head([s * 0.078, 1.648, -0.008], [0.011, 0.028, 0.019], 'skin', 0.01); // ears
  // Eye sockets, carved to an almond opening, with a fold above each lid; the eyeballs are separate meshes.
  for (const c of eyeCentres(build)) {
    const sock = ell([c[0], c[1] - 0.0008 * hk, c[2] + 0.0155 * hk], [0.0148 * hk, 0.0066 * hk, 0.011 * hk], 'skin', B.head, 0.004);
    sock.neg = true;
    P.push(sock);
    P.push(ell([c[0], c[1] + 0.0112 * hk, c[2] + 0.0105 * hk], [0.0155 * hk, 0.0038 * hk, 0.007 * hk], 'skin', B.head, 0.006));
  }
  // Eyebrows: a finer arch for her.
  for (const s of [1, -1]) {
    if (F) head([s * 0.034, 1.686, 0.084], [0.0165, 0.0029, 0.007], 'hair', 0.004);
    else head([s * 0.031, 1.684, 0.085], [0.021, 0.0055, 0.009], 'hair', 0.004);
  }
  if (F) {
    // Hair drawn back from a soft hairline, over the tops of the ears, gathered at the nape.
    head([0, 1.698, -0.014], [0.081, 0.088, 0.098], 'hair', 0.006);
    for (const s of [1, -1]) head([s * 0.07, 1.69, -0.02], [0.018, 0.04, 0.05], 'hair', 0.006);
    head([0, 1.625, -0.075], [0.055, 0.045, 0.035], 'hair', 0.01);
  } else {
    // Short crop under the cap, sideburns.
    P.push(ell([0, 1.692, -0.02], [0.08, 0.087, 0.092], 'hair', B.head, 0.008));
    for (const s of [1, -1]) P.push(ell([s * 0.072, 1.66, 0.022], [0.009, 0.026, 0.016], 'hair', B.head, 0.008));
  }
  // Arms.
  const am = F ? 0.86 : 1.06; // limb girth
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const ua = BN[B[`upperArm${side}`]];
    const fa = BN[B[`forearm${side}`]];
    const hd = BN[B[`hand${side}`]];
    const uab = B[`upperArm${side}`], fab = B[`forearm${side}`], hb = B[`hand${side}`];
    if (F) {
      P.push(ell([ua.head[0] - s * 0.008, 1.385, -0.006], [0.052, 0.05, 0.055], 'skin', uab, 0.04)); // bare shoulder
    } else {
      P.push(ell([s * 0.198, 1.398, -0.006], [0.068, 0.064, 0.07], 'shirt', uab, 0.045)); // deltoid
    }
    P.push(cone(ua.head, ua.tail, 0.052 * am, 0.04 * am, 'skin', uab, 0.025));
    P.push(ell(lerp3(ua.head, ua.tail, 0.45), [0.05 * am, 0.075, 0.052 * am], 'skin', uab, 0.03)); // biceps
    if (!F) {
      P.push(cone(ua.head, lerp3(ua.head, ua.tail, 0.46), 0.064, 0.06, 'shirt', uab, 0.006)); // sleeve
      P.push(ell(lerp3(ua.head, ua.tail, 0.45), [0.066, 0.014, 0.066], 'shirt', uab, 0.004)); // rolled cuff
    }
    P.push(cone(fa.head, fa.tail, 0.041 * am, 0.029 * am, 'skin', fab, 0.02));
    P.push(ell(lerp3(fa.head, fa.tail, 0.28), [0.048 * am, 0.072, 0.045 * am], 'skin', fab, 0.03)); // forearm muscle
    // Hand: palm, four relaxed, slightly curled fingers and a thumb. The palm faces the thigh.
    const hs = F ? 0.92 : 1.04;
    const wrist = hd.head;
    P.push(ell(lerp3(hd.head, hd.tail, 0.36), [0.017 * hs, 0.043 * hs, 0.04 * hs], 'skin', hb, 0.02));
    const fingers: [number, number][] = [[0.025, 0.07], [0.0085, 0.077], [-0.008, 0.073], [-0.024, 0.059]];
    for (const [dz0, len0] of fingers) {
      const dz = dz0 * hs, len = len0 * hs;
      const k0: V3 = [wrist[0] + s * 0.004, wrist[1] - 0.076 * hs, wrist[2] + dz];
      const k1: V3 = [k0[0] - s * 0.004, k0[1] - len * 0.55, k0[2] + dz * 0.08];
      const k2: V3 = [k1[0] - s * 0.016, k1[1] - len * 0.4, k1[2] + dz * 0.05];
      P.push(cone(k0, k1, 0.0092 * hs, 0.008 * hs, 'skin', hb, 0.006));
      P.push(cone(k1, k2, 0.008 * hs, 0.0068 * hs, 'skin', hb, 0.005));
    }
    P.push(cone([wrist[0] - s * 0.006, wrist[1] - 0.03, wrist[2] + 0.03], [wrist[0] - s * 0.018 * hs, wrist[1] - 0.07 * hs, wrist[2] + 0.046 * hs], 0.0115 * hs, 0.0085 * hs, 'skin', hb, 0.01)); // thumb
  }
  // Legs (or seated legs for spectators).
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    let th = BN[B[`thigh${side}`]];
    let sh = BN[B[`shin${side}`]];
    let ft = BN[B[`foot${side}`]];
    if (pose === 'seated') {
      const knee: V3 = [s * 0.11, 0.9, 0.42];
      const ankle: V3 = [s * 0.11, 0.48, 0.45];
      th = { ...th, tail: knee };
      sh = { ...sh, head: knee, tail: ankle };
      ft = { ...ft, head: ankle, tail: [s * 0.115, 0.43, 0.6] };
    }
    const thb = B[`thigh${side}`], shb = B[`shin${side}`];
    if (F) {
      // Leggings follow the leg.
      P.push(cone(th.head, th.tail, 0.08, 0.05, 'pants', thb, 0.03));
      P.push(ell(lerp3(th.head, th.tail, 0.36), [0.07, 0.12, 0.068], 'pants', thb, 0.04));
      P.push(cone(sh.head, sh.tail, 0.05, 0.034, 'pants', shb, 0.02));
      P.push(ell(lerp3(sh.head, sh.tail, 0.08), [0.05, 0.05, 0.05], 'pants', shb, 0.03)); // knee
      P.push(ell([lerp3(sh.head, sh.tail, 0.3)[0], lerp3(sh.head, sh.tail, 0.3)[1], lerp3(sh.head, sh.tail, 0.3)[2] - 0.016], [0.05, 0.085, 0.052], 'pants', shb, 0.03)); // calf
    } else {
      // Straight work pants.
      P.push(cone(th.head, th.tail, 0.088, 0.062, 'pants', thb, 0.03));
      P.push(ell(lerp3(th.head, th.tail, 0.38), [0.076, 0.12, 0.072], 'pants', thb, 0.04));
      P.push(cone(sh.head, sh.tail, 0.062, 0.056, 'pants', shb, 0.02));
      P.push(ell(lerp3(sh.head, sh.tail, 0.12), [0.063, 0.06, 0.063], 'pants', shb, 0.03)); // knee
      P.push(ell(lerp3(sh.head, sh.tail, 0.35), [0.06, 0.09, 0.062], 'pants', shb, 0.03)); // calf
    }
    // Athletic shoes, in a frame at the ankle facing the toe; the hem sits over the top.
    const fs = F ? 0.93 : 1.03;
    const a = sh.tail;
    const fx = ft.tail[0] - a[0], fz = ft.tail[2] - a[2];
    const fl = Math.hypot(fx, fz) || 1;
    const at = (fwd: number, up: number, out = 0): V3 => [a[0] + (fx / fl) * fwd * fs + s * out, a[1] - 0.088 + up, a[2] + (fz / fl) * fwd * fs];
    const shoe = B[`foot${side}`];
    if (F) P.push(ell(at(-0.006, 0.112), [0.044, 0.016, 0.048], 'pants', shb, 0.006)); // leggings cuff
    else P.push(ell(at(-0.006, 0.128), [0.062, 0.034, 0.066], 'pants', shb, 0.008)); // hem
    P.push(ell(at(-0.024, 0.06), [0.041 * fs, 0.05, 0.05 * fs], 'shoe', shoe, 0.03)); // heel counter
    P.push(cone(at(-0.01, 0.066), at(0.13, 0.04), 0.047 * fs, 0.035 * fs, 'shoe', shoe, 0.03)); // upper
    P.push(ell(at(0.14, 0.034, 0.003), [0.044 * fs, 0.027, 0.05 * fs], 'shoe', shoe, 0.025)); // toe box
    P.push(ell(at(0.024, 0.086), [0.037 * fs, 0.022, 0.046 * fs], 'shoe', shoe, 0.025)); // collar and tongue
    P.push(ell(at(0.062, 0.015, 0.002), [0.05 * fs, 0.0145, 0.135 * fs], 'sole', shoe, 0.006)); // sole
  }
  return P;
}

function sdPrim(p: Prim, x: number, y: number, z: number): number {
  if (p.kind === 'ell') {
    const px = x - p.a[0], py = y - p.a[1], pz = z - p.a[2];
    const k0 = Math.hypot(px / p.r[0], py / p.r[1], pz / p.r[2]);
    const k1 = Math.hypot(px / (p.r[0] * p.r[0]), py / (p.r[1] * p.r[1]), pz / (p.r[2] * p.r[2]));
    return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(...p.r);
  }
  // Round cone (Inigo Quilez).
  const bax = p.b[0] - p.a[0], bay = p.b[1] - p.a[1], baz = p.b[2] - p.a[2];
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = p.r1 - p.r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - p.a[0], pay = y - p.a[1], paz = z - p.a[2];
  const yy = pax * bax + pay * bay + paz * baz;
  const zz = yy - l2;
  const xvx = pax * l2 - bax * yy, xvy = pay * l2 - bay * yy, xvz = paz * l2 - baz * yy;
  const x2 = xvx * xvx + xvy * xvy + xvz * xvz;
  const y2 = yy * yy * l2;
  const z2 = zz * zz * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - p.r2;
  if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - p.r1;
  return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - p.r1;
}

function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

class Field {
  /** Active subset of primitives (spatially local), defaults to all. */
  active: Prim[];
  constructor(readonly prims: Prim[]) {
    this.active = prims;
  }

  sd(x: number, y: number, z: number): number {
    let d = 1;
    let carve = false;
    for (const p of this.active) {
      if (x < p.min[0] || y < p.min[1] || z < p.min[2] || x > p.max[0] || y > p.max[1] || z > p.max[2]) continue;
      if (p.neg) carve = true;
      else d = smin(d, sdPrim(p, x, y, z), p.k);
    }
    if (carve)
      for (const p of this.active) {
        if (!p.neg || x < p.min[0] || y < p.min[1] || z < p.min[2] || x > p.max[0] || y > p.max[1] || z > p.max[2]) continue;
        d = -smin(-d, sdPrim(p, x, y, z), p.k);
      }
    return d;
  }

  grad(x: number, y: number, z: number, e = 0.0007): [number, number, number] {
    // Tetrahedral gradient estimate.
    const a = this.sd(x + e, y - e, z - e);
    const b = this.sd(x - e, y - e, z + e);
    const c = this.sd(x - e, y + e, z - e);
    const d = this.sd(x + e, y + e, z + e);
    const gx = a - b - c + d, gy = -a - b + c + d, gz = -a + b - c + d;
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  }

  /** Two closest materials and the bone of the closest primitive. */
  material(x: number, y: number, z: number): { a: number; b: number; wa: number; bone: number } {
    const best = new Float64Array(BODY_MATS.length).fill(Infinity);
    let bone = 0;
    let bestD = Infinity;
    for (const p of this.active) {
      if (p.neg) continue;
      const d = sdPrim(p, x, y, z) - (p.k < 0.015 ? 0.0015 : 0); // garment edges win ties
      const m = BODY_MATS.indexOf(p.mat);
      if (d < best[m]) best[m] = d;
      if (d < bestD) {
        bestD = d;
        bone = p.bone;
      }
    }
    let a = 0, b = 0;
    for (let m = 0; m < best.length; m++) if (best[m] < best[a]) a = m;
    b = a === 0 ? 1 : 0;
    for (let m = 0; m < best.length; m++) if (m !== a && best[m] < best[b]) b = m;
    const gap = best[b] - best[a];
    const s = Math.min(1, Math.max(0, gap / 0.003));
    return { a, b, wa: 1 - 0.5 * (1 - s * s * (3 - 2 * s)), bone };
  }
}

export interface BodyMesh {
  geometry: THREE.BufferGeometry;
  /** Material order matching geometry groups. */
  mats: BodyMat[];
  /** Per-vertex material blend (primary, secondary) and primary weight. */
  vmats: Uint8Array;
  vmatW: Float32Array;
}

/** Transferable result of body generation (worker friendly). */
export interface BodyArrays {
  position: Float32Array;
  normal: Float32Array;
  /** Baked ambient occlusion (r=g=b). */
  color: Float32Array;
  /** Per-vertex material blend: primary id, secondary id. */
  mats: Uint8Array;
  /** Weight of the primary material (0.5..1). */
  matW: Float32Array;
  skinIndex: Uint16Array;
  skinWeight: Float32Array;
  index: Uint32Array;
  groups: { start: number; count: number; mat: BodyMat }[];
}

const cache = new Map<string, BodyMesh>();

export function geometryFromArrays(a: BodyArrays): BodyMesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(a.color, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(a.skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(a.skinWeight, 4));
  geo.setIndex(new THREE.BufferAttribute(a.index, 1));
  a.groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));
  geo.computeBoundingSphere();
  return { geometry: geo, mats: a.groups.map((g) => g.mat), vmats: a.mats, vmatW: a.matW };
}

/** Body options: the build and an optional finer voxel size for the head and face. */
export interface BodyOptions {
  build?: Build;
  /** Voxel size (metres) used around the head; 0 = the same as the body. */
  fine?: number;
}

/** Build the body synchronously (cached). */
export function buildBody(pose: Pose = 'standing', cell = 0.0075, opts: BodyOptions = {}): BodyMesh {
  const key = `${pose}|${cell}|${opts.build ?? 'male'}|${opts.fine ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = geometryFromArrays(buildBodyArrays(pose, cell, opts));
  cache.set(key, out);
  return out;
}

const fields = new Map<string, Field>();

/**
 * Where a ray from `origin` along `dir` first meets the sculpted body
 * (bind pose), for fitting trims such as buttons and a buckle to it.
 */
export function probeSurface(origin: [number, number, number], dir: [number, number, number], build: Build = 'male', pose: Pose = 'standing'): THREE.Vector3 | null {
  const key = `${pose}|${build}`;
  let F = fields.get(key);
  if (!F) fields.set(key, (F = new Field(sculpt(pose, build))));
  const l = Math.hypot(...dir);
  let t = 0;
  for (let i = 0; i < 200 && t < 3; i++) {
    const x = origin[0] + (dir[0] / l) * t, y = origin[1] + (dir[1] / l) * t, z = origin[2] + (dir[2] / l) * t;
    const d = F.sd(x, y, z);
    if (d < 0.0002) return new THREE.Vector3(x, y, z);
    t += Math.max(d * 0.9, 0.0003);
  }
  return null;
}

/** Build the body off the main thread when workers are available. */
export async function loadBody(pose: Pose, cell: number, opts: BodyOptions = {}): Promise<BodyMesh> {
  const key = `${pose}|${cell}|${opts.build ?? 'male'}|${opts.fine ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let arrays: BodyArrays;
  try {
    const worker = new Worker(new URL('./bodyWorker.ts', import.meta.url), { type: 'module' });
    arrays = await new Promise<BodyArrays>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<BodyArrays>) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage({ pose, cell, opts });
    });
    worker.terminate();
  } catch {
    arrays = buildBodyArrays(pose, cell, opts);
  }
  const out = geometryFromArrays(arrays);
  cache.set(key, out);
  return out;
}

/** Region sampled at the finer voxel size: the head and face. */
const FINE_BOX: [V3, V3] = [[-0.096, 1.52, -0.12], [0.096, 1.82, 0.13]];

/** Grid coordinates along one axis: `cell` spacing, `fine` spacing inside [f0, f1). */
function axisCoords(lo: number, hi: number, cell: number, fine: number, f0: number, f1: number): Float64Array {
  const out: number[] = [];
  let v = lo - cell;
  while (v < hi + cell) {
    out.push(v);
    const inFine = fine > 0 && v >= f0 - 1e-9 && v < f1;
    let step = inFine ? fine : cell;
    // Land exactly on the fine region's start.
    if (!inFine && fine > 0 && v < f0 && v + step > f0) step = f0 - v;
    v += step;
  }
  out.push(v);
  return Float64Array.from(out);
}

/**
 * Generate the body. `cell` is the voxel size (metres); smaller is smoother.
 * With `opts.fine`, the head and face are sampled on a finer grid (the grid
 * stays rectilinear, so the surface is still one seamless mesh).
 * Produces position, normal, color (baked AO), skinIndex/skinWeight and one
 * index range per material.
 */
export function buildBodyArrays(pose: Pose = 'standing', cell = 0.0075, opts: BodyOptions = {}): BodyArrays {
  const build = opts.build ?? 'male';
  const fine = opts.fine && opts.fine < cell ? opts.fine : 0;
  const bones = bonesFor(build);
  const prims = sculpt(pose, build);
  const F = new Field(prims);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.min[i]);
      max[i] = Math.max(max[i], p.max[i]);
    }
  const xs = axisCoords(min[0], max[0], cell, fine, FINE_BOX[0][0], FINE_BOX[1][0]);
  const ys = axisCoords(min[1], max[1], cell, fine, FINE_BOX[0][1], FINE_BOX[1][1]);
  const zs = axisCoords(min[2], max[2], cell, fine, FINE_BOX[0][2], FINE_BOX[1][2]);
  const nx = xs.length, ny = ys.length, nz = zs.length;
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // Narrow band: coarse pass at block corners, then refine blocks near the surface.
  const B = 4;
  const cx = Math.ceil((nx - 1) / B) + 1, cy = Math.ceil((ny - 1) / B) + 1, cz = Math.ceil((nz - 1) / B) + 1;
  const at = (arr: Float64Array, i: number) => arr[Math.min(arr.length - 1, i)];
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) coarse[(k * cy + j) * cx + i] = F.sd(at(xs, i * B), at(ys, j * B), at(zs, k * B));
  const val = new Float32Array(nx * ny * nz);
  const band = B * cell * 1.9;
  const LOCAL = 0.075;
  const listFor = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    prims.filter((p) => !(x1 + LOCAL < p.min[0] || y1 + LOCAL < p.min[1] || z1 + LOCAL < p.min[2] || x0 - LOCAL > p.max[0] || y0 - LOCAL > p.max[1] || z0 - LOCAL > p.max[2]));
  const blockLists = new Map<number, Prim[]>();
  const blockKey = (bi: number, bj: number, bk: number) => (bk * cy + bj) * cx + bi;
  for (let bk = 0; bk < cz - 1; bk++)
    for (let bj = 0; bj < cy - 1; bj++)
      for (let bi = 0; bi < cx - 1; bi++) {
        let near = false;
        let sgn = 0;
        for (let c = 0; c < 8; c++) {
          const v = coarse[((bk + (c >> 2)) * cy + bj + ((c >> 1) & 1)) * cx + bi + (c & 1)];
          if (Math.abs(v) < band) near = true;
          sgn += v;
        }
        if (near) {
          const list = listFor(at(xs, bi * B), at(ys, bj * B), at(zs, bk * B), at(xs, bi * B + B), at(ys, bj * B + B), at(zs, bk * B + B));
          blockLists.set(blockKey(bi, bj, bk), list);
          F.active = list;
        }
        for (let k = bk * B; k < Math.min(nz, bk * B + B + 1); k++)
          for (let j = bj * B; j < Math.min(ny, bj * B + B + 1); j++)
            for (let i = bi * B; i < Math.min(nx, bi * B + B + 1); i++) {
              const n = idx(i, j, k);
              if (near) val[n] = F.sd(xs[i], ys[j], zs[k]);
              else if (val[n] === 0) val[n] = sgn < 0 ? -band : band;
            }
      }

  F.active = prims;
  // Surface nets: one vertex per sign-changing cell.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cIdx = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
  const vBlock: number[] = [];
  const corner = new Float32Array(8);
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let neg = 0;
        for (let c = 0; c < 8; c++) {
          const v = val[idx(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2))];
          corner[c] = v;
          if (v < 0) neg++;
        }
        if (neg === 0 || neg === 8) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          sx += (a & 1) + ((b & 1) - (a & 1)) * t;
          sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
          sz += (a >> 2) + ((b >> 2) - (a >> 2)) * t;
          cnt++;
        }
        cellVert[cIdx(i, j, k)] = pos.length / 3;
        pos.push(xs[i] + (xs[i + 1] - xs[i]) * (sx / cnt), ys[j] + (ys[j + 1] - ys[j]) * (sy / cnt), zs[k] + (zs[k + 1] - zs[k]) * (sz / cnt));
        vBlock.push(blockKey(Math.floor(i / B), Math.floor(j / B), Math.floor(k / B)));
      }
  const index: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) index.push(a, c, b, a, d, c);
    else index.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = val[idx(i, j, k)] < 0;
        // X edge (i,j,k)-(i+1,j,k): cells around share j-1..j, k-1..k
        if (i < nx - 1 && v0 !== val[idx(i + 1, j, k)] < 0)
          quad(cellVert[cIdx(i, j - 1, k - 1)], cellVert[cIdx(i, j, k - 1)], cellVert[cIdx(i, j, k)], cellVert[cIdx(i, j - 1, k)], v0);
        if (j < ny - 1 && v0 !== val[idx(i, j + 1, k)] < 0)
          quad(cellVert[cIdx(i - 1, j, k - 1)], cellVert[cIdx(i - 1, j, k)], cellVert[cIdx(i, j, k)], cellVert[cIdx(i, j, k - 1)], v0);
        if (k < nz - 1 && v0 !== val[idx(i, j, k + 1)] < 0)
          quad(cellVert[cIdx(i - 1, j - 1, k)], cellVert[cIdx(i, j - 1, k)], cellVert[cIdx(i, j, k)], cellVert[cIdx(i - 1, j, k)], v0);
      }

  // Project onto the exact field; normals, materials, AO, skinning.
  const nv = pos.length / 3;
  const normals = new Float32Array(nv * 3);
  const colors = new Float32Array(nv * 3);
  const skinI = new Uint16Array(nv * 4);
  const skinW = new Float32Array(nv * 4);
  const vmat = new Uint8Array(nv);
  const vmats = new Uint8Array(nv * 2);
  const vmatW = new Float32Array(nv);
  const children: number[][] = bones.map(() => []);
  bones.forEach((b, i) => b.parent >= 0 && children[b.parent].push(i));
  for (let v = 0; v < nv; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    F.active = blockLists.get(vBlock[v]) ?? prims;
    for (let it = 0; it < 2; it++) {
      const d = F.sd(x, y, z);
      const g = F.grad(x, y, z);
      x -= g[0] * d;
      y -= g[1] * d;
      z -= g[2] * d;
    }
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = z;
    const n = F.grad(x, y, z);
    normals.set(n, v * 3);
    // Ambient occlusion from the field.
    let occ = 0;
    let w = 1;
    for (let s = 1; s <= 5; s++) {
      const hh = 0.012 * s;
      occ += w * (hh - F.sd(x + n[0] * hh, y + n[1] * hh, z + n[2] * hh));
      w *= 0.55;
    }
    const ao = Math.max(0.35, Math.min(1, 1 - occ * 9));
    colors[v * 3] = colors[v * 3 + 1] = colors[v * 3 + 2] = ao;
    const m = F.material(x, y, z);
    vmat[v] = m.a;
    vmats[v * 2] = m.a;
    vmats[v * 2 + 1] = m.b;
    vmatW[v] = m.wa;
    // Skin weights among the owning bone, its parent and children.
    const cand = [m.bone, ...(bones[m.bone].parent >= 0 ? [bones[m.bone].parent] : []), ...children[m.bone]];
    const ws = cand.map((bi) => {
      const b = bones[bi];
      const d = segDist(x, y, z, b.head, b.tail);
      return { bi, w: 1 / (Math.pow(d, 5) + 1e-12) };
    });
    ws.sort((p, q) => q.w - p.w);
    const top = ws.slice(0, 4);
    const sum = top.reduce((s, t) => s + t.w, 0);
    top.forEach((t, k) => {
      skinI[v * 4 + k] = t.bi;
      skinW[v * 4 + k] = t.w / sum;
    });
  }
  // Orient every triangle with the field normal.
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const e1x = pos[b * 3] - pos[a * 3], e1y = pos[b * 3 + 1] - pos[a * 3 + 1], e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
    const e2x = pos[c * 3] - pos[a * 3], e2y = pos[c * 3 + 1] - pos[a * 3 + 1], e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const nx2 = normals[a * 3] + normals[b * 3] + normals[c * 3];
    const ny2 = normals[a * 3 + 1] + normals[b * 3 + 1] + normals[c * 3 + 1];
    const nz2 = normals[a * 3 + 2] + normals[b * 3 + 2] + normals[c * 3 + 2];
    if (fx * nx2 + fy * ny2 + fz * nz2 < 0) {
      index[t + 1] = c;
      index[t + 2] = b;
    }
  }
  // Groups by material (majority vote per triangle).
  const byMat: number[][] = BODY_MATS.map(() => []);
  for (let t = 0; t < index.length; t += 3) {
    const a = vmat[index[t]], b = vmat[index[t + 1]], c = vmat[index[t + 2]];
    const m = a === b || a === c ? a : b === c ? b : Math.min(a, b, c);
    byMat[m].push(index[t], index[t + 1], index[t + 2]);
  }
  const ordered: number[] = [];
  const groups: BodyArrays['groups'] = [];
  byMat.forEach((tris, m) => {
    if (!tris.length) return;
    groups.push({ start: ordered.length, count: tris.length, mat: BODY_MATS[m] });
    for (const i of tris) ordered.push(i);
  });
  return {
    position: Float32Array.from(pos),
    normal: normals,
    color: colors,
    mats: vmats,
    matW: vmatW,
    skinIndex: skinI,
    skinWeight: skinW,
    index: Uint32Array.from(ordered),
    groups,
  };
}

function segDist(x: number, y: number, z: number, a: V3, b: V3): number {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz;
  let t = ((x - a[0]) * bx + (y - a[1]) * by + (z - a[2]) * bz) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - a[0] - bx * t, y - a[1] - by * t, z - a[2] - bz * t);
}

/** Bones for the bind pose, parented like the definition. */
export function buildSkeleton(build: Build = 'male'): { bones: THREE.Bone[]; skeleton: THREE.Skeleton } {
  const defs = bonesFor(build);
  const bones = defs.map((d) => {
    const b = new THREE.Bone();
    b.name = d.name;
    return b;
  });
  defs.forEach((d, i) => {
    const p = d.parent >= 0 ? defs[d.parent].head : [0, 0, 0];
    bones[i].position.set(d.head[0] - p[0], d.head[1] - p[1], d.head[2] - p[2]);
    if (d.parent >= 0) bones[d.parent].add(bones[i]);
  });
  return { bones, skeleton: new THREE.Skeleton(bones) };
}
