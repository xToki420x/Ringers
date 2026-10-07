import type { PitchDistance } from '../core/constants';
import { DEFAULT_LOADOUT, sanitizeLoadout, type BrandId, type Grip, type Loadout } from '../core/equipment';
import type { ScoringMode } from '../core/scoring';
import type { Difficulty } from '../input/throwControl';
import type { PitMaterial } from '../physics/physicsWorld';
import type { Quality } from '../render/textures';
import type { TimeOfDay } from './match';
import type { Tournament } from './tournament';

export interface Settings {
  volume: number;
  haptics: boolean;
  hand: 1 | -1;
  difficulty: Difficulty;
  guides: boolean;
  quality: Quality;
  metric: boolean;
  slowmo: boolean;
  fastAi: boolean;
}

export interface Career {
  games: number;
  wins: number;
  shoes: number;
  ringers: number;
  doubles: number;
  inCount: number;
  countPoints: number;
  bestRingerPct: number;
  longestRingerStreak: number;
  titles: number;
  tournaments: number;
  practiceShoes: number;
  practiceRingers: number;
}

export interface QuickPrefs {
  opponent: number;
  mode: ScoringMode;
  target: number;
  distance: PitchDistance;
  pit: PitMaterial;
  time: TimeOfDay;
}

export interface SaveData {
  version: 1;
  name: string;
  settings: Settings;
  loadout: Loadout;
  grip: Grip;
  career: Career;
  unlocked: BrandId[];
  quick: QuickPrefs;
  tournament: Tournament | null;
  seenTutorial: boolean;
}

const KEY = 'ringers.save.v1';

function defaultQuality(): Quality {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mem <= 2 || cores <= 4) return 'low';
  if (mem <= 4) return 'medium';
  return 'high';
}

export function defaults(): SaveData {
  return {
    version: 1,
    name: 'You',
    settings: { volume: 0.8, haptics: true, hand: 1, difficulty: 'amateur', guides: true, quality: defaultQuality(), metric: false, slowmo: true, fastAi: false },
    loadout: { ...DEFAULT_LOADOUT },
    grip: 'flip',
    career: {
      games: 0, wins: 0, shoes: 0, ringers: 0, doubles: 0, inCount: 0, countPoints: 0, bestRingerPct: 0,
      longestRingerStreak: 0, titles: 0, tournaments: 0, practiceShoes: 0, practiceRingers: 0,
    },
    unlocked: [],
    quick: { opponent: 1, mode: 'cancellation', target: 21, distance: 40, pit: 'sand', time: 'afternoon' },
    tournament: null,
    seenTutorial: false,
  };
}

export function load(): SaveData {
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<SaveData>;
    return {
      ...d,
      ...s,
      settings: { ...d.settings, ...(s.settings ?? {}) },
      career: { ...d.career, ...(s.career ?? {}) },
      quick: { ...d.quick, ...(s.quick ?? {}) },
      loadout: sanitizeLoadout(s.loadout),
      tournament: s.tournament && s.tournament.version === 1 ? s.tournament : null,
    };
  } catch {
    return d;
  }
}

export function save(data: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage full or unavailable: progress is kept for this session only */
  }
}

export function resetSave(): SaveData {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return defaults();
}
