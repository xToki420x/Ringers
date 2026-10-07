import { describe, expect, it } from 'vitest';
import { advance, createTournament, HUMAN_ID, nextHumanGame, poolStandings, recordHumanGame, simulateToEnd } from '../src/game/tournament';
import { DEFAULT_LOADOUT } from '../src/core/equipment';
import { mulberry32 } from '../src/physics/errorModel';

const human = { id: HUMAN_ID, name: 'You', isHuman: true, hand: 1 as const, grip: 'flip' as const, loadout: DEFAULT_LOADOUT };
const cfg = { mode: 'countall' as const, target: 20, distance: 40 as const, pit: 'sand' as const, time: 'afternoon' as const };

describe('tournament', () => {
  it('builds 16 pools of 4 with everyone playing three pool games', () => {
    const t = createTournament(human, cfg, 42);
    expect(Object.keys(t.entrants)).toHaveLength(64);
    expect(t.pools).toHaveLength(16);
    for (const p of t.pools) {
      expect(p.entrants).toHaveLength(4);
      const counts = new Map<string, number>();
      for (const r of p.rounds) for (const g of r) for (const id of [g.a, g.b]) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const id of p.entrants) expect(counts.get(id)).toBe(3);
    }
  });
  it('waits for the human, then advances through pools into a 32 bracket', () => {
    const t = createTournament(human, cfg, 7);
    const rng = mulberry32(1);
    for (let round = 0; round < 3; round++) {
      expect(advance(t, rng)).toBe(false);
      const g = nextHumanGame(t)!;
      expect(g).toBeTruthy();
      recordHumanGame(t, g, { scores: [50, 10], ringers: [15, 2], shoes: [20, 20] });
      expect(advance(t, rng)).toBe(true);
    }
    expect(t.stage).toBe('bracket');
    expect(t.bracket[0].games).toHaveLength(16);
    const ids = t.bracket[0].games.flatMap((g) => [g.a, g.b]);
    expect(new Set(ids).size).toBe(32);
    expect(ids).toContain(HUMAN_ID);
    const pool = t.pools.find((p) => p.entrants.includes(HUMAN_ID))!;
    expect(poolStandings(t, pool)[0].id).toBe(HUMAN_ID);
  });
  it('always crowns a champion', () => {
    const t = createTournament(human, cfg, 99);
    simulateToEnd(t, 40, mulberry32(3));
    expect(t.stage).toBe('done');
    expect(t.champion).toBeTruthy();
  });
});
