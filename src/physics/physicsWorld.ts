import { Quaternion, Vector3 } from 'three';
import { BOX, GRAVITY, HALF_COURT, PIT, STAKE } from '../core/constants';
import { shoeTraits, type Loadout } from '../core/equipment';
import { shoeGeometry, type ShoeGeometry } from '../core/shoeShape';

/**
 * Purpose-built rigid-body simulation for horseshoe pitching.
 *
 * Shoes are rigid bodies with a full inertia tensor integrated from their
 * forged shape (gyroscopic precession included), collided through a
 * sphere-swept proxy of the band, calks and hooks. Contacts are resolved
 * with a warm-started sequential-impulse solver with Coulomb friction and
 * per-material restitution. The loose pit fill is modelled as a firm base a
 * little below the raked surface plus depth-proportional plowing drag.
 * Fast-moving shoes near anything solid are sub-stepped so they cannot
 * tunnel through the 1-inch stake.
 */

export type PitMaterial = 'sand' | 'clay';

export interface PitTuning {
  /** How far below the raked surface the firm base sits. */
  sink: number;
  /** Plowing drag (1/(m·s)), scaled by penetration depth. */
  dragH: number;
  dragV: number;
  friction: number;
}

export const PIT_TUNING: Record<PitMaterial, PitTuning> = {
  sand: { sink: 0.011, dragH: 5200, dragV: 2600, friction: 0.85 },
  clay: { sink: 0.0045, dragH: 34000, dragV: 12000, friction: 1.15 },
};

export interface StakeInfo {
  end: 0 | 1;
  base: Vector3;
  top: Vector3;
  axis: Vector3;
  radius: number;
}

export type ContactKind = 'stake' | 'shoe' | 'pit' | 'board' | 'ground' | 'backboard';

export interface ContactEvent {
  kind: ContactKind;
  shoeId: number;
  otherShoeId?: number;
  /** Approach speed along the contact normal (m/s). */
  speed: number;
  position: Vector3;
  end?: 0 | 1;
}

export interface ShoeState {
  position: Vector3;
  quaternion: Quaternion;
  linvel: Vector3;
  angvel: Vector3;
}

export const PHYSICS_DT = 1 / 480;
const LAWN_Y = -0.03;
const MAX_SUBSTEPS = 10;
const SOLVER_ITERS = 8;
const SLOP = 0.0005;
const GROUND_CODE = 63;
const PIT_CODE = 62;

export function stakeZ(end: 0 | 1): number {
  return end === 0 ? -HALF_COURT : HALF_COURT;
}

export function makeStake(end: 0 | 1): StakeInfo {
  const z = stakeZ(end);
  const towardOpp = end === 0 ? 1 : -1;
  const axis = new Vector3(0, Math.cos(STAKE.lean), towardOpp * Math.sin(STAKE.lean)).normalize();
  const base = new Vector3(0, 0, z);
  const top = base.clone().addScaledVector(axis, STAKE.height / Math.cos(STAKE.lean));
  return { end, base, top, axis, radius: STAKE.radius };
}

interface StaticBox {
  code: number;
  kind: ContactKind;
  end?: 0 | 1;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  mu: number;
  e: number;
}

interface StaticCapsule {
  code: number;
  end: 0 | 1;
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  r: number;
  mu: number;
}

const tmp9 = new Float64Array(9);

function quatToMat(x: number, y: number, z: number, w: number, m: Float64Array) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = 1 - (yy + zz); m[1] = xy - wz; m[2] = xz + wy;
  m[3] = xy + wz; m[4] = 1 - (xx + zz); m[5] = yz - wx;
  m[6] = xz - wy; m[7] = yz + wx; m[8] = 1 - (xx + yy);
}

function invert3(a: Float64Array, out: Float64Array) {
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const id = 1 / (a00 * b01 + a01 * b11 + a02 * b21);
  out[0] = b01 * id;
  out[1] = (-a22 * a01 + a02 * a21) * id;
  out[2] = (a12 * a01 - a02 * a11) * id;
  out[3] = b11 * id;
  out[4] = (a22 * a00 - a02 * a20) * id;
  out[5] = (-a12 * a00 + a02 * a10) * id;
  out[6] = b21 * id;
  out[7] = (-a21 * a00 + a01 * a20) * id;
  out[8] = (a11 * a00 - a01 * a10) * id;
}

/** n · ((I⁻¹ (r × n)) × r) = (r × n) · I⁻¹ (r × n) */
function angTerm(I: Float64Array, rx: number, ry: number, rz: number, nx: number, ny: number, nz: number): number {
  const cx = ry * nz - rz * ny;
  const cy = rz * nx - rx * nz;
  const cz = rx * ny - ry * nx;
  return cx * (I[0] * cx + I[1] * cy + I[2] * cz) + cy * (I[3] * cx + I[4] * cy + I[5] * cz) + cz * (I[6] * cx + I[7] * cy + I[8] * cz);
}

