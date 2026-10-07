import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { judgeShoe, scoreCancellation, scoreCountAll, type ShoeResult } from '../src/core/scoring';
import { shoeGeometry } from '../src/core/shoeShape';
import { makeStake } from '../src/physics/physicsWorld';
import { IN } from '../src/core/constants';

const R = (owner: number, ringer: boolean, dIn = 0): ShoeResult => ({
  owner, ringer, leaner: false, distance: ringer ? 0 : dIn * IN, inCount: ringer || dIn <= 6, foul: false,
});

describe('ringer judging', () => {
  const g = shoeGeometry('classic');
  const stake = makeStake(1);
  const flat = new Quaternion();
  it('a shoe resting flat around the stake is a ringer', () => {
    // Stake inside the shoe, near the toe.
    const pos = new Vector3(0, 0.004, stake.base.z + 0.045);
    expect(judgeShoe(0, g, pos, flat, stake).ringer).toBe(true);
  });
  it('a shoe whose heels sit on the stake is not a ringer', () => {
    // Stake at the heel line: straightedge would touch it.
    const heelZ = g.heelLine[0].z;
    const pos = new Vector3(0, 0.004, stake.base.z - heelZ);
    const r = judgeShoe(0, g, pos, flat, stake);
    expect(r.ringer).toBe(false);
    expect(r.inCount).toBe(true);
  });
  it('a shoe a foot away is out of count', () => {
    const pos = new Vector3(0, 0.004, stake.base.z - 0.4);
    const r = judgeShoe(0, g, pos, flat, stake);
    expect(r.ringer).toBe(false);
    expect(r.inCount).toBe(false);
  });
  it('a shoe facing away (toe at the stake) is not a ringer', () => {
    const turned = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
    const pos = new Vector3(0, 0.004, stake.base.z - 0.13);
    const r = judgeShoe(0, g, pos, turned, stake);
    expect(r.ringer).toBe(false);
    expect(r.distance).toBeLessThan(0.05);
  });
});

describe('cancellation scoring (NHPA)', () => {
  it('uncancelled ringer scores 3', () => expect(scoreCancellation([R(0, true), R(0, false, 10), R(1, false, 3), R(1, false, 8)]).points).toEqual([3, 0]));
  it('ringer plus closest shoe scores 4', () => expect(scoreCancellation([R(0, true), R(0, false, 2), R(1, false, 3), R(1, false, 8)]).points).toEqual([4, 0]));
  it('double ringer scores 6', () => expect(scoreCancellation([R(0, true), R(0, true), R(1, false, 1), R(1, false, 2)]).points).toEqual([6, 0]));
  it('ringers cancel, closest shoe scores', () => expect(scoreCancellation([R(0, true), R(0, false, 4), R(1, true), R(1, false, 2)]).points).toEqual([0, 1]));
  it('doubles cancel to nothing', () => expect(scoreCancellation([R(0, true), R(0, true), R(1, true), R(1, true)]).points).toEqual([0, 0]));
  it('two shoes closer than both opponents score 2', () => expect(scoreCancellation([R(0, false, 1), R(0, false, 2), R(1, false, 3), R(1, false, 5)]).points).toEqual([2, 0]));
  it('only the closest scores when shoes are split', () => expect(scoreCancellation([R(0, false, 1), R(0, false, 4), R(1, false, 3), R(1, false, 5)]).points).toEqual([1, 0]));
  it('nothing in count scores nothing', () => expect(scoreCancellation([R(0, false, 9), R(0, false, 10), R(1, false, 8), R(1, false, 12)]).points).toEqual([0, 0]));
  it('triple vs single: 2 ringers to 1 nets 3', () => expect(scoreCancellation([R(0, true), R(0, true), R(1, true), R(1, false, 1)]).points).toEqual([3, 0]));
});

describe('count-all scoring (NHPA)', () => {
  it('counts every ringer and shoe in count', () => {
    expect(scoreCountAll([R(0, true), R(0, false, 2), R(1, true), R(1, true)]).points).toEqual([4, 6]);
  });
});
