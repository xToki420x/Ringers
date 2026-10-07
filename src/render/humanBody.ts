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

/** Bind-pose skeleton (metres, facing +Z, left side = +X). */
export const BONES: BoneDef[] = (() => {
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
    b.push({ name: `upperArm${side}`, head: [s * 0.192, 1.405, -0.005], tail: [s * 0.24, 1.13, -0.015], parent: 2 });
    b.push({ name: `forearm${side}`, head: [s * 0.24, 1.13, -0.015], tail: [s * 0.272, 0.885, 0.012], parent: ua });
    b.push({ name: `hand${side}`, head: [s * 0.272, 0.885, 0.012], tail: [s * 0.282, 0.78, 0.022], parent: ua + 1 });
  }
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const th = b.length;
    b.push({ name: `thigh${side}`, head: [s * 0.093, 0.93, 0], tail: [s * 0.1, 0.5, 0.012], parent: 0 });
    b.push({ name: `shin${side}`, head: [s * 0.1, 0.5, 0.012], tail: [s * 0.1, 0.088, -0.022], parent: th });
    b.push({ name: `foot${side}`, head: [s * 0.1, 0.088, -0.022], tail: [s * 0.106, 0.03, 0.13], parent: th + 1 });
  }
  return b;
})();

export const BONE = Object.fromEntries(BONES.map((b, i) => [b.name, i])) as Record<string, number>;

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

