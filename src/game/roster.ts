import { BRANDS, SHAPES, type BrandId, type Grip, type Loadout, type ShapeId, type WeightId } from '../core/equipment';
import { mulberry32 } from '../physics/errorModel';
import type { PlayerInfo } from './match';

/** Fictional touring pitchers. */
const FIRST = [
  'Earl', 'Dale', 'Rusty', 'Walt', 'June', 'Darlene', 'Hank', 'Lyle', 'Marge', 'Clem', 'Vern', 'Wanda', 'Buck', 'Opal',
  'Gus', 'Nell', 'Roy', 'Della', 'Cal', 'Ruth', 'Floyd', 'Ida', 'Merle', 'Faye', 'Otis', 'Pearl', 'Del', 'Bonnie', 'Amos',
  'Lucille', 'Jed', 'Hattie', 'Wade', 'Iris', 'Boone', 'Edna', 'Cyrus', 'Mabel', 'Zeke', 'Velma', 'Luther', 'Dot', 'Ray',
  'Inez', 'Elmer', 'Rosa', 'Abe', 'Coral', 'Ty', 'Lena', 'Nash', 'Wren', 'Jo', 'Mack', 'Tess', 'Dean', 'Hazel', 'Carl',
];
const LAST = [
  'Hollister', 'McCready', 'Barlow', 'Swenson', 'Tate', 'Pruitt', 'Lindqvist', 'Oakes', 'Delaney', 'Gentry', 'Haskins',
  'Moreau', 'Pickett', 'Rasmussen', 'Stroud', 'Voss', 'Whitlock', 'Yoder', 'Abernathy', 'Bramlett', 'Coker', 'Dunlap',
  'Ebersole', 'Fairchild', 'Gaskill', 'Hobbs', 'Ingram', 'Jessup', 'Kimbrough', 'Lockhart', 'Mayfield', 'Nesbitt', 'Ogle',
  'Pemberton', 'Quarles', 'Redd', 'Sizemore', 'Truitt', 'Underhill', 'Vickers', 'Wampler', 'Yarbrough', 'Zeller',
];
const TOWNS = [
  'Greenville, OH', 'Topeka, KS', 'Des Moines, IA', 'Bowling Green, KY', 'Fargo, ND', 'Lubbock, TX', 'Spokane, WA',
  'Duluth, MN', 'Peoria, IL', 'Joplin, MO', 'Muncie, IN', 'Erie, PA', 'Boise, ID', 'Casper, WY', 'Bangor, ME',
  'Asheville, NC', 'Eau Claire, WI', 'Sioux Falls, SD', 'Billings, MT', 'Grand Island, NE', 'Red Deer, AB', 'Moncton, NB',
];

export interface Opponent extends PlayerInfo {
  rating: number;
  hometown: string;
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function randomLoadout(rng: () => number): Loadout {
  const brands = (Object.keys(BRANDS) as BrandId[]);
  const brand = pick(brands, rng);
  const shape = pick(Object.keys(SHAPES) as ShapeId[], rng);
  const weight = pick(['2-6', '2-8', '2-8', '2-10', '2-10'] as WeightId[], rng);
  const finish = pick(BRANDS[brand].finishes, rng);
  return { brand, shape, weight, finish };
}

export function makeOpponent(seed: number, rating: number): Opponent {
  const rng = mulberry32(seed);
  const grips: Grip[] = ['flip', 'flip', 'turn134', 'turn134', 'turn114'];
  return {
    id: `ai-${seed}`,
    name: `${pick(FIRST, rng)} ${pick(LAST, rng)}`,
    isHuman: false,
    hand: rng() < 0.85 ? 1 : -1,
    grip: pick(grips, rng),
    loadout: randomLoadout(rng),
    rating: Math.round(rating * 10) / 10,
    hometown: pick(TOWNS, rng),
  };
}

/** Opponents offered for an exhibition match, easiest first. */
export const EXHIBITION_OPPONENTS: Opponent[] = [
  { ...makeOpponent(11, 12), name: 'Gus Barlow', hometown: 'Backyard League' },
  { ...makeOpponent(23, 28), name: 'Darlene Pruitt', hometown: 'County Fair Champ' },
  { ...makeOpponent(37, 45), name: 'Walt Swenson', hometown: 'State Class B' },
  { ...makeOpponent(41, 62), name: 'Marge Delaney', hometown: 'State Champion' },
  { ...makeOpponent(59, 76), name: 'Hank Whitlock', hometown: 'World Class A' },
  { ...makeOpponent(67, 88), name: '“Dead Center” Voss', hometown: 'Five-time World Champion' },
];
