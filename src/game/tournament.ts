import type { Grip, Loadout } from '../core/equipment';
import { mulberry32 } from '../physics/errorModel';
import { simulatedShoe } from './ai';
import { Match, type MatchConfig, type PlayerInfo } from './match';
import { makeOpponent } from './roster';

/**
 * A 64-pitcher championship: 16 round-robin pools of four, the top two in
 * each pool advance to a 32-player single-elimination bracket.
 */

export const FIELD_SIZE = 64;
export const POOL_SIZE = 4;
export const POOL_COUNT = FIELD_SIZE / POOL_SIZE;
export const BRACKET_SIZE = POOL_COUNT * 2;
export const HUMAN_ID = 'you';

export interface Entrant {
  id: string;
  name: string;
  rating: number;
  hometown: string;
  isHuman: boolean;
  hand: 1 | -1;
  grip: Grip;
  loadout: Loadout;
  seed: number;
}

export interface TGame {
  id: string;
  a: string;
  b: string;
  played: boolean;
  scoreA: number;
  scoreB: number;
  ringersA: number;
  ringersB: number;
  shoesA: number;
  shoesB: number;
  winner?: string;
}

export interface Pool {
  name: string;
  entrants: string[];
  /** games[round] — three rounds of two games each. */
  rounds: TGame[][];
}

export interface BracketRound {
  name: string;
  games: TGame[];
}

export type Stage = 'pools' | 'bracket' | 'done';

export interface Tournament {
  version: 1;
  name: string;
  seed: number;
  config: MatchConfig;
  entrants: Record<string, Entrant>;
  stage: Stage;
  poolRound: number;
  pools: Pool[];
  bracket: BracketRound[];
  bracketRound: number;
  champion?: string;
  humanEliminated: boolean;
}

export interface Standing {
  id: string;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  ringers: number;
  shoes: number;
}

