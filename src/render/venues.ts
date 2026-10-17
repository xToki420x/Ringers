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
}

export const VENUES: Record<VenueId, VenueInfo> = {
  championship: {
    id: 'championship',
    name: 'Championship Grounds',
    blurb: 'Five courts, grandstands, banners and floodlights.',
    courts: 5,
    grass: 'manicured',
  },
  backyard: {
    id: 'backyard',
    name: 'Backyard',
    blurb: 'One court behind the house, a picnic table and the neighbour’s fence.',
    courts: 1,
    grass: 'backyard',
  },
  park: {
    id: 'park',
    name: 'City Park',
    blurb: 'Three public courts under big shade trees, with benches and a picnic shelter.',
    courts: 3,
    grass: 'park',
  },
  lakeside: {
    id: 'lakeside',
    name: 'Lakeside Pines',
    blurb: 'Two courts at a campground by the water, ringed with pines.',
    courts: 2,
    grass: 'meadow',
  },
};

export const DEFAULT_VENUE: VenueId = 'championship';

export const venueOf = (id: string | undefined): VenueId => (id && id in VENUES ? (id as VenueId) : DEFAULT_VENUE);
