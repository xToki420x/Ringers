import { IN, LB_KG, OZ_KG, SHOE_LIMITS } from './constants';

/**
 * Pitching shoe catalogue. Every combination of brand, shape and weight
 * is legal under NHPA equipment rules (verified in tests/equipment.test.ts).
 * Brand names are fictional.
 */

export type ShapeId = 'classic' | 'hook' | 'wide' | 'taper';
export type Hardness = 'soft' | 'medium' | 'hard';
export type FinishId =
  | 'forged'
  | 'black'
  | 'red'
  | 'blue'
  | 'chrome'
  | 'copper'
  | 'gold'
  | 'green'
  | 'orange';
export type BrandId = 'ironside' | 'prairie' | 'copperhead' | 'thunder' | 'silverstake' | 'ozark';
export type WeightId = '2-2' | '2-4' | '2-6' | '2-8' | '2-10';
export type Grip = 'flip' | 'turn114' | 'turn134';

/** Shape parameters, all in inches (converted to metres by `shapeMetres`). */
export interface ShapeSpec {
  id: ShapeId;
  name: string;
  blurb: string;
  /** Centerline half-width (ellipse semi-axis across the shoe). */
  a: number;
  /** Centerline semi-axis from ellipse centre to toe. */
  c: number;
  /** Angular extent of each arm from the toe, degrees (>90 means heels turn in). */
  thetaMaxDeg: number;
  bandToe: number;
  bandHeel: number;
  thickness: number;
  toeCalk: number;
  heelCalk: number;
  /** Inward hook at each heel tip. */
  hook: number;
  /** Raised inner lip (visual + slight catch bonus). */
  innerLip: number;
}

export const SHAPES: Record<ShapeId, ShapeSpec> = {
  classic: {
    id: 'classic',
    name: 'Classic',
    blurb: 'Traditional open profile. Balanced catch and hold — the benchmark.',
    a: 3.066,
    c: 3.867,
    thetaMaxDeg: 134.4,
    bandToe: 1.12,
    bandHeel: 0.94,
    thickness: 0.5,
    toeCalk: 0.28,
    heelCalk: 0.3,
    hook: 0.12,
    innerLip: 0.04,
  },
  hook: {
    id: 'hook',
    name: 'Hook Heel',
    blurb: 'Pronounced heel hooks lock onto the stake. Ringers stay on.',
    a: 3.057,
    c: 3.856,
    thetaMaxDeg: 134.4,
    bandToe: 1.1,
    bandHeel: 0.9,
    thickness: 0.52,
    toeCalk: 0.3,
    heelCalk: 0.32,
    hook: 0.34,
    innerLip: 0.06,
  },
  wide: {
    id: 'wide',
    name: 'Wide Body',
    blurb: 'Maximum width and opening. Forgiving catch, but ringers can spin off.',
    a: 3.139,
    c: 3.679,
    thetaMaxDeg: 137.1,
    bandToe: 1.04,
    bandHeel: 0.9,
    thickness: 0.48,
    toeCalk: 0.26,
    heelCalk: 0.28,
    hook: 0.08,
    innerLip: 0.03,
  },
  taper: {
    id: 'taper',
    name: 'Tournament Taper',
    blurb: 'Long profile with tapered heels. Rewards a true flip; punishes a wobble.',
    a: 2.989,
    c: 4.0,
    thetaMaxDeg: 133.8,
    bandToe: 1.2,
    bandHeel: 0.8,
    thickness: 0.5,
    toeCalk: 0.3,
    heelCalk: 0.26,
    hook: 0.2,
    innerLip: 0.08,
  },
};

export interface FinishSpec {
  id: FinishId;
  name: string;
  color: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
  /** Amount of worn bare steel showing through on edges (0..1). */
  wear: number;
}

