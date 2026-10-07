import { shoeTraits } from '../core/equipment';
import { randomError } from '../physics/errorModel';
import type { DeliveryError } from '../physics/throwModel';
import type { PlayerInfo } from './match';

/**
 * Error scale → ringer % for a flip pitcher on sand with a standard shoe,
 * measured by tests/calibration.test.ts with the real physics engine.
 */
export const RINGER_CURVE: [scale: number, ringerPct: number][] = [
  [0.2, 98],
  [0.25, 97],
  [0.5, 81],
  [0.75, 50],
  [1, 32],
  [1.5, 20],
  [2, 8],
  [3, 5],
  [4, 2],
];

/** Error scale that yields the requested ringer percentage. */
export function scaleForRating(rating: number): number {
  const r = Math.max(2, Math.min(98, rating));
  for (let i = 0; i < RINGER_CURVE.length - 1; i++) {
    const [s0, p0] = RINGER_CURVE[i];
    const [s1, p1] = RINGER_CURVE[i + 1];
    if (r <= p0 && r >= p1) return s0 + ((p0 - r) / (p0 - p1)) * (s1 - s0);
  }
  return r > RINGER_CURVE[0][1] ? RINGER_CURVE[0][0] : RINGER_CURVE[RINGER_CURVE.length - 1][0];
}

/** Draw a delivery error for an AI pitcher. Pressure (0..1) slightly tightens/loosens a pitcher. */
export function aiDeliveryError(p: PlayerInfo, rng: () => number = Math.random, pressure = 0): DeliveryError {
  const traits = shoeTraits(p.loadout);
  const base = scaleForRating(p.rating ?? 30);
  const scale = base * (1 + pressure * 0.12 * (rng() - 0.35));
  // Turn pitchers are slightly less forgiving in the physics; compensate so ratings stay honest.
  const gripAdj = p.grip === 'flip' ? 1 : 0.85;
  return randomError(scale * gripAdj, rng, traits.wobbleScale, traits.rotationScale);
}

/** Cheap statistical shoe for simulated (off-screen) tournament games. */
export function simulatedShoe(rating: number, rng: () => number): { ringer: boolean; inCount: boolean; distance: number } {
  const p = rating / 100;
  if (rng() < p) return { ringer: true, inCount: true, distance: 0 };
  // Better pitchers' misses land closer.
  const countP = 0.35 + 0.45 * p;
  if (rng() < countP) return { ringer: false, inCount: true, distance: 0.003 + rng() * 0.15 * (1.2 - p) };
  return { ringer: false, inCount: false, distance: 0.16 + rng() * 0.5 };
}
