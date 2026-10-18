import type { GrassStyle } from './lawn';

/**
 * Look of each grass style, shared by the 3D blades and the ground texture
 * so the two always match: blade sizes, how evenly the lawn is kept, its
 * colours (sRGB), and which features (mowing stripes, clover, weeds, dry
 * patches, worn ground, long wild grass) it has.
 */
export interface GrassLook {
  /** Lawn blade height range, metres. */
  height: [number, number];
  /** Patchy height variation on top of the range (0 = evenly mown). */
  uneven: number;
  /** How far the blades of one shoot splay apart (1 = every way; mown grass lies together). */
  spread: number;
  /** Bend from root to tip, radians. */
  lean: [number, number];
  /** Blade half-width at the root, metres. */
  width: number;
  /** Multiplier on blade density. */
  density: number;
  /** Per-shoot colour variation (0..1). */
  variety: number;
  /** Sunlit blade tip, blade root, ground seen from above. */
  tip: number;
  root: number;
  ground: number;
  /** Straw of dry or dead grass, clover leaves, bare soil. */
  dry: number;
  clover: number;
  soil: number;
  /** Mowing stripe contrast (0 = none) and stripe width, metres. */
  stripes: number;
  stripeWidth: number;
  /** Share of the ground in clover patches and in dry patches (0..1). */
  cloverCover: number;
  dryCover: number;
  /** Wear where players walk and stand, and how much bare soil it exposes. */
  wear: number;
  soilShow: number;
  /** Broadleaf weed rosettes and flowers per square metre (high quality). */
  weeds: number;
  flowers: number;
  /** Long, unmown grass beyond the courts (lakeside meadow). */
  wild: boolean;
}

export const GRASS_LOOKS: Record<GrassStyle, GrassLook> = {
  manicured: {
    height: [0.04, 0.06],
    uneven: 0.05,
    spread: 0.3,
    lean: [0.45, 1.0],
    width: 0.0024,
    density: 1,
    variety: 0.5,
    tip: 0x3f5f20,
    root: 0x1a2c0d,
    ground: 0x3a541c,
    dry: 0x6c6436,
    clover: 0x365a22,
    soil: 0x6a5640,
    stripes: 0.12,
    stripeWidth: 3.66,
    cloverCover: 0,
    dryCover: 0,
    wear: 0.35,
    soilShow: 0,
    weeds: 0,
    flowers: 0,
    wild: false,
  },
  backyard: {
    height: [0.05, 0.09],
    uneven: 0.35,
    spread: 1,
    lean: [0.4, 1.2],
    width: 0.0026,
    density: 0.9,
    variety: 0.7,
    tip: 0x506422,
    root: 0x223212,
    ground: 0x485a20,
    dry: 0x72663a,
    clover: 0x385c24,
    soil: 0x645038,
    stripes: 0,
    stripeWidth: 1,
    cloverCover: 0.2,
    dryCover: 0.06,
    wear: 1,
    soilShow: 0.9,
    weeds: 3,
    flowers: 1.2,
    wild: false,
  },
  park: {
    height: [0.06, 0.12],
    uneven: 0.45,
    spread: 1,
    lean: [0.4, 1.35],
    width: 0.0027,
    density: 0.85,
    variety: 1,
    tip: 0x566226,
    root: 0x263214,
    ground: 0x4e5824,
    dry: 0x7a6c3c,
    clover: 0x3a5e26,
    soil: 0x68543a,
    stripes: 0,
    stripeWidth: 1,
    cloverCover: 0.12,
    dryCover: 0.2,
    wear: 0.8,
    soilShow: 0.6,
    weeds: 5,
    flowers: 0.8,
    wild: false,
  },
  meadow: {
    height: [0.05, 0.08],
    uneven: 0.25,
    spread: 0.9,
    lean: [0.4, 1.1],
    width: 0.0025,
    density: 0.8,
    variety: 0.6,
    tip: 0x4a6220,
    root: 0x203010,
    ground: 0x44581e,
    dry: 0x7c6e40,
    clover: 0x385c24,
    soil: 0x645238,
    stripes: 0,
    stripeWidth: 1,
    cloverCover: 0.05,
    dryCover: 0.05,
    wear: 0.4,
    soilShow: 0.15,
    weeds: 1,
    flowers: 0.4,
    wild: true,
  },
};

/** Long meadow grass beyond the mown area: blade colour, ground colour and ripe seed heads. */
export const WILD = { tip: 0x5c6a2a, root: 0x232e10, ground: 0x4c5a24, seed: 0x7a6440 };
