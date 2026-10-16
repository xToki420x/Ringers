import { describe, expect, it } from 'vitest';
import { SHOE_LIMITS } from '../src/core/constants';
import { MODELS, WEIGHTS, hsvToCss, sanitizeLoadout, shoeRatings, type ModelId } from '../src/core/equipment';
import { distToPolygon, pointInPolygon, polygonArea, shoeGeometry } from '../src/core/shoeShape';

describe('equipment is NHPA legal', () => {
  for (const id of Object.keys(MODELS) as ModelId[]) {
    it(`${id} fits the rule book`, () => {
      const g = shoeGeometry(id);
      expect(g.width).toBeLessThanOrEqual(SHOE_LIMITS.maxWidth + 1e-6);
      expect(g.length).toBeLessThanOrEqual(SHOE_LIMITS.maxLength + 1e-6);
      expect(g.opening).toBeLessThanOrEqual(SHOE_LIMITS.maxOpening + 1e-6);
      // Collision proxy must be well formed.
      for (const sp of g.spheres) for (const v of [sp.x, sp.y, sp.z, sp.r]) expect(Number.isFinite(v)).toBe(true);
      // Opening must still admit the 1" stake comfortably.
      expect(g.opening).toBeGreaterThan(0.0254 * 2.2);
      // Calks sit under the plate.
      for (const c of g.calks) for (const p of c.base) expect(pointInPolygon(p, g.outline) || distToPolygon(p, g.outline) < 0.0008).toBe(true);
      // The judged inside of the shoe is a real area between the heels.
      expect(Math.abs(polygonArea(g.innerPolygon))).toBeGreaterThan(0.0254 ** 2 * 12);
    });
  }
  it('weights never exceed 2 lb 10 oz', () => {
    for (const w of Object.values(WEIGHTS)) expect(w.kg).toBeLessThanOrEqual(SHOE_LIMITS.maxWeightKg + 1e-9);
  });
  it('sanitizes bad and old loadouts', () => {
    const old = sanitizeLoadout({ brand: 'prairie', shape: 'hook', finish: 'candy' } as never);
    expect(MODELS[old.model]).toBeDefined();
    expect(old.color).toHaveLength(3);
    const odd = sanitizeLoadout({ model: 'cadet', weight: '2-4', finish: 'satin', color: [400, 2, -1] });
    expect(odd).toEqual({ model: 'cadet', weight: '2-4', finish: 'satin', color: [40, 1, 0] });
    for (const id of Object.keys(MODELS) as ModelId[]) expect(shoeRatings(sanitizeLoadout({ model: id })).catch).toBeGreaterThan(0);
  });
  it('converts slider colours', () => {
    expect(hsvToCss([0, 1, 1])).toBe('#ff0000');
    expect(hsvToCss([120, 1, 0.5])).toBe('#008000');
    expect(hsvToCss([0, 0, 1])).toBe('#ffffff');
  });
});