/** A dynamic shoe. Position/orientation refer to the centre of mass. */
export class ShoeBody {
  readonly geom: ShoeGeometry;
  readonly mass: number;
  readonly invMass: number;
  /** Body-frame inertia and its inverse (row-major 3×3 about the COM). */
  readonly I = new Float64Array(9);
  readonly invI = new Float64Array(9);
  /** Shape origin relative to the COM, in body axes. */
  readonly originOffset = new Vector3();
  /** Collision spheres relative to the COM (x, y, z, r). */
  readonly spheres: Float64Array;
  readonly sphereCount: number;
  /** Coarse sphere subset for shoe-on-shoe contact. */
  readonly coarse: Uint16Array;
  /** Bottom sample points (COM-relative) for sand drag. */
  readonly sand: Float64Array;
  readonly boundR: number;
  readonly restitution: number;

  px = 0; py = 0; pz = 0;
  qx = 0; qy = 0; qz = 0; qw = 1;
  vx = 0; vy = 0; vz = 0;
  wx = 0; wy = 0; wz = 0;
  /** World rotation matrix and world inverse inertia (row-major). */
  readonly R = new Float64Array(9);
  readonly invIw = new Float64Array(9);
  /** World-space sphere centres. */
  readonly ws: Float64Array;
  /** World AABB of the collision proxy (minX, minY, minZ, maxX, maxY, maxZ). */
  readonly aabb = new Float64Array(6);

  sleeping = false;
  restTime = 0;
  age = 0;
  landed = false;
  touching = new Set<number>();

  constructor(
    readonly id: number,
    readonly owner: number,
    readonly loadout: Loadout,
  ) {
    this.geom = shoeGeometry(loadout.shape);
    const traits = shoeTraits(loadout);
    this.mass = traits.massKg;
    this.invMass = 1 / this.mass;
    this.restitution = traits.restitution;

    // Integrate mass properties over the forged shape.
    let W = 0, cx = 0, cy = 0, cz = 0;
    for (const s of this.geom.massSamples) {
      W += s.w;
      cx += s.x * s.w;
      cy += s.y * s.w;
      cz += s.z * s.w;
    }
    cx /= W; cy /= W; cz /= W;
    let ixx = 0, iyy = 0, izz = 0, ixy = 0, ixz = 0, iyz = 0;
    const scale = this.mass / W;
    for (const s of this.geom.massSamples) {
      const x = s.x - cx, y = s.y - cy, z = s.z - cz;
      const m = s.w * scale;
      ixx += m * (y * y + z * z);
      iyy += m * (x * x + z * z);
      izz += m * (x * x + y * y);
      ixy -= m * x * y;
      ixz -= m * x * z;
      iyz -= m * y * z;
    }
    this.I.set([ixx, ixy, ixz, ixy, iyy, iyz, ixz, iyz, izz]);
    invert3(this.I, this.invI);
    this.originOffset.set(-cx, -cy, -cz);

    const sp = this.geom.spheres;
    this.sphereCount = sp.length;
    this.spheres = new Float64Array(sp.length * 4);
    let br = 0;
    sp.forEach((s, i) => {
      this.spheres[i * 4] = s.x - cx;
      this.spheres[i * 4 + 1] = s.y - cy;
      this.spheres[i * 4 + 2] = s.z - cz;
      this.spheres[i * 4 + 3] = s.r;
      br = Math.max(br, Math.hypot(s.x - cx, s.y - cy, s.z - cz) + s.r);
    });
    this.boundR = br;
    this.ws = new Float64Array(sp.length * 3);
    const coarse: number[] = [];
    const bandR = this.geom.thickness / 2 - 1e-4;
    let band = 0;
    for (let i = 0; i < sp.length; i++) {
      if (sp[i].r < bandR) coarse.push(i);
      else if (band++ % 4 < 2) coarse.push(i); // every other pair of band spheres
    }
    this.coarse = Uint16Array.from(coarse);
    this.sand = new Float64Array(this.geom.bottomSamples.length * 3);
    this.geom.bottomSamples.forEach((b, i) => {
      this.sand[i * 3] = b.x - cx;
      this.sand[i * 3 + 1] = b.y - cy;
      this.sand[i * 3 + 2] = b.z - cz;
    });
  }

