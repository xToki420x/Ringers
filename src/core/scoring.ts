import { Quaternion, Vector3 } from 'three';
import { COUNT_DISTANCE, POINTS } from './constants';
import { distToSegment, pointInPolygon, type ShoeGeometry, type Vec2 } from './shoeShape';

/**
 * Judging and scoring per NHPA rules.
 *
 * Ringer: the shoe encircles the stake far enough that a straightedge can
 * touch both heel calks and clear the stake.
 * In count: any part of the shoe within 6 inches of the stake.
 */

export interface StakeLike {
  base: Vector3;
  top: Vector3;
  radius: number;
}

export interface ShoeResult {
  owner: number;
  ringer: boolean;
  leaner: boolean;
  /** Closest distance from shoe to stake surface (m). 0 for ringers. */
  distance: number;
  inCount: boolean;
  /** Out of the pit / foul. */
  foul: boolean;
}

export function judgeShoe(
  owner: number,
  geom: ShoeGeometry,
  position: Vector3,
  quaternion: Quaternion,
  stake: StakeLike,
  foul = false,
): ShoeResult {
  if (foul) return { owner, ringer: false, leaner: false, distance: Infinity, inCount: false, foul: true };
  const inv = quaternion.clone().invert();
  const up = new Vector3(0, 1, 0).applyQuaternion(quaternion);
  const tiltCos = Math.abs(up.y);

  // Intersect stake axis with the shoe's mid-plane.
  const axis = stake.top.clone().sub(stake.base);
  const denom = axis.dot(up);
  let ringer = false;
  if (Math.abs(denom) > 1e-6 && tiltCos > 0.62) {
    const t = position.clone().sub(stake.base).dot(up) / denom;
    if (t >= -0.05 && t <= 1.02) {
      const hit = stake.base.clone().addScaledVector(axis, t);
      const local = hit.sub(position).applyQuaternion(inv);
      const p: Vec2 = { x: local.x, z: local.z };
      if (pointInPolygon(p, geom.innerPolygon)) {
        const [h0, h1] = geom.heelLine;
        // Straightedge across the heels must clear the stake.
        const clear = distToSegment(p, h0, h1) >= stake.radius * 0.98 && p.z < Math.max(h0.z, h1.z);
        ringer = clear;
      }
    }
  }

  const distance = ringer ? 0 : shoeStakeDistance(geom, position, quaternion, stake);
  const leaner = !ringer && distance < 0.006 && tiltCos < 0.94 && position.y > 0.025;
  return { owner, ringer, leaner, distance, inCount: ringer || distance <= COUNT_DISTANCE, foul: false };
}

const tmp = new Vector3();
const seg = new Vector3();

/** Closest distance from any part of the shoe outline to the stake surface. */
export function shoeStakeDistance(geom: ShoeGeometry, position: Vector3, quaternion: Quaternion, stake: StakeLike): number {
  seg.copy(stake.top).sub(stake.base);
  const l2 = seg.lengthSq();
  let best = Infinity;
  const pts = [...geom.outerContour, ...geom.innerPolygon];
  for (let k = 0; k < pts.length; k += 1) {
    const p = pts[k];
    tmp.set(p.x, 0, p.z).applyQuaternion(quaternion).add(position);
    let t = tmp.clone().sub(stake.base).dot(seg) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = stake.base.x + seg.x * t;
    const cy = stake.base.y + seg.y * t;
    const cz = stake.base.z + seg.z * t;
    const d = Math.hypot(tmp.x - cx, tmp.y - cy, tmp.z - cz) - stake.radius;
    if (d < best) best = d;
  }
  return Math.max(0, best);
}

export type ScoringMode = 'cancellation' | 'countall';

export interface InningScore {
  points: [number, number];
  /** Short description of why, for the inning summary. */
  call: string;
  ringers: [number, number];
}

const TIE_EPS = 0.0015;