export const FINISHES: Record<FinishId, FinishSpec> = {
  forged: { id: 'forged', name: 'Raw Forged', color: '#8a8e93', metalness: 0.7, roughness: 0.42, clearcoat: 0, wear: 0 },
  black: { id: 'black', name: 'Black Powder', color: '#17181a', metalness: 0.25, roughness: 0.42, clearcoat: 0.6, wear: 0.55 },
  red: { id: 'red', name: 'Barn Red', color: '#a0151b', metalness: 0.2, roughness: 0.38, clearcoat: 0.7, wear: 0.5 },
  blue: { id: 'blue', name: 'Royal Blue', color: '#1b3f9a', metalness: 0.2, roughness: 0.38, clearcoat: 0.7, wear: 0.5 },
  green: { id: 'green', name: 'Field Green', color: '#1f6b34', metalness: 0.2, roughness: 0.4, clearcoat: 0.65, wear: 0.5 },
  orange: { id: 'orange', name: 'Safety Orange', color: '#e0601a', metalness: 0.15, roughness: 0.4, clearcoat: 0.65, wear: 0.5 },
  chrome: { id: 'chrome', name: 'Mirror Chrome', color: '#e8ebee', metalness: 1, roughness: 0.08, clearcoat: 0.3, wear: 0.15 },
  copper: { id: 'copper', name: 'Copper Plate', color: '#c46a3a', metalness: 1, roughness: 0.28, clearcoat: 0.2, wear: 0.3 },
  gold: { id: 'gold', name: 'Champion Gold', color: '#e3b34a', metalness: 1, roughness: 0.22, clearcoat: 0.4, wear: 0.2 },
};

export interface BrandSpec {
  id: BrandId;
  name: string;
  tagline: string;
  hardness: Hardness;
  finishes: FinishId[];
  /** Short stamp forged into the toe. */
  stamp: string;
  accent: string;
  /** Unlocked by winning a tournament. */
  locked?: boolean;
}

export const BRANDS: Record<BrandId, BrandSpec> = {
  ironside: {
    id: 'ironside',
    name: 'Ironside Forge',
    tagline: 'Drop-forged soft steel since 1921. Dies on the stake.',
    hardness: 'soft',
    finishes: ['forged', 'black', 'red'],
    stamp: 'IRONSIDE',
    accent: '#d9822b',
  },
  prairie: {
    id: 'prairie',
    name: 'Prairie King',
    tagline: 'Heartland favourite. Medium temper, true in the air.',
    hardness: 'medium',
    finishes: ['red', 'blue', 'green', 'black'],
    stamp: 'PRAIRIE KING',
    accent: '#c0392b',
  },
  copperhead: {
    id: 'copperhead',
    name: 'Copperhead Pro',
    tagline: 'Plated soft steel with a grip-texture finish.',
    hardness: 'soft',
    finishes: ['copper', 'black', 'orange'],
    stamp: 'COPPERHEAD',
    accent: '#c46a3a',
  },
  thunder: {
    id: 'thunder',
    name: 'Thunder Ridge',
    tagline: 'Heat-treated hard steel. Loud, lively and built to last.',
    hardness: 'hard',
    finishes: ['black', 'blue', 'forged'],
    stamp: 'THUNDER RIDGE',
    accent: '#3a7bd5',
  },
  silverstake: {
    id: 'silverstake',
    name: 'Silver Stake',
    tagline: 'Show-room chrome over medium steel.',
    hardness: 'medium',
    finishes: ['chrome', 'black', 'gold'],
    stamp: 'SILVER STAKE',
    accent: '#b8c2cc',
  },
  ozark: {
    id: 'ozark',
    name: 'Ozark Hammer',
    tagline: 'Hand-finished hammered soft steel. Champion’s choice.',
    hardness: 'soft',
    finishes: ['forged', 'gold', 'green'],
    stamp: 'OZARK',
    accent: '#e3b34a',
    locked: true,
  },
};

export interface WeightSpec {
  id: WeightId;
  label: string;
  kg: number;
}

export const WEIGHTS: Record<WeightId, WeightSpec> = {
  '2-2': { id: '2-2', label: '2 lb 2 oz', kg: 2 * LB_KG + 2 * OZ_KG },
  '2-4': { id: '2-4', label: '2 lb 4 oz', kg: 2 * LB_KG + 4 * OZ_KG },
  '2-6': { id: '2-6', label: '2 lb 6 oz', kg: 2 * LB_KG + 6 * OZ_KG },
  '2-8': { id: '2-8', label: '2 lb 8 oz', kg: 2 * LB_KG + 8 * OZ_KG },
  '2-10': { id: '2-10', label: '2 lb 10 oz', kg: 2 * LB_KG + 10 * OZ_KG },
};