  updateDerived() {
    quatToMat(this.qx, this.qy, this.qz, this.qw, this.R);
    const R = this.R, A = this.invI, out = this.invIw, t = tmp9;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) t[i * 3 + j] = R[i * 3] * A[j] + R[i * 3 + 1] * A[3 + j] + R[i * 3 + 2] * A[6 + j];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) out[i * 3 + j] = t[i * 3] * R[j * 3] + t[i * 3 + 1] * R[j * 3 + 1] + t[i * 3 + 2] * R[j * 3 + 2];
    const s = this.spheres, ws = this.ws, bb = this.aabb;
    bb[0] = bb[1] = bb[2] = Infinity;
    bb[3] = bb[4] = bb[5] = -Infinity;
    for (let i = 0; i < this.sphereCount; i++) {
      const x = s[i * 4], y = s[i * 4 + 1], z = s[i * 4 + 2], r = s[i * 4 + 3];
      const wx = (ws[i * 3] = this.px + R[0] * x + R[1] * y + R[2] * z);
      const wy = (ws[i * 3 + 1] = this.py + R[3] * x + R[4] * y + R[5] * z);
      const wz = (ws[i * 3 + 2] = this.pz + R[6] * x + R[7] * y + R[8] * z);
      if (wx - r < bb[0]) bb[0] = wx - r;
      if (wy - r < bb[1]) bb[1] = wy - r;
      if (wz - r < bb[2]) bb[2] = wz - r;
      if (wx + r > bb[3]) bb[3] = wx + r;
      if (wy + r > bb[4]) bb[4] = wy + r;
      if (wz + r > bb[5]) bb[5] = wz + r;
    }
  }

  /** Shape-origin pose (what the renderer and the judges use). */
  pose(outP: Vector3, outQ: Quaternion) {
    outQ.set(this.qx, this.qy, this.qz, this.qw);
    const o = this.originOffset, R = this.R;
    outP.set(
      this.px + R[0] * o.x + R[1] * o.y + R[2] * o.z,
      this.py + R[3] * o.x + R[4] * o.y + R[5] * o.z,
      this.pz + R[6] * o.x + R[7] * o.y + R[8] * o.z,
    );
  }

  wake() {
    this.sleeping = false;
    this.restTime = 0;
  }
}

class Contact {
  a!: ShoeBody;
  b: ShoeBody | null = null;
  code = 0;
  key = 0;
  kind: ContactKind = 'ground';
  end: 0 | 1 | undefined = undefined;
  nx = 0; ny = 0; nz = 0;
  t1x = 0; t1y = 0; t1z = 0;
  t2x = 0; t2y = 0; t2z = 0;
  rax = 0; ray = 0; raz = 0;
  rbx = 0; rby = 0; rbz = 0;
  depth = 0;
  mu = 0.5;
  e = 0;
  kn = 0; kt1 = 0; kt2 = 0;
  bias = 0;
  jn = 0; jt1 = 0; jt2 = 0;
  approach = 0;
}

export class PhysicsWorld {
  readonly stakes: [StakeInfo, StakeInfo];
  readonly tuning: PitTuning;
  readonly shoes = new Map<number, ShoeBody>();
  private readonly boxes: StaticBox[] = [];
  private readonly capsules: StaticCapsule[] = [];
  private readonly pool: Contact[] = [];
  private nContacts = 0;
  private warm = new Map<number, [number, number, number]>();
  private nextWarm = new Map<number, [number, number, number]>();
  private eventsOut: ContactEvent[] = [];
  /** Substeps used by the last step (diagnostics). */
  lastSubsteps = 1;

  constructor(readonly pit: PitMaterial = 'sand') {
    this.tuning = PIT_TUNING[pit];
    this.stakes = [makeStake(0), makeStake(1)];
    this.buildCourt();
  }

  private buildCourt() {
    let code = 1;
    const box = (kind: ContactKind, end: 0 | 1, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, mu: number, e: number) =>
      this.boxes.push({ code: code++, kind, end, minX: cx - hx, minY: cy - hy, minZ: cz - hz, maxX: cx + hx, maxY: cy + hy, maxZ: cz + hz, mu, e });
    for (const end of [0, 1] as const) {
      const z = stakeZ(end);
      const back = end === 0 ? -1 : 1;
      const fw = BOX.frameWidth;
      const fh = 0.16;
      const top = 0.012;
      // Timber frame around the pit.
      box('board', end, 0, top - fh / 2, z - PIT.length / 2 - fw / 2, PIT.width / 2 + fw, fh / 2, fw / 2, 0.45, 0.2);
      box('board', end, 0, top - fh / 2, z + PIT.length / 2 + fw / 2, PIT.width / 2 + fw, fh / 2, fw / 2, 0.45, 0.2);
      box('board', end, -PIT.width / 2 - fw / 2, top - fh / 2, z, fw / 2, fh / 2, PIT.length / 2, 0.45, 0.2);
      box('board', end, PIT.width / 2 + fw / 2, top - fh / 2, z, fw / 2, fh / 2, PIT.length / 2, 0.45, 0.2);
      // Pitching platforms either side.
      for (const sx of [-1, 1]) {
        const hw = BOX.platformWidth / 2 - fw / 2;
        box('board', end, sx * (PIT.width / 2 + fw + hw), -0.05 + 0.004, z, hw, 0.05, BOX.length / 2, 0.55, 0.15);
      }
      box('backboard', end, 0, BOX.backboardHeight / 2 - 0.03, z + back * BOX.backboardDistance, BOX.width / 2, BOX.backboardHeight / 2, 0.025, 0.45, 0.25);
      const s = this.stakes[end];
      const below = s.base.clone().addScaledVector(s.axis, -STAKE.buried);
      const tip = s.top.clone().addScaledVector(s.axis, -STAKE.radius * 0.5);
      this.capsules.push({ code: code++, end, ax: below.x, ay: below.y, az: below.z, bx: tip.x, by: tip.y, bz: tip.z, r: STAKE.radius, mu: 0.22 });
    }
  }

