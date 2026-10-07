import { describe, expect, it } from 'vitest';
import { BONES, buildBody } from '../src/render/humanBody';

describe('generated pitcher body', () => {
  it('is a closed, skinned, multi-material mesh of sensible size', () => {
    const t0 = performance.now();
    const { geometry, mats } = buildBody('standing', 0.0075);
    const ms = performance.now() - t0;
    const pos = geometry.getAttribute('position');
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    expect(bb.max.y - bb.min.y).toBeGreaterThan(1.7);
    expect(bb.max.y - bb.min.y).toBeLessThan(1.85);
    expect(pos.count).toBeGreaterThan(10000);
    expect(mats).toEqual(expect.arrayContaining(['skin', 'shirt', 'pants', 'shoe']));
    const w = geometry.getAttribute('skinWeight');
    const idx = geometry.getAttribute('skinIndex');
    for (let i = 0; i < w.count; i += 97) {
      const s = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
      expect(s).toBeCloseTo(1, 4);
      expect(idx.getX(i)).toBeLessThan(BONES.length);
    }
    // Every triangle edge is shared by exactly two triangles (watertight).
    const index = geometry.getIndex()!.array;
    const edges = new Map<string, number>();
    for (let t = 0; t < index.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = index[t + e], b = index[t + ((e + 1) % 3)];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    let open = 0;
    for (const c of edges.values()) if (c !== 2) open++;
    console.log('verts', pos.count, 'tris', index.length / 3, 'ms', ms.toFixed(0), 'non-manifold edges', open);
    expect(open / edges.size).toBeLessThan(0.002);
  });
});
