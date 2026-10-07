import { Matrix4, Quaternion, Vector3 } from 'three';
import { BOX, FT, GRAVITY, HALF_COURT, PIT, STAKE, foulLineFromTarget, type PitchDistance } from '../core/constants';
import { GRIPS, type Grip } from '../core/equipment';
import type { ShoeState } from './physicsWorld';

/**
 * Converts a pitcher's delivery into the shoe's release state.
 *
 * Everything is computed in a canonical frame where the pitcher stands at
 * the z = -HALF_COURT end and pitches toward the stake at z = +HALF_COURT,
 * then rotated 180° about Y when pitching the other way.
 */

export interface Delivery {
  grip: Grip;
  /** +1 right-handed, -1 left-handed. */
  hand: 1 | -1;
  distance: PitchDistance;
  /** Which platform: +1 = left of the pit (as seen by the pitcher), -1 = right. */
  side: 1 | -1;
  /** Throw toward this end's stake. */
  targetEnd: 0 | 1;
  /** Launch elevation (radians). */
  arc: number;
}

/** Deviations from a perfect delivery. All zero = textbook ringer attempt. */
export interface DeliveryError {
  /** Fractional speed error (0.02 = 2% too hard). */
  power: number;
  /** Horizontal aim error in radians (positive = to pitcher's left). */
  yaw: number;
  /** Fractional rotation-rate error (0.05 = 5% over-rotated). */
  rotation: number;
  /** Roll of the shoe about its flight direction at release (radians). */
  tilt: number;
  /** Off-axis angular velocity (rad/s). */
  wobble: number;
  /** Direction of the wobble axis (radians). */
  wobbleDir: number;
  /** Launch angle error (radians). */
  arc: number;
}

export const ZERO_ERROR: DeliveryError = { power: 0, yaw: 0, rotation: 0, tilt: 0, wobble: 0, wobbleDir: 0, arc: 0 };

/** Where the perfect shoe would come down relative to the stake base (along the line of flight). */
export const LANDING_PAST_STAKE = 0.035;
export const RELEASE_HEIGHT = 0.78;
export const DEFAULT_ARC = (31 * Math.PI) / 180;
/** Centre of each pitching platform (canonical |x|). */
export const PLATFORM_X = PIT.width / 2 + BOX.frameWidth + BOX.platformWidth / 2;

export interface ReleasePlan {
  state: ShoeState;
  /** Predicted time of arrival at the stake (s). */
  catchTime: number;
  /** Ideal angular rate (rad/s) for the grip. */
  idealSpin: number;
  speed: number;
  releasePoint: Vector3;
  /** Horizontal unit direction of flight. */
  heading: Vector3;
}

export function releasePoint(d: Pick<Delivery, 'distance' | 'side' | 'hand'>): Vector3 {
  // The pitching arm hangs ~24 cm from the body's centreline (right arm on
  // the pitcher's right, which is -X in the canonical frame).
  const armX = d.side * PLATFORM_X - d.hand * 0.24;
  const foulZ = HALF_COURT - foulLineFromTarget(d.distance);
  return new Vector3(armX, RELEASE_HEIGHT, foulZ + 0.12);
}

/** Speed needed to travel horizontal distance D while dropping h at launch angle a. */
export function speedFor(D: number, h: number, a: number): number {
  const c = Math.cos(a);
  return Math.sqrt((GRAVITY * D * D) / (2 * c * c * (D * Math.tan(a) + h)));
}

function canonicalToWorld(v: Vector3, targetEnd: 0 | 1): Vector3 {
  if (targetEnd === 1) return v;
  return v.set(-v.x, v.y, -v.z);
}

const Y = new Vector3(0, 1, 0);

/**
 * Plan a release. The delivery's grip determines the starting orientation;
 * the error perturbs speed, direction, spin and attitude.
 */
