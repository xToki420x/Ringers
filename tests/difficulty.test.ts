import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT } from '../src/core/equipment';
import { gestureError, P_IDEAL, type Difficulty, type StrokeMeasure } from '../src/input/throwControl';
import { mulberry32 } from '../src/physics/errorModel';
import { PhysicsWorld } from '../src/physics/physicsWorld';
import { simulateThrow } from '../src/physics/simulate';
import { DEFAULT_ARC } from '../src/physics/throwModel';

const delivery = { grip: 'flip' as const, hand: 1 as const, distance: 40 as const, side: 1 as const, targetEnd: 1 as const, arc: DEFAULT_ARC };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Ringer rate for an everyday stroke: a little off on every measure. */
function casualRate(difficulty: Difficulty, n = 40) {
  const r = mulberry32(11);
  let ringers = 0;
  for (let i = 0; i < n; i++) {
    const m: StrokeMeasure = { power: P_IDEAL + gauss(r) * 0.03, rel: gauss(r) * 0.015, drift: gauss(r) * 0.012, sway: gauss(r) * 0.004, dev: Math.abs(gauss(r) * 0.01) };
    if (simulateThrow(new PhysicsWorld('sand'), 1, 0, DEFAULT_LOADOUT, delivery, gestureError(m, difficulty, r)).result.ringer) ringers++;
  }
  return ringers / n;
}

describe('difficulty', () => {
  it('makes ringers hard to come by, and harder at each level', () => {
    const rates = (['amateur', 'pro', 'world'] as Difficulty[]).map((d) => casualRate(d));
    expect(rates[0]).toBeLessThan(0.65);
    expect(rates[2]).toBeLessThan(rates[0]);
    expect(rates[2]).toBeGreaterThan(0);
  }, 120000);

  it('still rewards a clean stroke', () => {
    const r = mulberry32(3);
    const clean: StrokeMeasure = { power: P_IDEAL, rel: 0, drift: 0, sway: 0, dev: 0 };
    let ringers = 0;
    for (let i = 0; i < 20; i++) {
      if (simulateThrow(new PhysicsWorld('sand'), 1, 0, DEFAULT_LOADOUT, delivery, gestureError(clean, 'amateur', r)).result.ringer) ringers++;
    }
    expect(ringers).toBeGreaterThanOrEqual(16);
  }, 120000);
});