  addShoe(id: number, owner: number, loadout: Loadout, state: ShoeState): ShoeBody {
    this.removeShoe(id);
    const b = new ShoeBody(id, owner, loadout);
    b.qx = state.quaternion.x;
    b.qy = state.quaternion.y;
    b.qz = state.quaternion.z;
    b.qw = state.quaternion.w;
    quatToMat(b.qx, b.qy, b.qz, b.qw, b.R);
    // COM = origin - R·originOffset
    const o = b.originOffset, R = b.R;
    const ox = R[0] * o.x + R[1] * o.y + R[2] * o.z;
    const oy = R[3] * o.x + R[4] * o.y + R[5] * o.z;
    const oz = R[6] * o.x + R[7] * o.y + R[8] * o.z;
    b.px = state.position.x - ox;
    b.py = state.position.y - oy;
    b.pz = state.position.z - oz;
    b.wx = state.angvel.x;
    b.wy = state.angvel.y;
    b.wz = state.angvel.z;
    // v_com = v_origin + ω × (com − origin)
    b.vx = state.linvel.x + (b.wy * -oz - b.wz * -oy);
    b.vy = state.linvel.y + (b.wz * -ox - b.wx * -oz);
    b.vz = state.linvel.z + (b.wx * -oy - b.wy * -ox);
    b.updateDerived();
    this.shoes.set(id, b);
    return b;
  }

  removeShoe(id: number) {
    this.shoes.delete(id);
  }

  clearShoes() {
    this.shoes.clear();
    this.warm.clear();
  }

  state(id: number, out?: ShoeState): ShoeState | null {
    const b = this.shoes.get(id);
    if (!b) return null;
    const o = out ?? { position: new Vector3(), quaternion: new Quaternion(), linvel: new Vector3(), angvel: new Vector3() };
    b.pose(o.position, o.quaternion);
    o.linvel.set(b.vx, b.vy, b.vz);
    o.angvel.set(b.wx, b.wy, b.wz);
    return o;
  }

  pitEnd(x: number, z: number): -1 | 0 | 1 {
    if (x < -PIT.width / 2 || x > PIT.width / 2) return -1;
    if (Math.abs(z + HALF_COURT) < PIT.length / 2) return 0;
    if (Math.abs(z - HALF_COURT) < PIT.length / 2) return 1;
    return -1;
  }

  /** Advance one fixed step (PHYSICS_DT), sub-stepping fast shoes near obstacles. */
  step(): ContactEvent[] {
    this.eventsOut = [];
    let n = 1;
    for (const b of this.shoes.values()) {
      if (b.sleeping) continue;
      if (b.py - b.boundR > 0.45) continue; // above stake tops and backboards
      const sweep = (Math.hypot(b.vx, b.vy, b.vz) + Math.hypot(b.wx, b.wy, b.wz) * b.boundR) * PHYSICS_DT;
      n = Math.max(n, Math.min(MAX_SUBSTEPS, Math.ceil(sweep / 0.0045)));
    }
    this.lastSubsteps = n;
    const h = PHYSICS_DT / n;
    for (let i = 0; i < n; i++) this.substep(h);
    for (const b of this.shoes.values()) b.age += PHYSICS_DT;
    return this.eventsOut;
  }

