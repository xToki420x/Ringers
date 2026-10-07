import type { Loadout } from '../core/equipment';
import { judgeShoe, type ShoeResult } from '../core/scoring';
import { PHYSICS_DT, PhysicsWorld, type ContactEvent } from './physicsWorld';
import { planRelease, type Delivery, type DeliveryError } from './throwModel';

export interface SimOutcome {
  result: ShoeResult;
  events: ContactEvent[];
  time: number;
}

/** Run a single throw to rest, headless. Existing shoes in the world stay put. */
export function simulateThrow(
  world: PhysicsWorld,
  id: number,
  owner: number,
  loadout: Loadout,
  delivery: Delivery,
  error: DeliveryError,
  maxTime = 8,
): SimOutcome {
  const plan = planRelease(delivery, error);
  world.addShoe(id, owner, loadout, plan.state);
  const events: ContactEvent[] = [];
  let t = 0;
  const dt = PHYSICS_DT;
  while (t < maxTime) {
    events.push(...world.step());
    t += dt;
    if (t > 0.5 && world.allAtRest()) break;
  }
  const s = world.state(id)!;
  const sb = world.shoes.get(id)!;
  const stake = world.stakes[delivery.targetEnd];
  const foul = s.position.y < -0.5 || Math.abs(s.position.z - stake.base.z) > 3;
  return { result: judgeShoe(owner, sb.geom, s.position, s.quaternion, stake, foul), events, time: t };
}
