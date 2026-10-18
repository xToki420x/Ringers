import type { Build } from './humanBody';
import type { PitcherLook } from './pitcher';

/**
 * The game's two signature pitchers. You play as one; opponents are drawn
 * from the same two bodies, wearing the other signature look or, when they
 * share your character's build, a club look of their own.
 */

export type CharacterId = 'cody' | 'sarah';

export interface Character {
  name: string;
  nickname: string;
  blurb: string;
  look: PitcherLook;
}

export const CHARACTERS: Record<CharacterId, Character> = {
  cody: {
    name: 'Cody Walker',
    nickname: 'Deadeye',
    blurb: 'Tournament pitcher, 6′1″. Calm, friendly, fiercely competitive.',
    look: {
      id: 'cody', build: 'male', height: 1.85,
      shirt: '#1b365d', pants: '#c2a57a', belt: '#6a4e36', skin: '#d4a07a', hair: '#3a2a1e', eyes: '#4f7fb3',
      shoes: '#5c5f64', sole: '#d6d1c6', cap: '#16273f', stubble: true, glove: null,
      trims: ['buckle', 'scorecard', 'wristband', 'patch'],
    },
  },
  sarah: {
    name: 'Sarah Martinez',
    nickname: 'Ringer Queen',
    blurb: 'Regional champion, 5′8″. Confident, encouraging, a fierce competitor.',
    look: {
      id: 'sarah', build: 'female', height: 1.73,
      shirt: '#8b1e3f', pants: '#202020', belt: '#202020', skin: '#c28a62', hair: '#2a1b14', eyes: '#5a3a22',
      shoes: '#2b2c31', sole: '#ecebe6', cap: null, stubble: false, glove: '#1c1c1e',
      trims: ['braid', 'pencil', 'pin', 'watch', 'beltbag'],
    },
  },
};

/** Club looks for an opponent who shares your character's build. */
const CLUB_LOOKS: Record<Build, PitcherLook> = {
  male: {
    ...CHARACTERS.cody.look, id: 'club-male', height: 1.8,
    shirt: '#7c2128', pants: '#3a3d44', belt: '#2e2015', skin: '#9a6240', hair: '#140e0a', eyes: '#3d2a1c',
    shoes: '#2b2c30', sole: '#e8e5de', cap: '#1a1b1e', trims: ['buckle', 'wristband'],
  },
  female: {
    ...CHARACTERS.sarah.look, id: 'club-female', height: 1.68,
    shirt: '#1f5f8b', pants: '#2a3442', skin: '#e2b48f', hair: '#8a5a32', eyes: '#3f6a4a',
    glove: null, trims: ['braid', 'watch'],
  },
};

export const characterIds = Object.keys(CHARACTERS) as CharacterId[];

export const sanitizeCharacter = (v: unknown): CharacterId => (characterIds.includes(v as CharacterId) ? (v as CharacterId) : 'cody');

/**
 * Looks for the two pitchers of a game. Each player brings a character, or
 * (AI players) just a build; a build is dressed as the signature character of
 * that build unless the other player already wears it.
 */
export function castLooks(players: [{ character?: CharacterId; build?: Build }, { character?: CharacterId; build?: Build }]): [PitcherLook, PitcherLook] {
  const own = players.map((p) => (p.character ? CHARACTERS[p.character].look : null));
  const pick = (i: 0 | 1): PitcherLook => {
    const mine = own[i];
    const other = own[1 - i];
    if (mine && !(i === 1 && other && other.id === mine.id)) return mine;
    const build: Build = mine?.build ?? players[i].build ?? 'male';
    const signature = build === 'male' ? CHARACTERS.cody.look : CHARACTERS.sarah.look;
    return other && other.id === signature.id ? CLUB_LOOKS[build] : signature;
  };
  return [pick(0), pick(1)];
}