  private substep(h: number) {
    const bodies = [...this.shoes.values()];
    for (const b of bodies) {
      if (b.sleeping) continue;
      b.vy -= GRAVITY * h;
      b.updateDerived();
      this.applySand(b, h);
    }
    this.nContacts = 0;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.sleeping) continue;
      this.collideStatics(a, h);
      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const b = bodies[j];
        if (!b.sleeping && j < i) continue; // awake pairs only once
        this.collidePair(a, b, h);
      }
    }
    const cs = this.pool;
    const nc = this.nContacts;
    for (let k = 0; k < nc; k++) this.prepare(cs[k], h);
    for (let it = 0; it < SOLVER_ITERS; it++) for (let k = 0; k < nc; k++) this.solve(cs[k]);

    this.nextWarm.clear();
    for (let k = 0; k < nc; k++) {
      const c = cs[k];
      if (c.key) this.nextWarm.set(c.key, [c.jn, c.jt1, c.jt2]);
    }
    const swap = this.warm;
    this.warm = this.nextWarm;
    this.nextWarm = swap;

    this.emitEvents(bodies, nc);
    for (const b of bodies) if (!b.sleeping) this.integrate(b, h);
  }

  private emitEvents(bodies: ShoeBody[], nc: number) {
    const cs = this.pool;
    const touched = new Map<ShoeBody, Map<number, Contact>>();
    for (let k = 0; k < nc; k++) {
      const c = cs[k];
      if (c.depth < -0.0005) continue;
      let m = touched.get(c.a);
      if (!m) touched.set(c.a, (m = new Map()));
      const prev = m.get(c.code);
      if (!prev || c.approach > prev.approach) m.set(c.code, c);
    }
    for (const b of bodies) {
      if (b.sleeping) continue;
      const m = touched.get(b);
      const now = new Set<number>();
      if (m) {
        for (const [code, c] of m) {
          now.add(code);
          if (c.kind === 'pit' || c.kind === 'stake') b.landed = true;
          if (!b.touching.has(code)) {
            this.eventsOut.push({
              kind: c.kind,
              shoeId: b.id,
              otherShoeId: c.kind === 'shoe' ? code - 1000 : undefined,
              speed: c.approach,
              position: new Vector3(b.px + c.rax, b.py + c.ray, b.pz + c.raz),
              end: c.end,
            });
          }
        }
      }
      b.touching = now;
    }
  }

  private integrate(b: ShoeBody, h: number) {
    b.px += b.vx * h;
    b.py += b.vy * h;
    b.pz += b.vz * h;
    // Gyroscopic term (torque-free precession) in body frame: dω = −I⁻¹(ω × Iω)h.
    const R = b.R;
    const wbx = R[0] * b.wx + R[3] * b.wy + R[6] * b.wz;
    const wby = R[1] * b.wx + R[4] * b.wy + R[7] * b.wz;
    const wbz = R[2] * b.wx + R[5] * b.wy + R[8] * b.wz;
    const I = b.I, iI = b.invI;
    const Lx = I[0] * wbx + I[1] * wby + I[2] * wbz;
    const Ly = I[3] * wbx + I[4] * wby + I[5] * wbz;
    const Lz = I[6] * wbx + I[7] * wby + I[8] * wbz;
    const cx = wby * Lz - wbz * Ly;
    const cy = wbz * Lx - wbx * Lz;
    const cz = wbx * Ly - wby * Lx;
    const dwx = -(iI[0] * cx + iI[1] * cy + iI[2] * cz) * h;
    const dwy = -(iI[3] * cx + iI[4] * cy + iI[5] * cz) * h;
    const dwz = -(iI[6] * cx + iI[7] * cy + iI[8] * cz) * h;
    b.wx += R[0] * dwx + R[1] * dwy + R[2] * dwz;
    b.wy += R[3] * dwx + R[4] * dwy + R[5] * dwz;
    b.wz += R[6] * dwx + R[7] * dwy + R[8] * dwz;
    // Quaternion: q += ½ h (ω ⊗ q)
    const { qx, qy, qz, qw, wx, wy, wz } = b;
    const hh = 0.5 * h;
    let nx = qx + hh * (wx * qw + wy * qz - wz * qy);
    let ny = qy + hh * (wy * qw + wz * qx - wx * qz);
    let nz = qz + hh * (wz * qw + wx * qy - wy * qx);
    let nw = qw + hh * (-wx * qx - wy * qy - wz * qz);
    const l = Math.hypot(nx, ny, nz, nw);
    nx /= l; ny /= l; nz /= l; nw /= l;
    b.qx = nx; b.qy = ny; b.qz = nz; b.qw = nw;

    const lv = Math.hypot(b.vx, b.vy, b.vz);
    const av = Math.hypot(b.wx, b.wy, b.wz);
    if (lv < 0.035 && av < 0.4 && b.py < 0.5 && (b.touching.size > 0 || b.py < 0.03)) b.restTime += h;
    else b.restTime = 0;
    if (b.restTime > 0.3 || b.py < -2) {
      b.sleeping = true;
      b.vx = b.vy = b.vz = 0;
      b.wx = b.wy = b.wz = 0;
      b.updateDerived();
    }
  }

  /** Plowing resistance of the loose pit fill. */
  private applySand(b: ShoeBody, h: number) {
    if (b.py > 0.12) return;
    const T = this.tuning;
    const R = b.R, s = b.sand;
    const n = s.length / 3;
    const m = b.mass / n;
    let jx = 0, jy = 0, jz = 0, tx = 0, ty = 0, tz = 0;
    for (let i = 0; i < n; i++) {
      const lx = s[i * 3], ly = s[i * 3 + 1], lz = s[i * 3 + 2];
      const rx = R[0] * lx + R[1] * ly + R[2] * lz;
      const ry = R[3] * lx + R[4] * ly + R[5] * lz;
      const rz = R[6] * lx + R[7] * ly + R[8] * lz;
      const py = b.py + ry;
      if (py >= 0) continue;
      const px = b.px + rx, pz = b.pz + rz;
      if (this.pitEnd(px, pz) < 0) continue;
      const d = Math.min(-py, T.sink * 1.2);
      const vx = b.vx + b.wy * rz - b.wz * ry;
      const vy = b.vy + b.wz * rx - b.wx * rz;
      const vz = b.vz + b.wx * ry - b.wy * rx;
      const kh = Math.min(0.9, T.dragH * d * h) * m;
      const kv = vy < 0 ? Math.min(0.9, T.dragV * d * h) * m : 0;
      const ix = -vx * kh, iy = -vy * kv, iz = -vz * kh;
      jx += ix; jy += iy; jz += iz;
      tx += ry * iz - rz * iy;
      ty += rz * ix - rx * iz;
      tz += rx * iy - ry * ix;
    }
    if (jx || jy || jz) {
      b.vx += jx * b.invMass;
      b.vy += jy * b.invMass;
      b.vz += jz * b.invMass;
      const I = b.invIw;
      b.wx += I[0] * tx + I[1] * ty + I[2] * tz;
      b.wy += I[3] * tx + I[4] * ty + I[5] * tz;
      b.wz += I[6] * tx + I[7] * ty + I[8] * tz;
    }
  }

  private newContact(): Contact {
    let c = this.pool[this.nContacts];
    if (!c) {
      c = new Contact();
      this.pool.push(c);
    }
    this.nContacts++;
    c.b = null;
    c.end = undefined;
    c.key = 0;
    return c;
  }

  private addStaticContact(
    a: ShoeBody, sphere: number, code: number, kind: ContactKind, end: 0 | 1 | undefined,
    nx: number, ny: number, nz: number, px: number, py: number, pz: number,
    depth: number, mu: number, e: number,
  ) {
    const c = this.newContact();
    c.a = a;
    c.code = code;
    c.key = (a.id * 512 + sphere) * 64 + code + 1;
    c.kind = kind;
    c.end = end;
    c.nx = nx; c.ny = ny; c.nz = nz;
    c.rax = px - a.px; c.ray = py - a.py; c.raz = pz - a.pz;
    c.depth = depth;
    c.mu = mu;
    c.e = e;
  }

  private collideStatics(a: ShoeBody, h: number) {
    const ws = a.ws, sp = a.spheres, n = a.sphereCount;
    const margin = 0.0015 + Math.hypot(a.vx, a.vy, a.vz) * h;
    // Ground: the firm pit base or the lawn.
    if (a.py - a.boundR < 0.02 + margin) {
      const T = this.tuning;
      for (let i = 0; i < n; i++) {
        const x = ws[i * 3], y = ws[i * 3 + 1], z = ws[i * 3 + 2], r = sp[i * 4 + 3];
        const end = this.pitEnd(x, z);
        const floor = end >= 0 ? -T.sink : LAWN_Y;
        const depth = floor + r - y;
        if (depth > -margin) {
          if (end >= 0) this.addStaticContact(a, i, PIT_CODE, 'pit', end as 0 | 1, 0, 1, 0, x, y - r, z, depth, T.friction, 0);
          else this.addStaticContact(a, i, GROUND_CODE, 'ground', undefined, 0, 1, 0, x, y - r, z, depth, 0.8, 0.05);
        }
      }
    }
    // Stakes.
    for (const c of this.capsules) {
      const dx = c.bx - c.ax, dy = c.by - c.ay, dz = c.bz - c.az;
      const l2 = dx * dx + dy * dy + dz * dz;
      let t = ((a.px - c.ax) * dx + (a.py - c.ay) * dy + (a.pz - c.az) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = c.ax + dx * t - a.px, by = c.ay + dy * t - a.py, bz = c.az + dz * t - a.pz;
      const reach = a.boundR + c.r + margin;
      if (bx * bx + by * by + bz * bz > reach * reach) continue;
      for (let i = 0; i < n; i++) {
        const x = ws[i * 3], y = ws[i * 3 + 1], z = ws[i * 3 + 2], r = sp[i * 4 + 3];
        let s = ((x - c.ax) * dx + (y - c.ay) * dy + (z - c.az) * dz) / l2;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const ex = x - (c.ax + dx * s), ey = y - (c.ay + dy * s), ez = z - (c.az + dz * s);
        const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        const depth = r + c.r - d;
        if (depth > -margin && d > 1e-9) {
          const nx = ex / d, ny = ey / d, nz = ez / d;
          this.addStaticContact(a, i, c.code, 'stake', c.end, nx, ny, nz, x - nx * r, y - ny * r, z - nz * r, depth, c.mu, a.restitution);
        }
      }
    }
    // Boards and backboards.
    const reach = a.boundR + margin;
    for (const bx of this.boxes) {
      if (a.px + reach < bx.minX || a.px - reach > bx.maxX || a.py + reach < bx.minY || a.py - reach > bx.maxY || a.pz + reach < bx.minZ || a.pz - reach > bx.maxZ) continue;
      for (let i = 0; i < n; i++) {
        const x = ws[i * 3], y = ws[i * 3 + 1], z = ws[i * 3 + 2], r = sp[i * 4 + 3];
        const qx = x < bx.minX ? bx.minX : x > bx.maxX ? bx.maxX : x;
        const qy = y < bx.minY ? bx.minY : y > bx.maxY ? bx.maxY : y;
        const qz = z < bx.minZ ? bx.minZ : z > bx.maxZ ? bx.maxZ : z;
        const ex = x - qx, ey = y - qy, ez = z - qz;
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > (r + margin) * (r + margin)) continue;
        let nx = 0, ny = 1, nz = 0, depth: number;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          nx = ex / d; ny = ey / d; nz = ez / d;
          depth = r - d;
        } else {
          depth = bx.maxY - y + r; // centre inside: push out the top
        }
        this.addStaticContact(a, i, bx.code, bx.kind, bx.end, nx, ny, nz, x - nx * r, y - ny * r, z - nz * r, depth, bx.mu, bx.e);
      }
    }
  }

  private collidePair(a: ShoeBody, b: ShoeBody, h: number) {
    const margin = 0.0015 + Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz) * h;
    const dx = a.px - b.px, dy = a.py - b.py, dz = a.pz - b.pz;
    const reach = a.boundR + b.boundR + margin;
    if (dx * dx + dy * dy + dz * dz > reach * reach) return;
    const A = a.aabb, B = b.aabb;
    if (A[0] > B[3] + margin || A[3] < B[0] - margin || A[1] > B[4] + margin || A[4] < B[1] - margin || A[2] > B[5] + margin || A[5] < B[2] - margin) return;
    const wa = a.ws, wb = b.ws, sa = a.spheres, sb = b.spheres, ca = a.coarse, cb = b.coarse;
    for (let ii = 0; ii < ca.length; ii++) {
      const i = ca[ii];
      const x = wa[i * 3], y = wa[i * 3 + 1], z = wa[i * 3 + 2], r = sa[i * 4 + 3];
      // Reject spheres outside the other shoe's box (cheap and tight for flat shoes).
      const e = r + margin;
      if (x + e < B[0] || x - e > B[3] || y + e < B[1] || y - e > B[4] || z + e < B[2] || z - e > B[5]) continue;
      for (let jj = 0; jj < cb.length; jj++) {
        const j = cb[jj];
        const ex = x - wb[j * 3], ey = y - wb[j * 3 + 1], ez = z - wb[j * 3 + 2];
        const rr = r + sb[j * 4 + 3];
        const d2 = ex * ex + ey * ey + ez * ez;
        if (d2 > (rr + margin) * (rr + margin) || d2 < 1e-14) continue;
        const d = Math.sqrt(d2);
        const nx = ex / d, ny = ey / d, nz = ez / d;
        const px = x - nx * r, py = y - ny * r, pz = z - nz * r;
        if (b.sleeping) {
          // Wake a resting shoe only if this one is really driving into it.
          const vax = a.vx + a.wy * (pz - a.pz) - a.wz * (py - a.py);
          const vay = a.vy + a.wz * (px - a.px) - a.wx * (pz - a.pz);
          const vaz = a.vz + a.wx * (py - a.py) - a.wy * (px - a.px);
          if (-(vax * nx + vay * ny + vaz * nz) > 0.25) {
            b.wake();
            b.updateDerived();
          }
        }
        const c = this.newContact();
        c.a = a;
        c.b = b.sleeping ? null : b;
        c.code = 1000 + b.id;
        c.kind = 'shoe';
        c.nx = nx; c.ny = ny; c.nz = nz;
        c.rax = px - a.px; c.ray = py - a.py; c.raz = pz - a.pz;
        c.rbx = px - b.px; c.rby = py - b.py; c.rbz = pz - b.pz;
        c.depth = rr - d;
        c.mu = 0.32;
        c.e = (a.restitution + b.restitution) * 0.5;
      }
    }
  }

  private prepare(c: Contact, h: number) {
    const { nx, ny, nz } = c;
    if (Math.abs(nx) > 0.57) {
      const l = Math.hypot(ny, nx);
      c.t1x = ny / l; c.t1y = -nx / l; c.t1z = 0;
    } else {
      const l = Math.hypot(nz, ny);
      c.t1x = 0; c.t1y = nz / l; c.t1z = -ny / l;
    }
    c.t2x = ny * c.t1z - nz * c.t1y;
    c.t2y = nz * c.t1x - nx * c.t1z;
    c.t2z = nx * c.t1y - ny * c.t1x;
    c.kn = this.effMass(c, nx, ny, nz);
    c.kt1 = this.effMass(c, c.t1x, c.t1y, c.t1z);
    c.kt2 = this.effMass(c, c.t2x, c.t2y, c.t2z);
    const vn = this.relVel(c, nx, ny, nz);
    c.approach = Math.max(0, -vn);
    const willTouch = c.depth >= 0 || -vn * h > -c.depth;
    // Speculative contacts may close their gap this step; penetrating ones are
    // pushed out gently. Restitution applies to contacts touching this step.
    let bias = c.depth < 0 ? c.depth / h : Math.min(0.3, 20 * Math.max(0, c.depth - SLOP));
    if (willTouch && vn < -0.35 && c.e > 0) bias = Math.max(bias, -c.e * vn);
    c.bias = bias;
    const w = c.key ? this.warm.get(c.key) : undefined;
    if (w && c.depth >= 0) {
      c.jn = w[0] * 0.85;
      c.jt1 = w[1] * 0.85;
      c.jt2 = w[2] * 0.85;
      this.applyImpulse(c, nx * c.jn + c.t1x * c.jt1 + c.t2x * c.jt2, ny * c.jn + c.t1y * c.jt1 + c.t2y * c.jt2, nz * c.jn + c.t1z * c.jt1 + c.t2z * c.jt2);
    } else {
      c.jn = c.jt1 = c.jt2 = 0;
    }
  }

  private effMass(c: Contact, x: number, y: number, z: number): number {
    let k = c.a.invMass + angTerm(c.a.invIw, c.rax, c.ray, c.raz, x, y, z);
    if (c.b) k += c.b.invMass + angTerm(c.b.invIw, c.rbx, c.rby, c.rbz, x, y, z);
    return 1 / k;
  }

  private relVel(c: Contact, x: number, y: number, z: number): number {
    const a = c.a;
    let vx = a.vx + a.wy * c.raz - a.wz * c.ray;
    let vy = a.vy + a.wz * c.rax - a.wx * c.raz;
    let vz = a.vz + a.wx * c.ray - a.wy * c.rax;
    const b = c.b;
    if (b) {
      vx -= b.vx + b.wy * c.rbz - b.wz * c.rby;
      vy -= b.vy + b.wz * c.rbx - b.wx * c.rbz;
      vz -= b.vz + b.wx * c.rby - b.wy * c.rbx;
    }
    return vx * x + vy * y + vz * z;
  }

  private applyImpulse(c: Contact, jx: number, jy: number, jz: number) {
    const a = c.a;
    a.vx += jx * a.invMass;
    a.vy += jy * a.invMass;
    a.vz += jz * a.invMass;
    let tx = c.ray * jz - c.raz * jy;
    let ty = c.raz * jx - c.rax * jz;
    let tz = c.rax * jy - c.ray * jx;
    let I = a.invIw;
    a.wx += I[0] * tx + I[1] * ty + I[2] * tz;
    a.wy += I[3] * tx + I[4] * ty + I[5] * tz;
    a.wz += I[6] * tx + I[7] * ty + I[8] * tz;
    const b = c.b;
    if (b) {
      b.vx -= jx * b.invMass;
      b.vy -= jy * b.invMass;
      b.vz -= jz * b.invMass;
      tx = c.rby * jz - c.rbz * jy;
      ty = c.rbz * jx - c.rbx * jz;
      tz = c.rbx * jy - c.rby * jx;
      I = b.invIw;
      b.wx -= I[0] * tx + I[1] * ty + I[2] * tz;
      b.wy -= I[3] * tx + I[4] * ty + I[5] * tz;
      b.wz -= I[6] * tx + I[7] * ty + I[8] * tz;
    }
  }

  private solve(c: Contact) {
    const vn = this.relVel(c, c.nx, c.ny, c.nz);
    const jn0 = c.jn;
    c.jn = Math.max(0, jn0 + (c.bias - vn) * c.kn);
    const dj = c.jn - jn0;
    if (dj !== 0) this.applyImpulse(c, c.nx * dj, c.ny * dj, c.nz * dj);
    const maxF = c.mu * c.jn;
    const j10 = c.jt1;
    c.jt1 = Math.max(-maxF, Math.min(maxF, j10 - this.relVel(c, c.t1x, c.t1y, c.t1z) * c.kt1));
    const d1 = c.jt1 - j10;
    const j20 = c.jt2;
    c.jt2 = Math.max(-maxF, Math.min(maxF, j20 - this.relVel(c, c.t2x, c.t2y, c.t2z) * c.kt2));
    const d2 = c.jt2 - j20;
    if (d1 !== 0 || d2 !== 0) this.applyImpulse(c, c.t1x * d1 + c.t2x * d2, c.t1y * d1 + c.t2y * d2, c.t1z * d1 + c.t2z * d2);
  }

  isAtRest(id: number): boolean {
    const b = this.shoes.get(id);
    return !b || b.sleeping;
  }

  allAtRest(): boolean {
    for (const b of this.shoes.values()) if (!b.sleeping) return false;
    return true;
  }

  dispose() {
    this.shoes.clear();
  }
}
