import { describe, expect, it } from 'vitest';
import { SHOE_LIMITS } from '../src/core/constants';
import { BRANDS, SHAPES, WEIGHTS, sanitizeLoadout, shoeRatings, type ShapeId } from '../src/core/equipment';
import { shoeGeometry } from '../src/core/shoeShape';

describe('equipment is NHPA legal', () => {
  for (const id of Object.keys(SHAPES) as ShapeId[]) {
    it(`${id} shape fits the rule book`, () => {
      const g = shoeGeometry(id);
      expect(g.width).toBeLessThanOrEqual(SHOE_LIMITS.maxWidth + 1e-6);
      expect(g.length).toBeLessThanOrEqual(SHOE_LIMITS.maxLength + 1e-6);
      expect(g.opening).toBeLessThanOrEqual(SHOE_LIMITS.maxOpening + 1e-6);
      // Collision proxy must be well formed.
      for (const sp of g.spheres) for (const v of [sp.x, sp.y, sp.z, sp.r]) expect(Number.isFinite(v)).toBe(true);
      // Opening must still admit the 1" stake comfortably.
      expect(g.opening).toBeGreaterThan(0.0254 * 2.2);
    });
  }
  it('weights never exceed 2 lb 10 oz', () => {
    for (const w of Object.values(WEIGHTS)) expect(w.kg).toBeLessThanOrEqual(SHOE_LIMITS.maxWeightKg + 1e-9);
  });
  it('sanitizes bad loadouts', () => {
    const l = sanitizeLoadout({ brand: 'prairie', finish: 'chrome' as never });
    expect(BRANDS.prairie.finishes).toContain(l.finish);
    expect(shoeRatings(l).catch).toBeGreaterThan(0);
  });
});
