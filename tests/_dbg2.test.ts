import { it } from 'vitest';
import { PhysicsWorld } from '../src/physics/physicsWorld';
import { planRelease, DEFAULT_ARC, ZERO_ERROR } from '../src/physics/throwModel';
import { DEFAULT_LOADOUT } from '../src/core/equipment';
it('dbg', () => {
  const d = { grip: 'flip' as const, hand: 1 as const, distance: 40 as const, side: 1 as const, targetEnd: 1 as const, arc: DEFAULT_ARC };
  const w = new PhysicsWorld('sand');
  const b = w.addShoe(1, 0, { ...DEFAULT_LOADOUT, shape: 'taper' }, planRelease(d, ZERO_ERROR).state);
  console.log('mass', b.mass, 'I', Array.from(b.I).map((x) => x.toExponential(2)).join(','), 'invI', Array.from(b.invI).map((x) => x.toExponential(2)).join(','));
  console.log('v', b.vx, b.vy, b.vz, 'p', b.px, b.py, b.pz, 'spheres', b.sphereCount, b.boundR);
  for (let i = 0; i < 3; i++) { w.step(); console.log('step', i, b.px, b.py, b.vz, b.sleeping); }
});
