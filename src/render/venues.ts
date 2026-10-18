import type { GrassStyle } from './lawn';

/**
 * Places to pitch. Each venue is a complete setting around the same
 * regulation court: its own number of courts, grass, trees, buildings and
 * props. The court itself (pits, boxes, stakes, foul lines) never changes.
 */

export type VenueId = 'championship' | 'backyard' | 'park' | 'lakeside';

export interface VenueInfo {
  id: VenueId;
  name: string;
  blurb: string;
  /** Courts side by side (the playing court is always the centre one). */
  courts: 1 | 2 | 3 | 5;
  grass: GrassStyle;
  /** How big a crowd reacts to good shoes (scales the cheering; 0 = nobody watching). */
  audience: number;
}

export const VENUES: Record<VenueId, VenueInfo> = {
  championship: {
    id: 'championship',
    name: 'Championship Grounds',
    blurb: 'Five courts, grandstands, banners and floodlights.',
    courts: 5,
    grass: 'manicured',
    audience: 1,
  },
  backyard: {
    id: 'backyard',
    name: 'Backyard',
    blurb: 'One court behind the house: deck, picnic table, string lights and a tall privacy fence.',
    courts: 1,
    grass: 'backyard',
    audience: 0.15,
  },
  park: {
    id: 'park',
    name: 'City Park',
    blurb: 'Three public courts under big oaks and maples, with benches, paths and a picnic shelter.',
    courts: 3,
    grass: 'park',
    audience: 0.35,
  },
  lakeside: {
    id: 'lakeside',
    name: 'Lakeside Pines',
    blurb: 'Two courts in a campground clearing by the lake, ringed with pines.',
    courts: 2,
    grass: 'meadow',
    audience: 0.15,
  },
};

export const DEFAULT_VENUE: VenueId = 'championship';

export const venueOf = (id: string | undefined): VenueId => (id && id in VENUES ? (id as VenueId) : DEFAULT_VENUE);

/**
 * Which courts are laid out, as multiples of the court spacing from the
 * playing court (always 0): neighbours fill in to one side, then both.
 */
export function courtSlots(id: VenueId): number[] {
  switch (VENUES[id].courts) {
    case 1:
      return [0];
    case 2:
      return [0, 1];
    case 3:
      return [-1, 0, 1];
    case 5:
      return [-2, -1, 0, 1, 2];
  }
}

export const VENUE_IDS = Object.keys(VENUES) as VenueId[];
