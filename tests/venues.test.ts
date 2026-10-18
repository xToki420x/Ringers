import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { courtSlots, DEFAULT_VENUE, VENUE_IDS, VENUES, venueOf } from '../src/render/venues';
import { cleanGeometry, gableRoof, gableShell, ribbon, worldUV } from '../src/render/venueKit';
import { lampPost, parkBench, picnicTable, trashCan, windowUnit } from '../src/render/props';

/** Smallest triangle area, worst normal length error and whether everything is finite (non-indexed geometry). */
function inspect(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position').array as ArrayLike<number>;
  const nrm = g.getAttribute('normal').array as ArrayLike<number>;
  let minArea = Infinity, worstNormal = 0, finite = true;
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]) || !Number.isFinite(nrm[i])) finite = false;
  for (let i = 0; i < nrm.length; i += 3) worstNormal = Math.max(worstNormal, Math.abs(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) - 1));
  for (let t = 0; t < pos.length; t += 9) {
    const ux = pos[t + 3] - pos[t], uy = pos[t + 4] - pos[t + 1], uz = pos[t + 5] - pos[t + 2];
    const vx = pos[t + 6] - pos[t], vy = pos[t + 7] - pos[t + 1], vz = pos[t + 8] - pos[t + 2];
    minArea = Math.min(minArea, 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx));
  }
  return { minArea, worstNormal, finite, triangles: pos.length / 9 };
}

const flatten = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

describe('venues', () => {
  test('unknown or missing venues fall back to the championship grounds', () => {
    expect(venueOf(undefined)).toBe('championship');
    expect(venueOf('')).toBe('championship');
    expect(venueOf('moon')).toBe(DEFAULT_VENUE);
    for (const id of VENUE_IDS) expect(venueOf(id)).toBe(id);
  });

  test('every venue lays out its number of courts around the playing court', () => {
    for (const id of VENUE_IDS) {
      const slots = courtSlots(id);
      expect(slots).toHaveLength(VENUES[id].courts);
      expect(slots).toContain(0);
      expect(new Set(slots).size).toBe(slots.length);
    }
  });
});

describe('save migration', () => {
  afterEach(() => vi.unstubAllGlobals());

  const loadWith = async (stored: unknown) => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('localStorage', { getItem: () => (stored === null ? null : JSON.stringify(stored)), setItem: () => {}, removeItem: () => {} });
    vi.resetModules();
    const { load } = await import('../src/game/save');
    return load();
  };

  test('old saves without a venue play at the championship grounds', async () => {
    const d = await loadWith({ version: 1, name: 'Ace', quick: { opponent: 2, mode: 'countall', target: 40, distance: 30, pit: 'clay', time: 'sunset' } });
    expect(d.quick.venue).toBe('championship');
    expect(d.quick.opponent).toBe(2);
    expect(d.quick.time).toBe('sunset');
  });

  test('a chosen venue is kept, an unknown one is replaced', async () => {
    expect((await loadWith({ version: 1, quick: { venue: 'lakeside' } })).quick.venue).toBe('lakeside');
    expect((await loadWith({ version: 1, quick: { venue: 'volcano' } })).quick.venue).toBe('championship');
    expect((await loadWith(null)).quick.venue).toBe('championship');
  });
});

describe('venue geometry', () => {
  test('cleanGeometry drops zero-area triangles and repairs bad normals', () => {
    const g = new THREE.BufferGeometry();
    // One good triangle with a zero normal, one collapsed to a line.
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    const c = inspect(cleanGeometry(g));
    expect(c.triangles).toBe(1);
    expect(c.finite).toBe(true);
    expect(c.worstNormal).toBeLessThan(1e-5);
  });

  test('buildings, roofs, paths and furniture are clean after merging', () => {
    const parts: THREE.BufferGeometry[] = [
      gableShell(9, 13, 3.3, 5.7, 0, 27),
      ...gableRoof(9, 13, 3.3, 5.7, 0, 27, { eave: 0.45, rake: 0.35, t: 0.12, rotY: 0.4 }),
      ribbon([[-10, -14], [-10.5, 0], [-13, 30]], 2.2),
      ...picnicTable(),
      ...parkBench().wood,
      ...parkBench().iron,
      ...trashCan(),
      ...lampPost(3.6).metal,
      ...lampPost(3.6).lamp,
      ...windowUnit(1.1, 1.35).trim,
    ];
    for (const p of parts) {
      const g = cleanGeometry(worldUV(flatten(p), 1));
      const r = inspect(g);
      expect(r.triangles).toBeGreaterThan(0);
      expect(r.finite).toBe(true);
      expect(r.minArea).toBeGreaterThan(1e-9);
      expect(r.worstNormal).toBeLessThan(1e-4);
      const uv = g.getAttribute('uv').array as ArrayLike<number>;
      for (let i = 0; i < uv.length; i++) expect(Number.isFinite(uv[i])).toBe(true);
    }
  });
});
