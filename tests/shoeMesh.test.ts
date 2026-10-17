import { describe, expect, it } from 'vitest';
import { shoeBufferGeometry } from '../src/render/shoeMesh';
import { MODELS, type ModelId } from '../src/core/equipment';

// A zero-length normal becomes NaN on the GPU; bloom smears a NaN pixel into
// flashing blocks. Every shoe mesh must have clean geometry.
describe('shoe meshes are clean', () => {
  for (const id of Object.keys(MODELS) as ModelId[]) {
    it(`${id} has no degenerate triangles or bad normals`, () => {
      const g = shoeBufferGeometry(id);
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      for (let i = 0; i < n.count; i++) {
        const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
        expect(Math.abs(l - 1)).toBeLessThan(1e-3);
        expect([p.getX(i), p.getY(i), p.getZ(i)].every(Number.isFinite)).toBe(true);
      }
      for (let t = 0; t < p.count; t += 3) {
        const ax = p.getX(t + 1) - p.getX(t), ay = p.getY(t + 1) - p.getY(t), az = p.getZ(t + 1) - p.getZ(t);
        const bx = p.getX(t + 2) - p.getX(t), by = p.getY(t + 2) - p.getY(t), bz = p.getZ(t + 2) - p.getZ(t);
        expect(Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx)).toBeGreaterThan(1e-12);
      }
    });
  }
});