export const GRIPS: Record<Grip, { id: Grip; name: string; short: string; rotations: number; blurb: string }> = {
  flip: {
    id: 'flip',
    name: 'Single Flip',
    short: 'Flip',
    rotations: 1,
    blurb: 'End-over-end. One full flip lands the shoe flat and open on the stake.',
  },
  turn114: {
    id: 'turn114',
    name: '1¼ Turn',
    short: '1¼',
    rotations: 1.25,
    blurb: 'Flat spin, heels start right. A quick, compact delivery.',
  },
  turn134: {
    id: 'turn134',
    name: '1¾ Turn',
    short: '1¾',
    rotations: 1.75,
    blurb: 'Flat spin from the shank. The classic championship turn.',
  },
};

export interface Loadout {
  brand: BrandId;
  shape: ShapeId;
  weight: WeightId;
  finish: FinishId;
}

export const DEFAULT_LOADOUT: Loadout = { brand: 'ironside', shape: 'classic', weight: '2-8', finish: 'forged' };

export function sanitizeLoadout(l: Partial<Loadout> | undefined): Loadout {
  const brand = l?.brand && BRANDS[l.brand] ? l.brand : DEFAULT_LOADOUT.brand;
  const shape = l?.shape && SHAPES[l.shape] ? l.shape : DEFAULT_LOADOUT.shape;
  const weight = l?.weight && WEIGHTS[l.weight] ? l.weight : DEFAULT_LOADOUT.weight;
  const finish = l?.finish && BRANDS[brand].finishes.includes(l.finish) ? l.finish : BRANDS[brand].finishes[0];
  return { brand, shape, weight, finish };
}

/** Physical behaviour derived from a loadout. */
export interface ShoeTraits {
  massKg: number;
  /** Coefficient of restitution against the steel stake / other shoes. */
  restitution: number;
  /** Multiplier on release wobble (lower is steadier). */
  wobbleScale: number;
  /** Multiplier on flip/turn error (lower is more forgiving). */
  rotationScale: number;
}

const HARDNESS_RESTITUTION: Record<Hardness, number> = { soft: 0.14, medium: 0.26, hard: 0.4 };

export function shoeTraits(l: Loadout): ShoeTraits {
  const massKg = WEIGHTS[l.weight].kg;
  const heavy = (massKg - WEIGHTS['2-2'].kg) / (SHOE_LIMITS.maxWeightKg - WEIGHTS['2-2'].kg); // 0..1
  const shape = SHAPES[l.shape];
  return {
    massKg,
    restitution: HARDNESS_RESTITUTION[BRANDS[l.brand].hardness],
    wobbleScale: (1.15 - 0.3 * heavy) * (shape.id === 'taper' ? 1.15 : shape.id === 'wide' ? 0.92 : 1),
    rotationScale: 0.9 + 0.2 * heavy,
  };
}

/** 0..100 ratings for the pro-shop bars. */
export function shoeRatings(l: Loadout): { catch: number; hold: number; stability: number; deadness: number; control: number } {
  const s = SHAPES[l.shape];
  const t = shoeTraits(l);
  const heavy = (t.massKg - WEIGHTS['2-2'].kg) / (SHOE_LIMITS.maxWeightKg - WEIGHTS['2-2'].kg);
  const clamp = (v: number) => Math.round(Math.max(5, Math.min(100, v)));
  return {
    catch: clamp(45 + (s.a - 2.9) * 160 + (s.thetaMaxDeg < 122 ? 6 : 0) - s.hook * 20),
    hold: clamp(35 + s.hook * 140 + s.innerLip * 120),
    stability: clamp(40 + heavy * 40 + (s.id === 'wide' ? 10 : s.id === 'taper' ? -10 : 0)),
    deadness: clamp(100 - t.restitution * 170 + heavy * 12),
    control: clamp(80 - heavy * 25 + (s.id === 'taper' ? -8 : 0)),
  };
}

export const inches = (m: number) => m / IN;