const ROUND_NAMES = ['Round of 32', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Championship'];

function newGame(id: string, a: string, b: string): TGame {
  return { id, a, b, played: false, scoreA: 0, scoreB: 0, ringersA: 0, ringersB: 0, shoesA: 0, shoesB: 0 };
}

export function createTournament(human: PlayerInfo, config: MatchConfig, seed = Date.now() % 1e9, name = 'World Horseshoe Championship'): Tournament {
  const rng = mulberry32(seed);
  // Ratings by tier, descending (63 AI pitchers).
  const ratings: number[] = [];
  for (let i = 0; i < FIELD_SIZE - 1; i++) {
    const f = i / (FIELD_SIZE - 2);
    const r = 90 - 72 * Math.pow(f, 0.85) + (rng() - 0.5) * 6;
    ratings.push(Math.max(10, Math.min(92, r)));
  }
  ratings.sort((x, y) => y - x);
  const entrants: Record<string, Entrant> = {};
  const ids: string[] = [];
  ratings.forEach((r, i) => {
    const o = makeOpponent(seed * 7 + i * 131, r);
    const id = `p${i}`;
    entrants[id] = { id, name: o.name, rating: o.rating!, hometown: o.hometown!, isHuman: false, hand: o.hand, grip: o.grip, loadout: o.loadout, seed: 0 };
    ids.push(id);
  });
  entrants[HUMAN_ID] = {
    id: HUMAN_ID,
    name: human.name,
    rating: 0,
    hometown: human.hometown ?? 'Your hometown',
    isHuman: true,
    hand: human.hand,
    grip: human.grip,
    loadout: human.loadout,
    seed: 0,
  };
  // Seed list: human slots in as the 33rd seed (a third-tier pitcher).
  const seeded = [...ids.slice(0, 32), HUMAN_ID, ...ids.slice(32)];
  seeded.forEach((id, i) => (entrants[id].seed = i + 1));

  // Snake seeding into pools.
  const pools: Pool[] = Array.from({ length: POOL_COUNT }, (_, i) => ({ name: `Pool ${String.fromCharCode(65 + i)}`, entrants: [], rounds: [] }));
  seeded.forEach((id, i) => {
    const tier = Math.floor(i / POOL_COUNT);
    const k = i % POOL_COUNT;
    const p = tier % 2 === 0 ? k : POOL_COUNT - 1 - k;
    pools[p].entrants.push(id);
  });
  for (const [pi, pool] of pools.entries()) {
    const [a, b, c, d] = pool.entrants;
    const pairs: [string, string][][] = [
      [[a, d], [b, c]],
      [[a, c], [b, d]],
      [[a, b], [c, d]],
    ];
    pool.rounds = pairs.map((round, ri) => round.map(([x, y], gi) => newGame(`P${pi}-${ri}-${gi}`, x, y)));
  }
  return { version: 1, name, seed, config, entrants, stage: 'pools', poolRound: 0, pools, bracket: [], bracketRound: 0, humanEliminated: false };
}

export function humanPool(t: Tournament): Pool | undefined {
  return t.pools.find((p) => p.entrants.includes(HUMAN_ID));
}

/** The human's next unplayed game in the current round, if any. */
export function nextHumanGame(t: Tournament): TGame | undefined {
  if (t.stage === 'pools') {
    const pool = humanPool(t);
    return pool?.rounds[t.poolRound]?.find((g) => !g.played && (g.a === HUMAN_ID || g.b === HUMAN_ID));
  }
  if (t.stage === 'bracket') {
    return t.bracket[t.bracketRound]?.games.find((g) => !g.played && (g.a === HUMAN_ID || g.b === HUMAN_ID));
  }
  return undefined;
}

export function opponentOf(t: Tournament, g: TGame): Entrant {
  return t.entrants[g.a === HUMAN_ID ? g.b : g.a];
}

export interface GameResult {
  scores: [number, number];
  ringers: [number, number];
  shoes: [number, number];
}

/** Statistically simulate a game between two AI pitchers (or auto-play). */
export function simulateGame(t: Tournament, a: Entrant, b: Entrant, rng: () => number): GameResult {
  const players: [PlayerInfo, PlayerInfo] = [{ ...a, isHuman: false }, { ...b, isHuman: false }];
  const m = new Match(t.config, players, rng() < 0.5 ? 0 : 1);
  let guard = 0;
  while (!m.over && guard++ < 400) {
    for (let k = 0; k < 4; k++) {
      const p = m.pitcher;
      const s = simulatedShoe(players[p].rating ?? 30, rng);
      m.recordShoe({ owner: p, ringer: s.ringer, leaner: false, distance: s.distance, inCount: s.inCount, foul: false });
    }
    m.completeInning();
  }
  return {
    scores: m.scores,
    ringers: [m.stats[0].ringers, m.stats[1].ringers],
    shoes: [m.stats[0].shoes, m.stats[1].shoes],
  };
}

function applyResult(g: TGame, r: GameResult) {
  g.played = true;
  [g.scoreA, g.scoreB] = r.scores;
  [g.ringersA, g.ringersB] = r.ringers;
  [g.shoesA, g.shoesB] = r.shoes;
  g.winner = r.scores[0] >= r.scores[1] ? g.a : g.b;
}

/** Record the human's game. `scores`/`ringers`/`shoes` are [human, opponent]. */
export function recordHumanGame(_t: Tournament, g: TGame, r: GameResult) {
  const humanIsA = g.a === HUMAN_ID;
  const flip = <T,>(x: [T, T]): [T, T] => (humanIsA ? x : [x[1], x[0]]);
  applyResult(g, { scores: flip(r.scores), ringers: flip(r.ringers), shoes: flip(r.shoes) });
}

function currentGames(t: Tournament): TGame[] {
  if (t.stage === 'pools') return t.pools.flatMap((p) => p.rounds[t.poolRound] ?? []);
  if (t.stage === 'bracket') return t.bracket[t.bracketRound]?.games ?? [];
  return [];
}

/** True when everything but the human's game in this round is done (or nothing is left). */
export function roundNeedsHuman(t: Tournament): boolean {
  return !!nextHumanGame(t);
}

/**
 * Simulate all remaining AI games in the current round and advance the
 * tournament if the round is complete. Returns true if the stage/round advanced.
 */
export function advance(t: Tournament, rng: () => number = mulberry32((t.seed + t.poolRound * 97 + t.bracketRound * 13) | 0)): boolean {
  if (t.stage === 'done') return false;
  for (const g of currentGames(t)) {
    if (g.played) continue;
    if (g.a === HUMAN_ID || g.b === HUMAN_ID) continue;
    applyResult(g, simulateGame(t, t.entrants[g.a], t.entrants[g.b], rng));
  }
  if (currentGames(t).some((g) => !g.played)) return false;

  if (t.stage === 'pools') {
    if (t.poolRound < 2) {
      t.poolRound++;
      return true;
    }
    buildBracket(t);
    return true;
  }
  // Bracket round complete.
  const winners = t.bracket[t.bracketRound].games.map((g) => g.winner!);
  if (!winners.includes(HUMAN_ID) && t.bracket[t.bracketRound].games.some((g) => g.a === HUMAN_ID || g.b === HUMAN_ID)) t.humanEliminated = true;
  if (winners.length === 1) {
    t.champion = winners[0];
    t.stage = 'done';
    return true;
  }
  const games: TGame[] = [];
  for (let i = 0; i < winners.length; i += 2) games.push(newGame(`B${t.bracketRound + 1}-${i / 2}`, winners[i], winners[i + 1]));
  t.bracketRound++;
  t.bracket.push({ name: ROUND_NAMES[t.bracketRound] ?? `Round ${t.bracketRound + 1}`, games });
  return true;
}

/** Simulate a game the human chooses not to play (counts as a forfeit-free auto game at a modest rating). */
export function autoPlayHuman(t: Tournament, rating: number, rng: () => number = Math.random) {
  const g = nextHumanGame(t);
  if (!g) return;
  const me = { ...t.entrants[HUMAN_ID], rating };
  const opp = opponentOf(t, g);
  recordHumanGame(t, g, simulateGame(t, me, opp, rng));
}

export function poolStandings(t: Tournament, pool: Pool): Standing[] {
  const map = new Map<string, Standing>();
  for (const id of pool.entrants) map.set(id, { id, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, ringers: 0, shoes: 0 });
  for (const round of pool.rounds)
    for (const g of round) {
      if (!g.played) continue;
      const A = map.get(g.a)!;
      const B = map.get(g.b)!;
      A.pointsFor += g.scoreA;
      A.pointsAgainst += g.scoreB;
      B.pointsFor += g.scoreB;
      B.pointsAgainst += g.scoreA;
      A.ringers += g.ringersA;
      B.ringers += g.ringersB;
      A.shoes += g.shoesA;
      B.shoes += g.shoesB;
      if (g.winner === g.a) {
        A.wins++;
        B.losses++;
      } else {
        B.wins++;
        A.losses++;
      }
    }
  return [...map.values()].sort(
    (x, y) =>
      y.wins - x.wins ||
      y.pointsFor - y.pointsAgainst - (x.pointsFor - x.pointsAgainst) ||
      y.ringers / Math.max(1, y.shoes) - x.ringers / Math.max(1, x.shoes) ||
      t.entrants[x.id].seed - t.entrants[y.id].seed,
  );
}

function buildBracket(t: Tournament) {
  const winners: string[] = [];
  const runners: string[] = [];
  for (const p of t.pools) {
    const s = poolStandings(t, p);
    winners.push(s[0].id);
    runners.push(s[1].id);
  }
  if (!winners.includes(HUMAN_ID) && !runners.includes(HUMAN_ID)) t.humanEliminated = true;
  // Pool winner i meets the runner-up of the pool on the opposite side of the draw.
  const games: TGame[] = [];
  const half = POOL_COUNT / 2;
  for (let i = 0; i < POOL_COUNT; i++) {
    const opp = (i + half) % POOL_COUNT;
    games.push(newGame(`B0-${i}`, winners[i], runners[opp]));
  }
  // Order so that pool winners from the same half meet as late as possible.
  const order: TGame[] = [];
  for (let i = 0; i < half; i++) order.push(games[i], games[i + half]);
  t.bracket = [{ name: ROUND_NAMES[0], games: order }];
  t.bracketRound = 0;
  t.stage = 'bracket';
}

/** Run the tournament to completion (used when the human is out or for tests). */
export function simulateToEnd(t: Tournament, humanRating = 30, rng: () => number = Math.random) {
  let guard = 0;
  while (t.stage !== 'done' && guard++ < 50) {
    if (nextHumanGame(t)) autoPlayHuman(t, humanRating, rng);
    advance(t, rng);
  }
}

export function stageLabel(t: Tournament): string {
  if (t.stage === 'pools') return `Pool play · Round ${t.poolRound + 1} of 3`;
  if (t.stage === 'bracket') return t.bracket[t.bracketRound]?.name ?? 'Bracket';
  return 'Final results';
}
