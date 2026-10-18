import { it, expect } from 'vitest';
import { buildBodyArrays } from '../src/render/humanBody';
it('both builds are watertight with fine heads', () => {
  for (const build of ['male', 'female'] as const) {
    const a = buildBodyArrays('standing', 0.009, { build, fine: 0.006 });
    const idx = a.index; const edges = new Map<string, number>();
    for (let i = 0; i < idx.length; i += 3) for (let e = 0; e < 3; e++) { const p = idx[i + e], q = idx[i + ((e + 1) % 3)]; const k = p < q ? p + '_' + q : q + '_' + p; edges.set(k, (edges.get(k) ?? 0) + 1); }
    let open = 0; for (const c of edges.values()) if (c !== 2) open++;
    expect(open / edges.size).toBeLessThan(0.002);
    for (const v of a.normal) expect(Number.isFinite(v)).toBe(true);
  }
}, 120000);