export function planRelease(d: Delivery, err: DeliveryError = ZERO_ERROR, aimOffset = new Vector3()): ReleasePlan {
  const rel = releasePoint(d);
  const stakeBase = new Vector3(0, 0, HALF_COURT);
  // Aim at the stake (plus any deliberate aim offset in canonical metres).
  const target = stakeBase.clone().add(aimOffset);
  const dir = new Vector3(target.x - rel.x, 0, target.z - rel.z);
  const stakeDist = dir.length();
  dir.normalize();
  const landing = target.clone().addScaledVector(dir, LANDING_PAST_STAKE);
  const D = Math.hypot(landing.x - rel.x, landing.z - rel.z);
  const landY = 0.015;
  const arc = d.arc + err.arc;
  const idealSpeed = speedFor(D, rel.y - landY, d.arc);
  const speed = idealSpeed * (1 + err.power);
  // Catch time: when the shoe reaches the stake's horizontal position.
  const catchTime = stakeDist / (idealSpeed * Math.cos(d.arc));
  const heading = dir.clone().applyAxisAngle(Y, err.yaw);
  const vel = heading.clone().multiplyScalar(speed * Math.cos(arc));
  vel.y = speed * Math.sin(arc);

  const grip = GRIPS[d.grip];
  const idealSpin = (2 * Math.PI * grip.rotations) / catchTime;
  const spin = idealSpin * (1 + err.rotation);

  // Flight frame: Z = heading, Y = up, X = Y × Z.
  const fz = heading.clone();
  const fx = new Vector3().crossVectors(Y, fz).normalize();
  const basis = new Matrix4().makeBasis(fx, Y, fz);
  const qHeading = new Quaternion().setFromRotationMatrix(basis);

  const q = new Quaternion();
  const angvel = new Vector3();
  if (d.grip === 'flip') {
    // Backspin end-over-end about the lateral axis; heels lead.
    q.copy(qHeading);
    angvel.copy(fx).multiplyScalar(-spin);
  } else {
    // Flat turn about the vertical: start rotated back by the full turn count.
    const startYaw = -d.hand * grip.rotations * 2 * Math.PI;
    q.setFromAxisAngle(Y, startYaw).multiply(qHeading);
    angvel.set(0, d.hand * spin, 0);
  }
  // Release roll and wobble.
  if (err.tilt) q.premultiply(new Quaternion().setFromAxisAngle(fz, err.tilt));
  if (err.wobble) {
    const offAxisA = d.grip === 'flip' ? fz : fx;
    const offAxisB = d.grip === 'flip' ? Y : fz;
    angvel.addScaledVector(offAxisA, Math.cos(err.wobbleDir) * err.wobble);
    angvel.addScaledVector(offAxisB, Math.sin(err.wobbleDir) * err.wobble);
  }

  // The shoe's local origin should follow the planned path from the release point.
  const position = rel.clone();
  const state: ShoeState = {
    position: canonicalToWorld(position, d.targetEnd),
    quaternion: d.targetEnd === 1 ? q : q.premultiply(new Quaternion().setFromAxisAngle(Y, Math.PI)),
    linvel: canonicalToWorld(vel, d.targetEnd),
    angvel: canonicalToWorld(angvel, d.targetEnd),
  };
  return {
    state,
    catchTime,
    idealSpin,
    speed,
    releasePoint: state.position.clone(),
    heading: canonicalToWorld(heading.clone(), d.targetEnd),
  };
}

/** Ballistic position at time t (no drag; shoes are dense enough that air drag is negligible). */
export function ballistic(p0: Vector3, v0: Vector3, t: number, out = new Vector3()): Vector3 {
  return out.set(p0.x + v0.x * t, p0.y + v0.y * t - 0.5 * GRAVITY * t * t, p0.z + v0.z * t);
}

/** Pitching from end E means aiming at the other end's stake. */
export const targetEndFor = (pitchFrom: 0 | 1): 0 | 1 => (pitchFrom === 0 ? 1 : 0);

export const STAKE_TOP_HEIGHT = STAKE.height;
export const FOUL_LINE_40 = HALF_COURT - 37 * FT;
