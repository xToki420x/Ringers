import { COLOR_PRESETS, MODELS, factoryLoadout, type Grip, type Loadout, type ModelId, type WeightId } from '../core/equipment';
import { mulberry32 } from '../physics/errorModel';
import type { Build } from '../render/characterModels';
import type { PlayerInfo } from './match';

/** Fictional touring pitchers. */
const FIRST = [
  'Earl', 'Dale', 'Rusty', 'Walt', 'June', 'Darlene', 'Hank', 'Lyle', 'Marge', 'Clem', 'Vern', 'Wanda', 'Buck', 'Opal',
  'Gus', 'Nell', 'Roy', 'Della', 'Cal', 'Ruth', 'Floyd', 'Ida', 'Merle', 'Faye', 'Otis', 'Pearl', 'Del', 'Bonnie', 'Amos',
  'Lucille', 'Jed', 'Hattie', 'Wade', 'Iris', 'Boone', 'Edna', 'Cyrus', 'Mabel', 'Zeke', 'Velma', 'Luther', 'Dot', 'Ray',
  'Inez', 'Elmer', 'Rosa', 'Abe', 'Coral', 'Ty', 'Lena', 'Nash', 'Wren', 'Jo', 'Mack', 'Tess', 'Dean', 'Hazel', 'Carl',
];
const FEMALE = new Set([
  'June', 'Darlene', 'Marge', 'Wanda', 'Opal', 'Nell', 'Della', 'Ruth', 'Ida', 'Faye', 'Pearl', 'Bonnie', 'Lucille', 'Hattie',
  'Iris', 'Edna', 'Mabel', 'Velma', 'Dot', 'Inez', 'Rosa', 'Coral', 'Lena', 'Wren', 'Jo', 'Tess', 'Hazel', 'Sarah',
]);

/** Which body a pitcher of this name is drawn with (by first name; unknown names get the male build). */
export function buildOfName(name: string): Build {
  const first = name.replace(/[“"][^”"]*[”"]\s*/g, '').trim().split(/\s+/)[0] ?? '';
  return FEMALE.has(first) ? 'female' : 'male';
}

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
  const model = pick(Object.keys(MODELS) as ModelId[], rng);
  const weight = pick(['2-6', '2-8', '2-8', '2-10', '2-10'] as WeightId[], rng);
  // Half the tour pitches factory colours; the rest have their own.
  if (rng() < 0.5) return factoryLoadout(model, weight);
  const preset = pick(COLOR_PRESETS, rng);
  return { model, weight, finish: preset.finish ?? (rng() < 0.75 ? 'gloss' : 'satin'), color: [...preset.color] };
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
