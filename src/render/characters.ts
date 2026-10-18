import type { Build } from './characterModels';
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
    look: { id: 'cody', build: 'male', shirt: '#1b365d', pants: '#c2a57a', shoes: '#5a5d63', cap: '#16273f', trims: ['scorecard', 'wristband', 'patch'] },
  },
  sarah: {
    name: 'Sarah Martinez',
    nickname: 'Ringer Queen',
    blurb: 'Regional champion, 5′8″. Confident, encouraging, a fierce competitor.',
    look: { id: 'sarah', build: 'female', shirt: '#8b1e3f', pants: '#202020', shoes: '#34353a', cap: null, trims: ['pencil', 'watch', 'beltbag'] },
  },
};

/** Club looks for an opponent who shares your character's build. */
const CLUB_LOOKS: Record<Build, PitcherLook> = {
  male: { id: 'club-male', build: 'male', shirt: '#7c2128', pants: '#3a3d44', shoes: '#2b2c30', cap: '#1a1b1e', trims: ['wristband'] },
  female: { id: 'club-female', build: 'female', shirt: '#1f5f8b', pants: '#2a3442', shoes: '#e8e6e0', cap: null, trims: ['watch'] },
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
