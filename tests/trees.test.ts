import { describe, expect, test } from 'vitest';
import type * as THREE from 'three';
import { growTree, VARIANTS } from '../src/render/treeGrowth';
import { buildTreeGeometry } from '../src/render/treeMesh';
import type { TreeSpecies } from '../src/render/trees';

const SPECIES: TreeSpecies[] = ['oak', 'maple', 'birch', 'pine'];
const TIERS = ['high', 'medium', 'low'] as const;

/** Smallest triangle area and worst normal (length error), plus anything non-finite. */
function inspect(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position').array as ArrayLike<number>;
  const nrm = g.getAttribute('normal').array as ArrayLike<number>;
  const idx = g.getIndex()!.array as ArrayLike<number>;
  let minArea = Infinity, worstNormal = 0, finite = true;
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i]) || !Number.isFinite(nrm[i])) finite = false;
  for (let i = 0; i < nrm.length; i += 3) worstNormal = Math.max(worstNormal, Math.abs(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) - 1));
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    minArea = Math.min(minArea, 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx));
  }
  return { minArea, worstNormal, finite, triangles: idx.length / 3 };
}

describe('trees', () => {
  for (const q of TIERS)
    test(`every ${q} variant is clean and within budget`, () => {
      let worst = 0;
      for (const species of SPECIES) {
        let sum = 0;
        for (let v = 0; v < VARIANTS; v++) {
          const { wood, foliage } = buildTreeGeometry(growTree(species, v, q), q, v);
          let tris = 0;
          for (const g of [wood, foliage]) {
            const r = inspect(g);
            expect(r.finite, `${species} ${v}`).toBe(true);
            // No degenerate triangles and only unit normals (zero normals make NaN pixels).
            expect(r.minArea, `${species} ${v}`).toBeGreaterThan(1e-7);
            expect(r.worstNormal, `${species} ${v}`).toBeLessThan(1e-4);
            tris += r.triangles;
          }
          sum += tris;
        }
        // Trees spread evenly over the variants, so the forest costs the mean.
        worst = Math.max(worst, sum / VARIANTS);
      }
      // A forest of one species, 110 trees (50 on low), within the scene budget for the tier.
      const budget = { high: 600_000 / 110, medium: 350_000 / 110, low: 150_000 / 50 }[q];
      expect(worst).toBeLessThan(budget);
    });

  test('species stand at their expected heights', () => {
    for (const species of SPECIES) {
      const h = growTree(species, 0, 'high').height;
      expect(h).toBeGreaterThan(7);
      expect(h).toBeLessThan(species === 'pine' ? 13 : 10.5);
    }
  });
});
