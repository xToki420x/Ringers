import { IN, LB_KG, OZ_KG, SHOE_LIMITS } from './constants';

/**
 * Pitching shoe catalogue: four forged pitching-shoe models, each available
 * in every legal weight and in any colour and finish. Every model is legal
 * under NHPA equipment rules (verified in tests/equipment.test.ts).
 */

export type ModelId = 'bulldog' | 'legend' | 'cadet' | 'competition';
export type Hardness = 'soft' | 'medium' | 'hard';
export type FinishId = 'gloss' | 'satin' | 'metal' | 'chrome';
export type WeightId = '2-2' | '2-4' | '2-6' | '2-8' | '2-10';
export type Grip = 'flip' | 'turn114' | 'turn134';
/** Colour as hue (0–360), saturation (0–1) and brightness (0–1). */
export type Hsv = [number, number, number];

/**
 * Heel calk forms: a flat-topped `block`, a `pyramid` rising to a point,
 * a `wedge` that climbs toward the heel tip, or a `bevel` block with a
 * sloped face.
 */
export type CalkKind = 'block' | 'pyramid' | 'wedge' | 'bevel';

/** Shape parameters, all lengths in inches. */
export interface ShapeSpec {
  /** Overall outside width and length (toe to heel tips). */
  width: number;
  length: number;
  /** Depth of the rounded bow, measured on the centreline from the toe. */
  bowDepth: number;
  /** Superellipse exponent of the bow: 2 is round, higher is squarer. */
  squareness: number;
  /** Inward lean of each leg toward the heels, degrees. */
  legLean: number;
  bandToe: number;
  bandLeg: number;
  bandHeel: number;
  thickness: number;
  /** How far each hook reaches in past the inside edge of the leg. */
  hookReach: number;
  /** Thickness of the hook at its tip (twice the tip radius). */
  hookTip: number;
  /** Length of the curved throat between the leg and the top of the hook. */
  hookThroat: number;
  /** How far the hook tip curls back toward the toe. */
  hookCurl: number;
  /** How far the outer heel point runs past the bottom of the hook. */
  heelPoint: number;
  /** Outward flare of the heel point. */
  heelFlare: number;
  heelCalk: { kind: CalkKind; height: number; length: number; /** 0..1 of the hook it covers. */ reach: number };
  toeCalk: { height: number; length: number; width: number };
  /** Raised bump on the inside of the toe (0 for none). */
  toeNotch: number;
}

export interface StampSpec {
  /** Main stamp text. */
  text: string;
  /** `oval` is a raised oval badge on the toe, `panel` a raised plate across the bow, `leg` a badge on the leg. */
  style: 'oval' | 'panel' | 'leg';
  /** Small marks either side of the badge. */
  sides?: [string, string];
  /** Mark under the main text. */
  under?: string;
}

export interface ModelSpec {
  id: ModelId;
  name: string;
  tagline: string;
  hardness: Hardness;
  shape: ShapeSpec;
  stamp: StampSpec;
  /** Factory finish and colour. */
  finish: FinishId;
  color: Hsv;
}

