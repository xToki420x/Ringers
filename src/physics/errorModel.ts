import type { DeliveryError } from './throwModel';

/**
 * Release-error model shared by AI pitchers and calibration. One standard
 * deviation of each component at skill scale 1.0.
 */
export const ERROR_SIGMA = {
  power: 0.011,
  yaw: 0.0035,
  rotation: 0.07,
  tilt: 0.07,
  wobble: 0.55,
  arc: 0.012,
} as const;

/** Box–Muller normal sample. */
export function gauss(rng: () => number = Math.random): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function randomError(scale: number, rng: () => number = Math.random, wobbleScale = 1, rotationScale = 1): DeliveryError {
  return {
    power: gauss(rng) * ERROR_SIGMA.power * scale,
    yaw: gauss(rng) * ERROR_SIGMA.yaw * scale,
    rotation: gauss(rng) * ERROR_SIGMA.rotation * scale * rotationScale,
    tilt: gauss(rng) * ERROR_SIGMA.tilt * scale * wobbleScale,
    wobble: Math.abs(gauss(rng)) * ERROR_SIGMA.wobble * scale * wobbleScale,
    wobbleDir: rng() * Math.PI * 2,
    arc: gauss(rng) * ERROR_SIGMA.arc * scale,
  };
}

/** Deterministic PRNG (mulberry32) for reproducible simulations. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