/**
 * NHPA cancellation scoring: ringers cancel, only one pitcher scores per
 * inning, closest shoe in count scores 1 (2 if both are closer than the
 * opponent's best), an uncancelled ringer scores 3.
 */
export function scoreCancellation(shoes: ShoeResult[]): InningScore {
  const mine = (o: number) => shoes.filter((s) => s.owner === o);
  const a = mine(0);
  const b = mine(1);
  const ra = a.filter((s) => s.ringer).length;
  const rb = b.filter((s) => s.ringer).length;
  const ringers: [number, number] = [ra, rb];
  const net = ra - rb;
  // Shoes still contesting for closest point: non-ringers of each pitcher.
  const restA = a.filter((s) => !s.ringer && s.inCount).sort((x, y) => x.distance - y.distance);
  const restB = b.filter((s) => !s.ringer && s.inCount).sort((x, y) => x.distance - y.distance);

  if (net !== 0) {
    const winner = net > 0 ? 0 : 1;
    let pts = Math.abs(net) * POINTS.ringer;
    const myRest = winner === 0 ? restA : restB;
    const theirRest = winner === 0 ? restB : restA;
    // A pitcher with an uncancelled ringer adds 1 if their other shoe is closest.
    if (myRest.length && (!theirRest.length || myRest[0].distance < theirRest[0].distance - TIE_EPS)) pts += POINTS.inCount;
    const out: [number, number] = [0, 0];
    out[winner] = pts;
    const call = Math.abs(net) === 2 ? 'Double ringer' : pts === 4 ? 'Ringer + closest shoe' : 'Ringer';
    return { points: out, call, ringers };
  }

  if (!restA.length && !restB.length) {
    return { points: [0, 0], call: ra > 0 ? (ra === 2 ? 'Doubles cancel' : 'Ringers cancel') : 'No count', ringers };
  }
  const bestA = restA[0]?.distance ?? Infinity;
  const bestB = restB[0]?.distance ?? Infinity;
  if (Math.abs(bestA - bestB) <= TIE_EPS) return { points: [0, 0], call: 'Tie — no score', ringers };
  const winner = bestA < bestB ? 0 : 1;
  const myRest = winner === 0 ? restA : restB;
  const theirBest = winner === 0 ? bestB : bestA;
  let pts = 1;
  if (ra === 0 && myRest.length === 2 && myRest[1].distance < theirBest - TIE_EPS) pts = 2;
  const out: [number, number] = [0, 0];
  out[winner] = pts;
  return { points: out, call: ra > 0 ? `Ringers cancel · ${pts === 2 ? 'two' : 'one'} closest` : pts === 2 ? 'Two closest' : 'Closest shoe', ringers };
}

/** NHPA count-all scoring: every ringer is 3, every other shoe in count is 1. */
export function scoreCountAll(shoes: ShoeResult[]): InningScore {
  const pts: [number, number] = [0, 0];
  const ringers: [number, number] = [0, 0];
  for (const s of shoes) {
    if (s.owner !== 0 && s.owner !== 1) continue;
    if (s.ringer) {
      pts[s.owner] += POINTS.ringer;
      ringers[s.owner]++;
    } else if (s.inCount) pts[s.owner] += POINTS.inCount;
  }
  return { points: pts, call: 'Count-all', ringers };
}

export function scoreInning(mode: ScoringMode, shoes: ShoeResult[]): InningScore {
  return mode === 'cancellation' ? scoreCancellation(shoes) : scoreCountAll(shoes);
}

export function formatDistance(m: number, metric: boolean): string {
  if (!isFinite(m)) return 'out';
  if (metric) return m < 0.1 ? `${(m * 100).toFixed(1)} cm` : `${(m * 100).toFixed(0)} cm`;
  const inches = m / 0.0254;
  if (inches < 12) return `${inches.toFixed(1)}″`;
  const ft = Math.floor(inches / 12);
  return `${ft}′ ${Math.round(inches - ft * 12)}″`;
}