export const MODELS: Record<ModelId, ModelSpec> = {
  bulldog: {
    id: 'bulldog',
    name: 'Bulldog',
    tagline: 'Square-shouldered and broad with stubby hooks. Wide catch, soft steel that dies on the stake.',
    hardness: 'soft',
    shape: {
      width: 7.2, length: 7.35, bowDepth: 2.35, squareness: 3.1, legLean: 0.6,
      bandToe: 1.14, bandLeg: 1.1, bandHeel: 1.06, thickness: 0.5,
      hookReach: 0.76, hookTip: 0.48, hookThroat: 0.3, hookCurl: 0.06, heelPoint: 0.5, heelFlare: 0.04,
      heelCalk: { kind: 'wedge', height: 0.3, length: 0.95, reach: 0.35 },
      toeCalk: { height: 0.27, length: 1.6, width: 0.42 },
      toeNotch: 0,
    },
    stamp: { text: 'BULLDOG', style: 'oval' },
    finish: 'gloss',
    color: [220, 0.08, 0.07],
  },
  legend: {
    id: 'legend',
    name: 'Legend',
    tagline: 'Round bow, block heel calks and a thumb notch on the toe. A medium-temper all-rounder.',
    hardness: 'medium',
    shape: {
      width: 7.0, length: 7.42, bowDepth: 2.7, squareness: 2.25, legLean: 0.4,
      bandToe: 1.0, bandLeg: 0.88, bandHeel: 0.9, thickness: 0.5,
      hookReach: 0.9, hookTip: 0.26, hookThroat: 0.34, hookCurl: 0.16, heelPoint: 0.72, heelFlare: 0.02,
      heelCalk: { kind: 'block', height: 0.3, length: 0.78, reach: 0 },
      toeCalk: { height: 0.28, length: 1.5, width: 0.4 },
      toeNotch: 0.13,
    },
    stamp: { text: 'LEGEND', style: 'leg' },
    finish: 'gloss',
    color: [356, 0.93, 0.78],
  },
  cadet: {
    id: 'cadet',
    name: 'Cadet',
    tagline: 'Tall, narrow and lively, with pyramid heel calks and sharp hooks that bite the stake.',
    hardness: 'hard',
    shape: {
      width: 7.05, length: 7.5, bowDepth: 2.75, squareness: 2.1, legLean: 1.8,
      bandToe: 1.05, bandLeg: 0.9, bandHeel: 0.86, thickness: 0.5,
      hookReach: 0.84, hookTip: 0.2, hookThroat: 0.42, hookCurl: 0.2, heelPoint: 0.85, heelFlare: 0.05,
      heelCalk: { kind: 'pyramid', height: 0.36, length: 0.9, reach: 0.75 },
      toeCalk: { height: 0.28, length: 1.45, width: 0.4 },
      toeNotch: 0,
    },
    stamp: { text: 'CADET', style: 'oval' },
    finish: 'gloss',
    color: [128, 0.85, 0.66],
  },
  competition: {
    id: 'competition',
    name: 'Competition',
    tagline: 'Drop-forged soft steel. A broad toe panel tapering to slim legs, with tall bevelled heel calks.',
    hardness: 'soft',
    shape: {
      width: 7.15, length: 7.5, bowDepth: 2.6, squareness: 2.35, legLean: 1.4,
      bandToe: 1.24, bandLeg: 0.8, bandHeel: 0.86, thickness: 0.5,
      hookReach: 0.95, hookTip: 0.34, hookThroat: 0.3, hookCurl: 0.08, heelPoint: 0.85, heelFlare: 0.04,
      heelCalk: { kind: 'bevel', height: 0.36, length: 0.85, reach: 0.2 },
      toeCalk: { height: 0.28, length: 1.55, width: 0.42 },
      toeNotch: 0.12,
    },
    stamp: { text: 'COMPETITION', style: 'panel', sides: ['DROP', 'FORGED'], under: 'Ω' },
    finish: 'metal',
    color: [210, 0.05, 0.52],
  },
};

export interface FinishSpec {
  id: FinishId;
  name: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
}

export const FINISHES: Record<FinishId, FinishSpec> = {
  gloss: { id: 'gloss', name: 'Gloss', metalness: 0.08, roughness: 0.3, clearcoat: 0.32 },
  satin: { id: 'satin', name: 'Satin', metalness: 0.05, roughness: 0.52, clearcoat: 0.05 },
  metal: { id: 'metal', name: 'Metal', metalness: 1, roughness: 0.42, clearcoat: 0 },
  chrome: { id: 'chrome', name: 'Chrome', metalness: 1, roughness: 0.04, clearcoat: 0.3 },
};

/** Quick colour picks shown above the sliders. */
export const COLOR_PRESETS: { name: string; color: Hsv; finish?: FinishId }[] = [
  { name: 'Black', color: [220, 0.08, 0.07] },
  { name: 'Red', color: [356, 0.93, 0.78] },
  { name: 'Green', color: [128, 0.85, 0.66] },
  { name: 'Silver', color: [210, 0.05, 0.52], finish: 'metal' },
  { name: 'Blue', color: [222, 0.88, 0.7] },
  { name: 'Orange', color: [22, 0.95, 0.95] },
  { name: 'Yellow', color: [48, 0.92, 0.98] },
  { name: 'Purple', color: [275, 0.7, 0.6] },
  { name: 'Pink', color: [330, 0.62, 0.95] },
  { name: 'White', color: [40, 0.04, 0.95] },
  { name: 'Gold', color: [43, 0.62, 0.95], finish: 'metal' },
  { name: 'Copper', color: [20, 0.62, 0.86], finish: 'metal' },
];