/** Sculpt: anatomy plus clothing as slightly proud shapes. */
function sculpt(pose: Pose): Prim[] {
  const P: Prim[] = [];
  const B = BONE;
  // Torso in a polo shirt, tucked into jeans.
  P.push(ell([0, 1.33, -0.005], [0.158, 0.145, 0.108], 'shirt', B.chest, 0.05));
  P.push(cone([-0.15, 1.405, -0.012], [0.15, 1.405, -0.012], 0.068, 0.068, 'shirt', B.chest, 0.05));
  P.push(ell([0, 1.15, 0.006], [0.142, 0.15, 0.1], 'shirt', B.spine, 0.06));
  P.push(ell([0, 1.03, 0.004], [0.148, 0.07, 0.102], 'shirt', B.hips, 0.04));
  P.push(ell([0, 1.27, 0.07], [0.12, 0.08, 0.05], 'shirt', B.chest, 0.05)); // pecs
  P.push(ell([0, 1.3, -0.075], [0.13, 0.1, 0.045], 'shirt', B.chest, 0.05)); // shoulder blades
  for (const s of [1, -1]) P.push(ell([s * 0.085, 1.44, -0.018], [0.075, 0.042, 0.055], 'shirt', B.chest, 0.04)); // trapezius
  // Collar.
  P.push(ell([0, 1.46, -0.004], [0.07, 0.022, 0.066], 'shirt', B.chest, 0.012));
  // Belt and jeans.
  P.push(ell([0, 0.965, 0.002], [0.152, 0.024, 0.106], 'belt', B.hips, 0.008));
  P.push(ell([0, 0.9, 0], [0.155, 0.09, 0.105], 'pants', B.hips, 0.04));
  for (const s of [1, -1]) P.push(ell([s * 0.06, 0.865, -0.05], [0.078, 0.085, 0.068], 'pants', B.hips, 0.04));
  // Neck and head.
  P.push(cone([0, 1.43, -0.005], [0, 1.575, 0.008], 0.054, 0.05, 'skin', B.neck, 0.03));
  P.push(ell([0, 1.665, 0.008], [0.079, 0.102, 0.094], 'skin', B.head, 0.03));
  P.push(ell([0, 1.605, 0.034], [0.064, 0.058, 0.066], 'skin', B.head, 0.04)); // jaw
  P.push(ell([0, 1.645, 0.1], [0.013, 0.022, 0.018], 'skin', B.head, 0.012)); // nose
  P.push(ell([0, 1.69, 0.085], [0.06, 0.016, 0.02], 'skin', B.head, 0.02)); // brow
  for (const s of [1, -1]) P.push(ell([s * 0.079, 1.648, -0.004], [0.011, 0.027, 0.019], 'skin', B.head, 0.01)); // ears
  // Short hair below the cap line.
  P.push(ell([0, 1.665, -0.018], [0.083, 0.088, 0.088], 'hair', B.head, 0.01));
  // Arms.
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    const ua = BONES[B[`upperArm${side}`]];
    const fa = BONES[B[`forearm${side}`]];
    const hd = BONES[B[`hand${side}`]];
    P.push(ell([s * 0.19, 1.398, -0.006], [0.066, 0.062, 0.068], 'shirt', B[`upperArm${side}`], 0.045)); // deltoid
    P.push(cone(ua.head, ua.tail, 0.052, 0.04, 'skin', B[`upperArm${side}`], 0.025));
    P.push(ell(lerp3(ua.head, ua.tail, 0.45), [0.05, 0.075, 0.052], 'skin', B[`upperArm${side}`], 0.03)); // biceps
    P.push(cone(ua.head, lerp3(ua.head, ua.tail, 0.5), 0.062, 0.058, 'shirt', B[`upperArm${side}`], 0.006)); // sleeve
    P.push(cone(fa.head, fa.tail, 0.041, 0.029, 'skin', B[`forearm${side}`], 0.02));
    P.push(ell(lerp3(fa.head, fa.tail, 0.28), [0.047, 0.07, 0.044], 'skin', B[`forearm${side}`], 0.03)); // forearm muscle
    const palm = lerp3(hd.head, hd.tail, 0.5);
    P.push(ell(palm, [0.021, 0.047, 0.042], 'skin', B[`hand${side}`], 0.02));
    P.push(ell([palm[0] - s * 0.002, palm[1] - 0.045, palm[2] + 0.006], [0.018, 0.026, 0.036], 'skin', B[`hand${side}`], 0.015)); // fingers
    P.push(ell([palm[0] - s * 0.012, palm[1] + 0.005, palm[2] + 0.04], [0.013, 0.03, 0.014], 'skin', B[`hand${side}`], 0.012)); // thumb
  }
  // Legs (or seated legs for spectators).
  for (const s of [1, -1]) {
    const side = s > 0 ? 'L' : 'R';
    let th = BONES[B[`thigh${side}`]];
    let sh = BONES[B[`shin${side}`]];
    let ft = BONES[B[`foot${side}`]];
    if (pose === 'seated') {
      const knee: V3 = [s * 0.11, 0.9, 0.42];
      const ankle: V3 = [s * 0.11, 0.48, 0.45];
      th = { ...th, tail: knee };
      sh = { ...sh, head: knee, tail: ankle };
      ft = { ...ft, head: ankle, tail: [s * 0.115, 0.43, 0.6] };
    }
    P.push(cone(th.head, th.tail, 0.085, 0.057, 'pants', B[`thigh${side}`], 0.03));
    P.push(cone(sh.head, sh.tail, 0.058, 0.047, 'pants', B[`shin${side}`], 0.02));
    P.push(ell(lerp3(sh.head, sh.tail, 0.12), [0.06, 0.06, 0.06], 'pants', B[`shin${side}`], 0.03)); // knee
    // Sneakers.
    const toe = ft.tail;
    const heel = ft.head;
    const fwd = lerp3(heel, toe, 0.5);
    const lowY = pose === 'seated' ? 0 : -0.04;
    P.push(ell([heel[0], heel[1] + lowY, heel[2] - 0.005], [0.044, 0.046, 0.055], 'shoe', B[`foot${side}`], 0.03));
    P.push(ell([fwd[0], fwd[1] + lowY * 0.4, fwd[2]], [0.047, 0.04, 0.095], 'shoe', B[`foot${side}`], 0.03));
    P.push(ell([toe[0], toe[1] + 0.002, toe[2] - 0.01], [0.042, 0.03, 0.045], 'shoe', B[`foot${side}`], 0.025));
    P.push(ell([fwd[0], heel[1] + lowY - 0.034, fwd[2] - 0.002], [0.05, 0.012, 0.14], 'sole', B[`foot${side}`], 0.006));
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
    for (const p of this.active) {
      if (x < p.min[0] || y < p.min[1] || z < p.min[2] || x > p.max[0] || y > p.max[1] || z > p.max[2]) continue;
      d = smin(d, sdPrim(p, x, y, z), p.k);
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

/** Build the body synchronously (cached). */
export function buildBody(pose: Pose = 'standing', cell = 0.0075): BodyMesh {
  const key = `${pose}|${cell}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = geometryFromArrays(buildBodyArrays(pose, cell));
  cache.set(key, out);
  return out;
}

/** Build the body off the main thread when workers are available. */
export async function loadBody(pose: Pose, cell: number): Promise<BodyMesh> {
  const key = `${pose}|${cell}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let arrays: BodyArrays;
  try {
    const worker = new Worker(new URL('./bodyWorker.ts', import.meta.url), { type: 'module' });
    arrays = await new Promise<BodyArrays>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<BodyArrays>) => resolve(e.data);
      worker.onerror = (e) => reject(e);
      worker.postMessage({ pose, cell });
    });
    worker.terminate();
  } catch {
    arrays = buildBodyArrays(pose, cell);
  }
  const out = geometryFromArrays(arrays);
  cache.set(key, out);
  return out;
}

