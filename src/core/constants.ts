/**
 * Regulation dimensions and rules, following the NHPA (National Horseshoe
 * Pitchers Association) Official Rules. All lengths are in metres.
 */

export const IN = 0.0254;
export const FT = 12 * IN;
export const OZ_KG = 0.028349523125;
export const LB_KG = 16 * OZ_KG;

export const GRAVITY = 9.81;

/** Stakes are 40 ft apart; women, elders and juniors pitch from a 27 ft foul line ("30 ft"). */
export const STAKE_DISTANCE = 40 * FT;
export const HALF_COURT = STAKE_DISTANCE / 2;

export type PitchDistance = 40 | 30;
/** Distance from the opposite stake to the foul line. */
export function foulLineFromTarget(distance: PitchDistance): number {
  return distance === 40 ? 37 * FT : 27 * FT;
}

export const STAKE = {
  diameter: 1 * IN,
  radius: 0.5 * IN,
  /** Height above the pit surface (rule: 14–15 in). */
  height: 15 * IN,
  /** The top leans toward the opposite stake by 3 in. */
  lean: Math.atan2(3 * IN, 15 * IN),
  /** Steel stake continues below the surface into the anchor. */
  buried: 10 * IN,
} as const;

export const PIT = {
  width: 36 * IN,
  length: 60 * IN,
} as const;

export const BOX = {
  width: 6 * FT,
  length: 6 * FT,
  /** Pitching platforms either side of the pit. */
  platformWidth: (6 * FT - 36 * IN) / 2,
  /** Timber frame around the pit. */
  frameWidth: 2 * IN,
  frameHeight: 1.5 * IN,
  backboardDistance: 4 * FT,
  backboardHeight: 18 * IN,
} as const;

/** NHPA equipment limits. */
export const SHOE_LIMITS = {
  maxWeightKg: 2 * LB_KG + 10 * OZ_KG,
  maxWidth: 7.25 * IN,
  maxLength: 7.625 * IN,
  maxOpening: 3.5 * IN,
} as const;

/** A shoe within 6 in of the stake is "in count" and can score. */
export const COUNT_DISTANCE = 6 * IN;

export const POINTS = {
  ringer: 3,
  inCount: 1,
} as const;