/** HSV to 0..1 sRGB components. */
export function hsvToRgb([h, s, v]: Hsv): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

export function hsvToCss(c: Hsv): string {
  const [r, g, b] = hsvToRgb(c);
  const x = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}

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
  model: ModelId;
  weight: WeightId;
  finish: FinishId;
  color: Hsv;
}

export const DEFAULT_LOADOUT: Loadout = { model: 'competition', weight: '2-8', finish: 'metal', color: [210, 0.05, 0.52] };

/** A model in its factory finish. */
export function factoryLoadout(model: ModelId, weight: WeightId = DEFAULT_LOADOUT.weight): Loadout {
  const m = MODELS[model];
  return { model, weight, finish: m.finish, color: [...m.color] };
}

const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);

export function sanitizeLoadout(l: Partial<Loadout> | undefined): Loadout {
  const model = l?.model && MODELS[l.model] ? l.model : DEFAULT_LOADOUT.model;
  const weight = l?.weight && WEIGHTS[l.weight] ? l.weight : DEFAULT_LOADOUT.weight;
  const factory = factoryLoadout(model, weight);
  const finish = l?.finish && FINISHES[l.finish] ? l.finish : factory.finish;
  const c = Array.isArray(l?.color) ? l.color : factory.color;
  const h = typeof c[0] === 'number' && Number.isFinite(c[0]) ? ((c[0] % 360) + 360) % 360 : factory.color[0];
  return { model, weight, finish, color: [h, clamp01(c[1], factory.color[1]), clamp01(c[2], factory.color[2])] };
}

export function sameLoadout(a: Loadout, b: Loadout): boolean {
  return a.model === b.model && a.weight === b.weight && a.finish === b.finish && a.color.every((v, i) => Math.abs(v - b.color[i]) < 1e-6);
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

/** 0..1, how far between the lightest and heaviest legal weight. */
function heaviness(l: Loadout): number {
  return (WEIGHTS[l.weight].kg - WEIGHTS['2-2'].kg) / (SHOE_LIMITS.maxWeightKg - WEIGHTS['2-2'].kg);
}

export function shoeTraits(l: Loadout): ShoeTraits {
  const heavy = heaviness(l);
  const s = MODELS[l.model].shape;
  // Broad, square shoes carry more of their mass out wide and fly steadier.
  const spread = (s.width - 7) * 0.6 + (s.squareness - 2.3) * 0.08;
  return {
    massKg: WEIGHTS[l.weight].kg,
    restitution: HARDNESS_RESTITUTION[MODELS[l.model].hardness],
    wobbleScale: (1.15 - 0.3 * heavy) * (1 - spread),
    rotationScale: 0.9 + 0.2 * heavy,
  };
}

/** 0..100 ratings for the pro-shop bars. */
export function shoeRatings(l: Loadout): { catch: number; hold: number; stability: number; deadness: number; control: number } {
  const s = MODELS[l.model].shape;
  const t = shoeTraits(l);
  const heavy = heaviness(l);
  const clamp = (v: number) => Math.round(Math.max(5, Math.min(100, v)));
  const inside = s.width - 2 * s.bandLeg; // inside width between the legs
  return {
    catch: clamp(30 + (inside - 4.8) * 70 + (s.squareness - 2) * 14 + (s.length - 7.3) * 30),
    hold: clamp(20 + s.hookReach * 45 + s.hookCurl * 70 + s.heelCalk.height * 40 + s.heelCalk.reach * 8),
    stability: clamp(40 + heavy * 40 + (1 - t.wobbleScale / (1.15 - 0.3 * heavy)) * 300),
    deadness: clamp(100 - t.restitution * 170 + heavy * 12),
    control: clamp(80 - heavy * 25 - (s.squareness - 2.2) * 8),
  };
}

export const inches = (m: number) => m / IN;
