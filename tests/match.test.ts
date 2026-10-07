import { describe, expect, it } from 'vitest';
import { Match, type MatchConfig, type PlayerInfo } from '../src/game/match';
import { DEFAULT_LOADOUT } from '../src/core/equipment';
import type { ShoeResult } from '../src/core/scoring';

const P = (name: string): PlayerInfo => ({ id: name, name, isHuman: false, hand: 1, grip: 'flip', loadout: DEFAULT_LOADOUT });
const shoe = (ringer: boolean, dist = 0.5): ShoeResult => ({ owner: 0, ringer, leaner: false, distance: ringer ? 0 : dist, inCount: ringer || dist < 0.1524, foul: false });

describe('match flow', () => {
  it('alternates pitchers, switches ends and lets the scorer lead (cancellation)', () => {
    const cfg: MatchConfig = { mode: 'cancellation', target: 21, distance: 40, pit: 'sand', time: 'afternoon' };
    const m = new Match(cfg, [P('A'), P('B')], 0);
    expect(m.pitcher).toBe(0);
    m.recordShoe(shoe(false)); m.recordShoe(shoe(false));
    expect(m.pitcher).toBe(1);
    m.recordShoe(shoe(true)); m.recordShoe(shoe(false));
    const rec = m.completeInning();
    expect(rec.score.points).toEqual([0, 3]);
    expect(m.pitchFrom).toBe(1);
    expect(m.pitcher).toBe(1); // scorer leads
  });
  it('ends a cancellation game at the target', () => {
    const cfg: MatchConfig = { mode: 'cancellation', target: 21, distance: 40, pit: 'sand', time: 'afternoon' };
    const m = new Match(cfg, [P('A'), P('B')], 0);
    while (!m.over) {
      for (let i = 0; i < 4; i++) m.recordShoe(shoe(m.pitcher === 0));
      m.completeInning();
    }
    expect(m.winner).toBe(0);
    expect(m.scores[0]).toBeGreaterThanOrEqual(21);
    expect(m.stats[0].doubles).toBeGreaterThan(0);
  });
  it('count-all plays a fixed number of shoes and breaks ties', () => {
    const cfg: MatchConfig = { mode: 'countall', target: 10, distance: 40, pit: 'sand', time: 'afternoon' };
    const m = new Match(cfg, [P('A'), P('B')], 0);
    let innings = 0;
    while (!m.over) {
      innings++;
      // Tie for regulation, then player 1 wins the extra inning.
      for (let i = 0; i < 4; i++) m.recordShoe(shoe(innings > 5 ? m.pitcher === 1 : true));
      m.completeInning();
    }
    expect(innings).toBe(6);
    expect(m.winner).toBe(1);
    expect(m.stats[0].shoes).toBe(12);
  });
});
