import type { PitchDistance } from '../core/constants';
import type { Grip, Loadout } from '../core/equipment';
import { scoreInning, type InningScore, type ScoringMode, type ShoeResult } from '../core/scoring';
import type { PitMaterial } from '../physics/physicsWorld';

export interface PlayerInfo {
  id: string;
  name: string;
  isHuman: boolean;
  hand: 1 | -1;
  grip: Grip;
  loadout: Loadout;
  /** AI: target ringer percentage. */
  rating?: number;
  hometown?: string;
}

export type TimeOfDay = 'morning' | 'afternoon' | 'sunset' | 'night';

export interface MatchConfig {
  mode: ScoringMode;
  /** Cancellation: points to win. Count-all: shoes per player. */
  target: number;
  distance: PitchDistance;
  pit: PitMaterial;
  time: TimeOfDay;
}

export interface PlayerStats {
  shoes: number;
  ringers: number;
  doubles: number;
  inCount: number;
  /** Count-all points (ringer 3, in count 1) regardless of mode — used for points-per-shoe. */
  countPoints: number;
}

export interface InningRecord {
  inning: number;
  end: 0 | 1;
  order: [0 | 1, 0 | 1];
  shoes: ShoeResult[];
  score: InningScore;
  totals: [number, number];
}

export const emptyStats = (): PlayerStats => ({ shoes: 0, ringers: 0, doubles: 0, inCount: 0, countPoints: 0 });

export const ringerPct = (s: PlayerStats) => (s.shoes ? (100 * s.ringers) / s.shoes : 0);

/**
 * Turn order and scoring for one game, following NHPA rules:
 * - each pitcher pitches both shoes, then the opponent pitches both;
 * - after each inning both pitchers walk to the other end;
 * - cancellation: the scorer pitches first next inning (if nobody scores,
 *   whoever pitched last goes first); game ends when someone reaches the target;
 * - count-all: first pitch alternates; game is a fixed number of shoes with
 *   extra innings to break ties.
 */
export class Match {
  scores: [number, number] = [0, 0];
  stats: [PlayerStats, PlayerStats] = [emptyStats(), emptyStats()];
  inning = 1;
  /** End the pitchers stand at this inning. */
  pitchFrom: 0 | 1 = 0;
  order: [0 | 1, 0 | 1];
  /** 0..3 within the inning. */
  throwIndex = 0;
  current: ShoeResult[] = [];
  history: InningRecord[] = [];
  over = false;
  winner: 0 | 1 | null = null;

  constructor(
    readonly config: MatchConfig,
    readonly players: [PlayerInfo, PlayerInfo],
    firstPitcher: 0 | 1 = 0,
  ) {
    this.order = firstPitcher === 0 ? [0, 1] : [1, 0];
  }

  /** Index of the pitcher on the mound. */
  get pitcher(): 0 | 1 {
    return this.order[this.throwIndex < 2 ? 0 : 1];
  }

  /** 0 or 1 — first or second shoe of this pitcher's pair. */
  get shoeOfPair(): 0 | 1 {
    return (this.throwIndex % 2) as 0 | 1;
  }

  get targetEnd(): 0 | 1 {
    return this.pitchFrom === 0 ? 1 : 0;
  }

  get inningComplete(): boolean {
    return this.throwIndex >= 4;
  }

  /** Innings regulation calls for in count-all play. */
  get regulationInnings(): number {
    return Math.ceil(this.config.target / 2);
  }

  recordShoe(result: ShoeResult) {
    if (this.over || this.inningComplete) throw new Error('No shoe expected');
    this.current.push({ ...result, owner: this.pitcher });
    this.throwIndex++;
  }

  /** Advance to the next shoe without recording a result (live play judges at inning end). */
  nextThrow() {
    if (this.over || this.inningComplete) throw new Error('No shoe expected');
    this.throwIndex++;
  }

  /** Complete a live inning with the final judged positions of all four shoes. */
  finishInning(results: ShoeResult[]): InningRecord {
    this.current = results;
    this.throwIndex = 4;
    return this.completeInning();
  }

  /** Score the inning and set up the next one. */
  completeInning(): InningRecord {
    if (!this.inningComplete) throw new Error('Inning not finished');
    const score = scoreInning(this.config.mode, this.current);
    for (const p of [0, 1] as const) {
      const mine = this.current.filter((s) => s.owner === p);
      const st = this.stats[p];
      st.shoes += mine.length;
      const r = mine.filter((s) => s.ringer).length;
      st.ringers += r;
      if (r === 2) st.doubles++;
      st.inCount += mine.filter((s) => !s.ringer && s.inCount).length;
      st.countPoints += mine.reduce((acc, s) => acc + (s.ringer ? 3 : s.inCount ? 1 : 0), 0);
      this.scores[p] += score.points[p];
    }
    const rec: InningRecord = {
      inning: this.inning,
      end: this.pitchFrom,
      order: [...this.order] as [0 | 1, 0 | 1],
      shoes: this.current,
      score,
      totals: [...this.scores] as [number, number],
    };
    this.history.push(rec);

    // Is the game over?
    if (this.config.mode === 'cancellation') {
      const t = this.config.target;
      if (this.scores[0] >= t || this.scores[1] >= t) {
        this.over = true;
        this.winner = this.scores[0] > this.scores[1] ? 0 : 1;
      }
    } else if (this.inning >= this.regulationInnings && this.scores[0] !== this.scores[1]) {
      this.over = true;
      this.winner = this.scores[0] > this.scores[1] ? 0 : 1;
    }

    // Next inning order.
    let first: 0 | 1;
    if (this.config.mode === 'cancellation') {
      if (score.points[0] > 0) first = 0;
      else if (score.points[1] > 0) first = 1;
      else first = this.order[1];
    } else {
      first = this.order[1];
    }
    this.order = first === 0 ? [0, 1] : [1, 0];
    this.inning++;
    this.pitchFrom = this.pitchFrom === 0 ? 1 : 0;
    this.throwIndex = 0;
    this.current = [];
    return rec;
  }

  /** Short status for the HUD ("To 40" / "Shoe 12 of 40"). */
  progressLabel(): string {
    if (this.config.mode === 'cancellation') return `Inning ${this.inning} · to ${this.config.target}`;
    const reg = this.regulationInnings;
    if (this.inning > reg) return `Extra inning ${this.inning - reg}`;
    return `Inning ${this.inning} of ${reg}`;
  }
}
