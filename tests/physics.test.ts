import { describe, expect, it } from 'vitest';
import { DEFAULT_LOADOUT, type Grip, type Loadout } from '../src/core/equipment';
import { mulberry32, randomError } from '../src/physics/errorModel';
import { PhysicsWorld } from '../src/physics/physicsWorld';
import { simulateThrow } from '../src/physics/simulate';
import { DEFAULT_ARC, ZERO_ERROR, planRelease, type Delivery } from '../src/physics/throwModel';

const delivery = (grip: Grip = 'flip', targetEnd: 0 | 1 = 1, distance: 40 | 30 = 40, hand: 1 | -1 = 1): Delivery => ({
  grip, hand, distance, side: hand, targetEnd, arc: DEFAULT_ARC,
});

function throwOnce(d: Delivery, err = ZERO_ERROR, loadout: Loadout = DEFAULT_LOADOUT, pit: 'sand' | 'clay' = 'sand') {
  const w = new PhysicsWorld(pit);
  return simulateThrow(w, 1, 0, loadout, d, err);
}

describe('throw model', () => {
  it('a perfect single flip completes exactly one rotation at the stake', () => {
    const plan = planRelease(delivery());
    expect((plan.idealSpin * plan.catchTime) / (2 * Math.PI)).toBeCloseTo(1, 6);
    // Backspin about the lateral axis only.
    expect(Math.abs(plan.state.angvel.y)).toBeLessThan(1e-9);
  });
  it('release speed and arc are in the range of real pitchers', () => {
    const plan = planRelease(delivery());
    expect(plan.speed).toBeGreaterThan(9);
    expect(plan.speed).toBeLessThan(12.5);
    expect(plan.catchTime).toBeGreaterThan(1.0);
    expect(plan.catchTime).toBeLessThan(1.5);
  });
});

describe('physics outcomes', () => {
  it('a perfect flip is a ringer from either end, either hand, 40 and 30 ft', () => {
    for (const end of [0, 1] as const)
      for (const hand of [1, -1] as const)
        for (const dist of [40, 30] as const) {
          const o = throwOnce(delivery('flip', end, dist, hand));
          expect(o.result.ringer, `end ${end} hand ${hand} ${dist}ft`).toBe(true);
        }
  });
  it('perfect 1¼ and 1¾ turns ring the stake', () => {
    expect(throwOnce(delivery('turn114')).result.ringer).toBe(true);
    expect(throwOnce(delivery('turn134')).result.ringer).toBe(true);
  });
  it('every shoe in the catalogue rings with a perfect flip', () => {
    for (const shape of ['classic', 'hook', 'wide', 'taper'] as const)
      for (const weight of ['2-2', '2-10'] as const) {
        const o = throwOnce(delivery(), ZERO_ERROR, { ...DEFAULT_LOADOUT, shape, weight });
        expect(o.result.ringer, `${shape} ${weight}`).toBe(true);
      }
  });
  it('a badly short shoe lands short and out of the ringer', () => {
    const o = throwOnce(delivery(), { ...ZERO_ERROR, power: -0.03 });
    expect(o.result.ringer).toBe(false);
    expect(o.result.distance).toBeGreaterThan(0.05);
  });
  it('shoes come to rest in the pit and hit the stake audibly when long', () => {
    const o = throwOnce(delivery(), { ...ZERO_ERROR, power: 0.025 });
    expect(o.time).toBeLessThan(6);
    expect(o.events.some((e) => e.kind === 'stake')).toBe(true);
  });
  it('clay stops shoes faster than sand', () => {
    const d = delivery();
    const err = { ...ZERO_ERROR, power: -0.02 };
    const sand = new PhysicsWorld('sand');
    const clay = new PhysicsWorld('clay');
    simulateThrow(sand, 1, 0, DEFAULT_LOADOUT, d, err);
    simulateThrow(clay, 1, 0, DEFAULT_LOADOUT, d, err);
    const zs = sand.state(1)!.position.z;
    const zc = clay.state(1)!.position.z;
    expect(zc).toBeLessThan(zs + 0.005);
  });
  it('a second shoe can land on top of a ringer', () => {
    const w = new PhysicsWorld('sand');
    const a = simulateThrow(w, 1, 0, DEFAULT_LOADOUT, delivery(), ZERO_ERROR);
    const b = simulateThrow(w, 2, 1, DEFAULT_LOADOUT, delivery(), ZERO_ERROR);
    expect(a.result.ringer).toBe(true);
    expect(b.result.ringer).toBe(true);
    expect(w.state(2)!.position.y).toBeGreaterThan(w.state(1)!.position.y);
  });
});

describe('skill calibration', () => {
  it('ringer percentage falls smoothly as delivery error grows', () => {
    const pct = (scale: number, n = 60) => {
      const rng = mulberry32(99 + scale * 10);
      const w = new PhysicsWorld('sand');
      let r = 0;
      for (let i = 0; i < n; i++) {
        w.clearShoes();
        if (simulateThrow(w, 1, 0, DEFAULT_LOADOUT, delivery(), randomError(scale, rng)).result.ringer) r++;
      }
      return (100 * r) / n;
    };
    const elite = pct(0.25);
    const league = pct(1);
    const novice = pct(3);
    expect(elite).toBeGreaterThan(80);
    expect(league).toBeGreaterThan(15);
    expect(league).toBeLessThan(55);
    expect(novice).toBeLessThan(15);
  });
});