/**
 * Generate the body. `cell` is the voxel size (metres); smaller is smoother.
 * Produces position, normal, color (baked AO), skinIndex/skinWeight and one
 * index range per material.
 */
export function buildBodyArrays(pose: Pose = 'standing', cell = 0.0075): BodyArrays {
  const prims = sculpt(pose);
  const F = new Field(prims);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.min[i]);
      max[i] = Math.max(max[i], p.max[i]);
    }
  const h = cell;
  const nx = Math.ceil((max[0] - min[0]) / h) + 2;
  const ny = Math.ceil((max[1] - min[1]) / h) + 2;
  const nz = Math.ceil((max[2] - min[2]) / h) + 2;
  const ox = min[0] - h, oy = min[1] - h, oz = min[2] - h;
  const idx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;

  // Narrow band: coarse pass, then refine blocks near the surface.
  const B = 4;
  const cx = Math.ceil(nx / B) + 1, cy = Math.ceil(ny / B) + 1, cz = Math.ceil(nz / B) + 1;
  const coarse = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) coarse[(k * cy + j) * cx + i] = F.sd(ox + i * B * h, oy + j * B * h, oz + k * B * h);
  const val = new Float32Array(nx * ny * nz);
  const band = B * h * 1.9;
  const blockSize = B * h;
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
          const x0 = ox + bi * blockSize, y0 = oy + bj * blockSize, z0 = oz + bk * blockSize;
          const list = listFor(x0, y0, z0, x0 + blockSize, y0 + blockSize, z0 + blockSize);
          blockLists.set(blockKey(bi, bj, bk), list);
          F.active = list;
        }
        for (let k = bk * B; k < Math.min(nz, bk * B + B + 1); k++)
          for (let j = bj * B; j < Math.min(ny, bj * B + B + 1); j++)
            for (let i = bi * B; i < Math.min(nx, bi * B + B + 1); i++) {
              const n = idx(i, j, k);
              if (near) val[n] = F.sd(ox + i * h, oy + j * h, oz + k * h);
              else if (val[n] === 0) val[n] = sgn < 0 ? -band : band;
            }
      }

  F.active = prims;
  // Surface nets: one vertex per sign-changing cell.
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cIdx = (i: number, j: number, k: number) => (k * (ny - 1) + j) * (nx - 1) + i;
  const pos: number[] = [];
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
        pos.push(ox + (i + sx / cnt) * h, oy + (j + sy / cnt) * h, oz + (k + sz / cnt) * h);
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
  const children: number[][] = BONES.map(() => []);
  BONES.forEach((b, i) => b.parent >= 0 && children[b.parent].push(i));
  for (let v = 0; v < nv; v++) {
    let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    const bkey = blockKey(Math.floor((x - ox) / blockSize), Math.floor((y - oy) / blockSize), Math.floor((z - oz) / blockSize));
    F.active = blockLists.get(bkey) ?? prims;
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
    const cand = [m.bone, ...(BONES[m.bone].parent >= 0 ? [BONES[m.bone].parent] : []), ...children[m.bone]];
    const ws = cand.map((bi) => {
      const b = BONES[bi];
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
export function buildSkeleton(): { bones: THREE.Bone[]; skeleton: THREE.Skeleton } {
  const bones = BONES.map((d) => {
    const b = new THREE.Bone();
    b.name = d.name;
    return b;
  });
  BONES.forEach((d, i) => {
    const p = d.parent >= 0 ? BONES[d.parent].head : [0, 0, 0];
    bones[i].position.set(d.head[0] - p[0], d.head[1] - p[1], d.head[2] - p[2]);
    if (d.parent >= 0) bones[d.parent].add(bones[i]);
  });
  return { bones, skeleton: new THREE.Skeleton(bones) };
}
