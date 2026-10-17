import * as THREE from 'three';
import { GRIPS, MODELS, factoryLoadout, sanitizeLoadout, type Loadout } from '../core/equipment';
import { formatDistance, judgeShoe, type ShoeResult } from '../core/scoring';
import { PIT } from '../core/constants';
import { haptic, sfx } from '../audio/sfx';
import { ThrowControl, type Gesture } from '../input/throwControl';
import { PHYSICS_DT, PhysicsWorld, stakeZ, type ContactEvent } from '../physics/physicsWorld';
import { DEFAULT_ARC, planRelease, ZERO_ERROR, type DeliveryError, type ReleasePlan } from '../physics/throwModel';
import { Pitcher } from '../render/pitcher';
import { Stage } from '../render/stage';
import { applyShoeLook, createShoeMesh } from '../render/shoeMesh';
import { UI, type UIActions } from '../ui/ui';
import { layout, toggleFullscreen, updateLayout } from '../ui/layout';
import { aiDeliveryError } from './ai';
import { Match, ringerPct, type MatchConfig, type PlayerInfo } from './match';
import { EXHIBITION_OPPONENTS } from './roster';
import { load, resetSave, save, type SaveData } from './save';
import { advance, createTournament, HUMAN_ID, nextHumanGame, opponentOf, recordHumanGame, stageLabel } from './tournament';
import { Room, type Member, type RoomState, type SnapMsg, type ThrowMsg } from '../net/room';

type Phase =
  | 'menu'
  | 'intro'
  | 'turn-human'
  | 'turn-ai-wait'
  | 'turn-ai'
  | 'net-wait'
  | 'flight'
  | 'settled'
  | 'summary'
  | 'walk'
  | 'wait'
  | 'replay'
  | 'gameover';

interface LiveShoe {
  id: number;
  owner: 0 | 1;
  plan: ReleasePlan;
  gesture?: Gesture;
  foul: boolean;
  firstContact: number;
  landedAt: number;
  stakeHits: number;
  /** Online: this throw's number in the match. */
  net?: number;
}

type Session =
  | { kind: 'quick' }
  | { kind: 'tournament'; gameId: string }
  | { kind: 'practice' }
  | { kind: 'online' };

/** State of an online match on this device. */
interface OnlineMatch {
  mid: string;
  /** Room ids of players[0] and players[1] on this device. */
  ids: [string, string];
  /** Which of players[] is me, or null when watching. */
  local: 0 | 1 | null;
  /** Throws released so far this match. */
  n: number;
  throws: Map<number, ThrowMsg>;
  snaps: Map<number, SnapMsg>;
  waitSince: number;
}

const SIDE_FOR_HAND = (hand: 1 | -1): 1 | -1 => hand;

export class App implements UIActions {
  data: SaveData = load();
  readonly stage: Stage;
  readonly ui: UI;
  readonly control: ThrowControl;
  physics = new PhysicsWorld('sand');
  phase: Phase = 'menu';
  private phaseT = 0;
  private paused = false;
  private session: Session | null = null;
  private match: Match | null = null;
  private players: [PlayerInfo, PlayerInfo] | null = null;
  private live: LiveShoe[] = [];
  private shoeSeq = 1;
  private thrown: LiveShoe | null = null;
  private simAcc = 0;
  private timeScale = 1;
  private timeScaleTarget = 1;
  private zoom = false;
  private menuKind: 'orbit' | 'shop' = 'orbit';
  private decor: THREE.Object3D[] = [];
  private shopShoe: ReturnType<typeof createShoeMesh> | null = null;
  private shopShoeModel = '';
  private last = performance.now();
  private practice = { shoes: 0, ringers: 0, inCount: 0, streak: 0, pairs: 0, pitchFrom: 0 as 0 | 1 };
  private ringerStreak = 0;
  private provisional: ShoeResult[] = [];
  private pendingAiError: DeliveryError | null = null;
  private heldShoe: THREE.Mesh | null = null;
  private skipSlowmo = false;
  private chaseSide: 1 | -1 = 1;
  /** Current swing position of the human's held shoe (−1 back … +1 release). */
  private swing = 0;
  // Instant replay recording of the current throw.
  private simClock = 0;
  private recIds: number[] = [];
  private recFrames: { t: number; poses: Float32Array }[] = [];
  private recEvents: { t: number; e: ContactEvent }[] = [];
  private replayable = false;
  private replayT = 0;
  private replayEnd = 0;
  private replaySide: 1 | -1 = 1;
  // Online rooms.
  room: Room | null = null;
  private online: OnlineMatch | null = null;
  /** Code from an invite link (?room=CODE), offered on the online screen. */
  inviteCode = new URLSearchParams(location.search).get('room') ?? '';

  constructor() {
    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.stage = new Stage(canvas, this.data.settings.quality);
    this.ui = new UI(this);
    this.control = new ThrowControl(document.getElementById('pad')!, document.getElementById('padCanvas') as HTMLCanvasElement, {
      onSwing: (swing) => {
        this.swing = swing;
      },
      onThrow: (g) => this.humanThrow(g),
      onCancel: () => {
        this.swing = 0;
      },
    });
    updateLayout();
    window.addEventListener('resize', () => {
      updateLayout();
      this.stage.resize();
      this.control.resize();
    });
    // Keyboard for PC players: Esc pauses or goes back, F toggles full screen,
    // Space speeds up a slow-motion flight, Z zooms the aim view, R replays.
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range'))) return;
      sfx.unlock();
      if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
        e.preventDefault();
      } else if (this.ui.key(e.key)) {
        e.preventDefault();
      } else if (e.key === 'Escape' && this.inGame() && !this.paused) {
        this.pause();
        e.preventDefault();
      } else if ((e.key === ' ' || e.key === 'Enter') && this.phase === 'flight' && !this.paused) {
        this.skipSlowmo = true;
        e.preventDefault();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        sfx.suspend();
        if (this.inGame() && !this.paused) this.pause();
      } else sfx.resume();
    });
    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    // Tap during a slow-motion flight to let it play at full speed.
    window.addEventListener('pointerdown', () => {
      if (this.phase === 'flight' && !this.paused) this.skipSlowmo = true;
    });
  }

  async start() {
    await this.stage.build((f, label) => this.ui.loading(f, label));
    this.applySettings();
    this.placeDecor();
    this.stage.rig.set(this.stage.menuShot(0), true);
    this.ui.loading(1, 'Warming up');
    // Compile everything and draw a few frames behind the loading screen, so
    // the title appears already running smoothly.
    await this.stage.warmUp();
    this.ui.title();
    // Opened from an invite link: go straight to joining that room.
    if (this.inviteCode) this.ui.online();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
    await new Promise<void>((r) => {
      let n = 0;
      const tick = () => (++n >= 3 ? r() : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    this.ui.hideLoading();
  }

  // ------------------------------------------------------------- UIActions

  persist() {
    save(this.data);
  }

  tap(kind: 'tap' | 'confirm' | 'back' = 'tap') {
    sfx.unlock();
    sfx.ui(kind);
  }

  applySettings() {
    const s = this.data.settings;
    sfx.setVolume(s.volume);
    this.control.difficulty = s.difficulty;
    this.control.showGuides = s.guides;
  }

  resetData() {
    this.data = resetSave();
    this.applySettings();
  }

  setLoadout(l: Loadout) {
    this.data.loadout = { ...l };
    this.persist();
  }

  previewLoadout(l: Loadout | null) {
    if (l && this.shopShoe && this.shopShoeModel === `${l.model}|${l.weight}`) {
      // Same shoe, new colour or finish: recolour in place (used while dragging the sliders).
      applyShoeLook(this.shopShoe.material, l);
      return;
    }
    if (this.shopShoe) {
      this.stage.scene.remove(this.shopShoe);
      this.shopShoe.material.dispose();
      this.shopShoe = null;
    }
    if (!l) {
      this.setMenuBackdrop('orbit');
      return;
    }
    this.shopShoe = createShoeMesh(l, this.stage.envMap, true);
    this.shopShoeModel = `${l.model}|${l.weight}`;
    this.shopShoe.position.set(0, 0.34, stakeZ(1) - 0.85);
    this.stage.scene.add(this.shopShoe);
  }

  setMenuBackdrop(kind: 'orbit' | 'shop') {
    this.menuKind = kind;
    if (kind === 'orbit' && this.shopShoe) {
      this.stage.scene.remove(this.shopShoe);
      this.shopShoe.material.dispose();
      this.shopShoe = null;
    }
  }

  toggleZoom(): boolean {
    this.zoom = !this.zoom;
    if (this.phase === 'turn-human') this.aimCamera(false);
    return this.zoom;
  }

  pause() {
    if (!this.inGame() || this.paused) return;
    this.paused = true;
    this.control.setEnabled(false);
    this.ui.pauseMenu(this.session?.kind === 'practice');
  }

  resume() {
    this.paused = false;
    this.last = performance.now();
    if (this.phase === 'turn-human') this.control.setEnabled(true);
  }

  quitToMenu() {
    this.paused = false;
    const r = this.room, on = this.online;
    if (this.session?.kind === 'online' && r && on) {
      if (on.local !== null) {
        // Leaving a match you are playing in forfeits it.
        r.send({ k: 'forfeit', mid: on.mid, loser: r.me.id });
        this.onForfeit(on.mid, r.me.id);
      } else {
        r.lateFor = on.mid;
        this.endSession();
        this.ui.lobby();
      }
      return;
    }
    this.endSession();
    this.ui.title();
  }

  // ----------------------------------------------------------- sessions

  startQuickMatch() {
    const q = this.data.quick;
    const opp = EXHIBITION_OPPONENTS[q.opponent] ?? EXHIBITION_OPPONENTS[0];
    const cfg: MatchConfig = { mode: q.mode, target: q.target, distance: q.distance, pit: q.pit, time: q.time };
    this.beginMatch({ kind: 'quick' }, cfg, { ...opp }, `${opp.hometown}`);
  }

  startTournamentGame() {
    const t = this.data.tournament;
    if (!t) return;
    const g = nextHumanGame(t);
    if (!g) return;
    const opp = opponentOf(t, g);
    const times: MatchConfig['time'][] = ['morning', 'afternoon', 'afternoon', 'sunset', 'night'];
    const cfg: MatchConfig = { ...t.config, time: t.stage === 'bracket' ? times[Math.min(4, t.bracketRound)] : times[t.poolRound % 3] };
    const info: PlayerInfo = { id: opp.id, name: opp.name, isHuman: false, hand: opp.hand, grip: opp.grip, loadout: opp.loadout, rating: opp.rating, hometown: opp.hometown };
    this.beginMatch({ kind: 'tournament', gameId: g.id }, cfg, info, `${stageLabel(t)}`);
  }

  newTournament() {
    const q = this.data.quick;
    const cfg: MatchConfig = { mode: 'countall', target: q.mode === 'countall' ? q.target : 20, distance: 40, pit: 'sand', time: 'afternoon' };
    this.data.tournament = createTournament(this.human(), cfg);
    this.data.career.tournaments++;
    this.persist();
    this.ui.tournamentHub();
  }

  simulateTournament() {
    const t = this.data.tournament;
    if (!t) return;
    if (t.humanEliminated) {
      let guard = 0;
      while (t.stage !== 'done' && guard++ < 40) {
        if (nextHumanGame(t)) break;
        advance(t);
      }
    } else advance(t);
    this.persist();
    this.ui.tournamentHub();
  }

  abandonTournament() {
    this.data.tournament = null;
    this.persist();
  }

  // ------------------------------------------------------------- online

  /** Stable for this browser tab, so reloading rejoins as the same person. */
  private readonly clientId = (() => {
    const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
    try {
      let v = sessionStorage.getItem('ringers.client');
      if (!v) {
        v = fresh();
        sessionStorage.setItem('ringers.client', v);
      }
      return v;
    } catch {
      return fresh();
    }
  })();
  private lastOnlineMid = '';

  private member(): Member {
    return { id: this.clientId, name: this.data.name, hand: this.data.settings.hand, grip: this.data.grip, loadout: this.data.loadout };
  }

  private roomEvents() {
    return {
      state: (st: RoomState) => this.onRoomState(st),
      throwMsg: (m: ThrowMsg) => {
        if (this.online && m.mid === this.online.mid) this.online.throws.set(m.n, m);
      },
      snap: (m: SnapMsg) => {
        if (this.online && m.mid === this.online.mid) this.online.snaps.set(m.n, m);
      },
      forfeit: (mid: string, loser: string) => this.onForfeit(mid, loser),
      result: (mid: string, winner: string, loser: string, score: [number, number]) => this.room?.finishMatch(mid, winner, loser, score),
      closed: (reason: string) => this.onRoomClosed(reason),
      link: (ok: boolean) => this.ui.connection(ok),
    };
  }

  async onlineCreate() {
    const q = this.data.quick;
    const cfg: MatchConfig = { mode: q.mode, target: q.target, distance: q.distance, pit: q.pit, time: q.time };
    this.room = await Room.create(this.member(), cfg, this.roomEvents());
    this.ui.lobby();
  }

  async onlineJoin(code: string) {
    this.room = await Room.join(code, this.member(), this.roomEvents());
    this.inviteCode = '';
    this.ui.lobby();
  }

  onlineLeave() {
    const r = this.room;
    this.room = null;
    r?.leave();
  }

  onlineStart() {
    this.room?.startMatch();
  }

  onlineConfig(cfg: MatchConfig) {
    this.room?.setConfig(cfg);
  }

  /** Tell the room about a new name or new shoes. */
  onlineUpdateMe() {
    this.room?.updateMe(this.member());
  }

  private onRoomState(st: RoomState) {
    const r = this.room;
    if (!r) return;
    const m = st.match;
    const startable = this.phase === 'menu' || this.phase === 'gameover';
    if (st.status === 'playing' && m && m.id !== this.lastOnlineMid && m.id !== r.lateFor && startable && !this.online) {
      this.startOnlineMatch(st);
      return;
    }
    if (this.ui.current === 'lobby') this.ui.lobby();
  }

  private startOnlineMatch(st: RoomState) {
    const r = this.room!;
    const me = r.me.id;
    const ids = st.match!.players;
    const local = ids[0] === me ? 0 : ids[1] === me ? 1 : null;
    // On your own device you are always players[0].
    const order: [string, string] = local === 1 ? [ids[1], ids[0]] : [ids[0], ids[1]];
    const info = (id: string): PlayerInfo => {
      const mb = r.member(id);
      return { id, name: mb?.name ?? 'Pitcher', isHuman: id === me, remote: id !== me, hand: mb?.hand ?? 1, grip: mb?.grip ?? 'flip', loadout: sanitizeLoadout(mb?.loadout) };
    };
    this.lastOnlineMid = st.match!.id;
    this.ui.clearScreens();
    this.startMatchWith({ kind: 'online' }, { ...st.cfg }, [info(order[0]), info(order[1])], order[0] === st.match!.first ? 0 : 1, local === null ? `Room ${r.code} · watching` : `Room ${r.code}`);
    this.online = { mid: st.match!.id, ids: order, local: local === null ? null : 0, n: 0, throws: new Map(), snaps: new Map(), waitSince: 0 };
  }

  private onForfeit(mid: string, loser: string) {
    const r = this.room;
    if (!r) return;
    const st = r.state;
    if (r.isHost && st?.match?.id === mid) {
      const winner = st.match.players.find((x) => x !== loser) ?? loser;
      r.finishMatch(mid, winner, loser, st.match.score ?? [0, 0], true);
    }
    const on = this.online;
    if (!on || on.mid !== mid) return;
    const who = this.players?.[on.ids.indexOf(loser)]?.name ?? 'A pitcher';
    this.endSession();
    this.ui.lobby();
    this.ui.toast(loser === r.me.id ? 'You left the match' : `${who} left the match`, 3500);
  }

  private onRoomClosed(reason: string) {
    this.room = null;
    if (this.session?.kind === 'online') this.endSession();
    document.querySelectorAll('#overlay .modal').forEach((m) => m.remove());
    this.paused = false;
    this.ui.online(reason);
  }

  /** My shoe just stopped: tell the room exactly where every shoe in the pit lies. */
  private sendSnap(n: number) {
    if (!this.online || !this.room) return;
    const bodies = this.live.map((l) => this.physics.shoes.get(l.id)?.restState() ?? null);
    this.room.send({ k: 'snap', mid: this.online.mid, n, bodies, fouls: this.live.map((l) => l.foul) });
  }

  /** Lay every shoe where the pitcher's own game says it stopped. */
  private applySnap(snap: SnapMsg) {
    snap.bodies.forEach((st, i) => {
      const l = this.live[i];
      if (!l) return;
      l.foul = snap.fouls[i] ?? l.foul;
      let b = this.physics.shoes.get(l.id);
      if (!st) {
        if (b) {
          this.physics.removeShoe(l.id);
          this.stage.removeShoe(l.id);
        }
        return;
      }
      if (!b) {
        const loadout = this.players![l.owner].loadout;
        b = this.physics.addShoe(l.id, l.owner, loadout, { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), linvel: new THREE.Vector3(), angvel: new THREE.Vector3() });
        this.stage.addShoe(l.id, loadout);
      }
      b.setRest(st);
    });
  }

  /** Match score in the room's player order. */
  private roomOrderScores(): [number, number] {
    const on = this.online!, m = this.match!;
    const ids = this.room?.state?.match?.players ?? on.ids;
    return [m.scores[on.ids.indexOf(ids[0])] ?? 0, m.scores[on.ids.indexOf(ids[1])] ?? 0];
  }

  startPractice() {
    const cfg: MatchConfig = { mode: 'cancellation', target: 999, distance: this.data.quick.distance, pit: this.data.quick.pit, time: this.data.quick.time };
    this.session = { kind: 'practice' };
    this.players = [this.human(), this.human()];
    this.match = null;
    this.practice = { shoes: 0, ringers: 0, inCount: 0, streak: 0, pairs: 0, pitchFrom: 0 };
    this.prepareCourt(cfg);
    this.ui.clearScreens();
    this.ui.showHud(true);
    this.ui.setPractice(true);
    this.ui.updateScore(null, [this.data.name, ''], this.practice);
    this.practiceCfg = cfg;
    if (!this.data.seenTutorial) this.ui.tutorial(() => this.beginTurn());
    else this.beginTurn();
  }
  private practiceCfg: MatchConfig | null = null;

  private human(): PlayerInfo {
    return { id: HUMAN_ID, name: this.data.name, isHuman: true, hand: this.data.settings.hand, grip: this.data.grip, loadout: this.data.loadout };
  }

  private beginMatch(session: Session, cfg: MatchConfig, opp: PlayerInfo, subtitle: string) {
    // Coin toss for first pitch.
    this.startMatchWith(session, cfg, [this.human(), opp], Math.random() < 0.5 ? 0 : 1, subtitle, [
      `${GRIPS[this.data.grip].name} · ${MODELS[this.data.loadout.model].name}`,
      `${(opp.rating ?? 0).toFixed(0)}% ringers · ${GRIPS[opp.grip].short}`,
    ]);
  }

  private startMatchWith(session: Session, cfg: MatchConfig, players: [PlayerInfo, PlayerInfo], first: 0 | 1, subtitle: string, subs?: [string, string]) {
    this.session = session;
    this.players = players;
    this.match = new Match(cfg, this.players, first);
    this.ringerStreak = 0;
    this.prepareCourt(cfg);
    this.ui.setPractice(false);
    this.updateScoreboards();
    const sub = (p: PlayerInfo) => `${GRIPS[p.grip].name} · ${MODELS[p.loadout.model].name}`;
    this.ui.versus([players[0].name, players[1].name], subs ?? [sub(players[0]), sub(players[1])], subtitle);
    this.setPhase('intro');
    // Fly-in over the court.
    const z = stakeZ(this.match.targetEnd);
    this.stage.rig.set({ pos: new THREE.Vector3(3.5, 3.2, -z * 0.2), look: new THREE.Vector3(0, 0.3, z * 0.5), fov: 45 }, false, 1.4);
  }

  private prepareCourt(cfg: MatchConfig) {
    this.clearDecor();
    this.previewLoadout(null);
    this.physics = new PhysicsWorld(cfg.pit);
    this.stage.setPitMaterial(cfg.pit);
    if (this.stage.time !== cfg.time) this.stage.setTimeOfDay(cfg.time);
    this.stage.clearShoes();
    this.stage.rakePits();
    this.live = [];
    this.zoom = false;
  }

  private endSession() {
    this.control.setEnabled(false);
    this.ui.showHud(false);
    this.ui.clearTags();
    this.stage.showViewShoe(null);
    this.stage.clearShoes();
    this.physics.clearShoes();
    this.live = [];
    this.match = null;
    this.session = null;
    this.players = null;
    this.online = null;
    this.setPhase('menu');
    this.timeScale = this.timeScaleTarget = 1;
    if (this.stage.time !== 'afternoon') this.stage.setTimeOfDay('afternoon');
    this.stage.rakePits();
    this.placeDecor();
    for (const p of this.stage.pitchers) p.root.visible = false;
  }

  private inGame() {
    return this.phase !== 'menu' && this.phase !== 'gameover';
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
    if (p !== 'menu' && p !== 'gameover' && this.viewShift !== '0,0') {
      this.viewShift = '0,0';
      this.stage.setViewShift(0);
    }
  }
  private viewShift = '';

  // ---------------------------------------------------------------- turns

  private cfg(): MatchConfig {
    return this.match?.config ?? this.practiceCfg!;
  }

  private pitcherIndex(): 0 | 1 {
    return this.match ? this.match.pitcher : 0;
  }

  private currentPlayer(): PlayerInfo | null {
    return this.players ? this.players[this.pitcherIndex()] : null;
  }

  private pitchFrom(): 0 | 1 {
    return this.match ? this.match.pitchFrom : this.practice.pitchFrom;
  }

  private targetEnd(): 0 | 1 {
    return this.pitchFrom() === 0 ? 1 : 0;
  }

  private sides(): [1 | -1, 1 | -1] {
    const p = this.players!;
    return [SIDE_FOR_HAND(p[0].hand), SIDE_FOR_HAND(p[1].hand)];
  }

  private beginTurn() {
    const p = this.currentPlayer()!;
    const idx = this.pitcherIndex();
    const cfg = this.cfg();
    const sides = this.sides();
    this.stage.placePitchers(this.pitchFrom(), cfg.distance, idx, sides, [this.players![0].hand, this.players![1].hand]);
    this.stage.pitchers[0].root.visible = !p.isHuman || idx !== 0;
    this.stage.pitchers[1].root.visible = !!this.match;
    this.ui.clearTags();
    this.ui.sheet(null);
    this.ui.readout(null);
    if (this.match) this.ui.updateScore(this.match, [this.players![0].name, this.players![1].name]);
    if (p.isHuman) {
      this.setPhase('turn-human');
      this.stage.pitchers[0].root.visible = false;
      this.stage.showViewShoe(p.loadout);
      this.swing = 0;
      this.aimCamera(this.phaseCameraCut());
      this.control.setEnabled(true);
      this.ui.zoomState(this.zoom, true);
      const which = this.match ? (this.match.shoeOfPair === 0 ? 'First shoe' : 'Second shoe') : `Shoe ${this.practice.shoes + 1}`;
      this.ui.hint(`${which} · pull down, push up, release on the line`);
    } else {
      this.setPhase('turn-ai-wait');
      this.stage.showViewShoe(null);
      this.ui.zoomState(false, false);
      this.ui.hint(p.remote ? `${p.name} is lining up…` : `${p.name} is pitching`);
      const shot = this.stage.broadcastShot(this.pitchFrom(), cfg.distance, sides[idx]);
      this.stage.rig.set(shot, this.phaseCameraCut(), 3);
      // A friend's throw arrives over the network; the computer's is rolled here.
      this.pendingAiError = p.remote ? null : aiDeliveryError(p, Math.random, this.match ? this.pressure() : 0);
    }
  }

  private cutNext = true;
  private phaseCameraCut(): boolean {
    const c = this.cutNext;
    this.cutNext = false;
    return c;
  }

  private pressure(): number {
    const m = this.match!;
    const diff = Math.abs(m.scores[0] - m.scores[1]);
    return m.config.mode === 'cancellation' ? Math.min(1, (Math.max(...m.scores) / m.config.target) * (diff < 6 ? 1 : 0.5)) : 0.3;
  }

  private aimCamera(instant: boolean) {
    const p = this.currentPlayer()!;
    const shot = this.stage.aimShot(this.pitchFrom(), this.cfg().distance, SIDE_FOR_HAND(p.hand), p.hand, this.zoom);
    this.stage.rig.set(shot, instant, 5);
  }

  private humanThrow(g: Gesture) {
    if (this.phase !== 'turn-human') return;
    this.control.setEnabled(false);
    if (this.data.settings.haptics) haptic(18);
    const p = this.currentPlayer()!;
    // Cut to third person: your pitcher finishes the delivery as the shoe leaves the hand.
    const av = this.stage.pitchers[0];
    av.root.visible = true;
    av.startDelivery(Pitcher.RELEASE_AT - 0.02);
    av.update(0);
    av.root.updateMatrixWorld(true);
    const from = new THREE.Vector3();
    av.hand.getWorldPosition(from);
    const n = this.online?.n ?? 0;
    const shoe = this.release(p, g.error, g);
    if (this.online && this.room) this.room.send({ k: 'throw', mid: this.online.mid, n, err: g.error });
    const off = from.sub(shoe.plan.state.position);
    if (off.length() < 0.6) this.stage.setShoeVisualOffset(shoe.id, off);
    this.stage.showViewShoe(null);
    this.stage.rig.set(this.stage.releaseShot(this.pitchFrom(), this.cfg().distance, SIDE_FOR_HAND(p.hand), p.hand), true);
    this.ui.hint(layout.coarse ? 'Tap to speed up' : 'Click or press Space to speed up');
    this.showReadout(g);
  }

  private showReadout(g: Gesture) {
    const e = g.error;
    const flips = GRIPS[this.currentPlayer()!.grip].rotations * (1 + e.rotation);
    const chips: { text: string; tone: 'good' | 'warn' | 'bad' | '' }[] = [];
    const rotTone = Math.abs(e.rotation) < 0.04 ? 'good' : Math.abs(e.rotation) < 0.1 ? 'warn' : 'bad';
    chips.push({ text: `${this.currentPlayer()!.grip === 'flip' ? 'Flip' : 'Turn'} ${flips.toFixed(2)}`, tone: rotTone });
    const pw = e.power * 100;
    chips.push({ text: Math.abs(pw) < 0.5 ? 'Power ✓' : `${pw > 0 ? 'Long' : 'Short'} ${Math.abs(pw).toFixed(1)}%`, tone: Math.abs(pw) < 0.6 ? 'good' : Math.abs(pw) < 1.6 ? 'warn' : 'bad' });
    const lineIn = (e.yaw * 11.5) / 0.0254;
    chips.push({ text: Math.abs(lineIn) < 0.8 ? 'On line' : `${Math.abs(lineIn).toFixed(1)}″ ${lineIn > 0 ? 'left' : 'right'}`, tone: Math.abs(lineIn) < 1 ? 'good' : Math.abs(lineIn) < 3 ? 'warn' : 'bad' });
    if (g.wobbly) chips.push({ text: 'Wobble', tone: 'bad' });
    this.ui.readout(chips);
  }

  /** Put a shoe in the air. */
  private release(p: PlayerInfo, err: DeliveryError, gesture?: Gesture): LiveShoe {
    const cfg = this.cfg();
    const idx = this.pitcherIndex();
    const plan = planRelease(
      { grip: p.grip, hand: p.hand, distance: cfg.distance, side: SIDE_FOR_HAND(p.hand), targetEnd: this.targetEnd(), arc: DEFAULT_ARC },
      err,
    );
    const id = this.shoeSeq++;
    this.physics.addShoe(id, idx, p.loadout, plan.state);
    this.stage.addShoe(id, p.loadout);
    const shoe: LiveShoe = { id, owner: idx, plan, gesture, foul: false, firstContact: -1, landedAt: -1, stakeHits: 0 };
    if (this.online) shoe.net = this.online.n++;
    this.live.push(shoe);
    this.thrown = shoe;
    this.simClock = 0;
    this.recIds = this.live.filter((l) => this.physics.shoes.has(l.id)).map((l) => l.id);
    this.recFrames = [];
    this.recEvents = [];
    this.replayable = false;
    sfx.whoosh(0.8);
    this.simAcc = 0;
    this.skipSlowmo = false;
    this.chaseSide = p.hand === 1 ? -1 : 1;
    if (this.data.settings.slowmo && !(this.data.settings.fastAi && !p.isHuman)) this.timeScale = this.timeScaleTarget = p.isHuman ? 0.32 : 0.45;
    this.setPhase('flight');
    return shoe;
  }

  // ----------------------------------------------------------------- loop

  /** Debug: `?warp=N` lets slow (software-rendered) test runs keep real time. */
  private readonly warp = Math.max(1, Math.min(10, Number(new URLSearchParams(location.search).get('warp')) || 1));

  private frame = (now: number) => {
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05 * this.warp, raw);
    if (this.warp === 1 && !this.paused) this.stage.adapt(raw);
    this.last = now;
    if (!this.paused) this.update(dt);
    const slow = this.phase === 'flight' || this.phase === 'settled' ? this.timeScale : 1;
    this.stage.update(this.paused ? 0 : dt, this.paused ? 0 : dt * slow);
    this.ui.updateTags(this.stage.camera);
    this.control.draw(dt);
    this.stage.render();
    requestAnimationFrame(this.frame);
  };

  private update(dt: number) {
    this.phaseT += dt;
    switch (this.phase) {
      case 'menu':
        this.updateMenu();
        break;
      case 'intro':
        if (this.phaseT > 2.6) {
          this.ui.clearScreens();
          this.ui.showHud(true);
          this.cutNext = true;
          if (!this.data.seenTutorial) {
            this.setPhase('wait');
            this.ui.tutorial(() => this.beginTurn());
          } else this.beginTurn();
        }
        break;
      case 'turn-human': {
        const p = this.currentPlayer()!;
        this.stage.poseViewShoe(this.swing, p.hand, p.grip);
        break;
      }
      case 'turn-ai-wait': {
        const p = this.currentPlayer()!;
        let ready = this.phaseT > (this.data.settings.fastAi && !p.remote ? 0.25 : 0.9);
        if (p.remote) {
          const m = this.online?.throws.get(this.online.n);
          if (m) {
            this.pendingAiError = m.err;
            if (this.phaseT > 0.3) this.ui.hint(`${p.name} is pitching`);
          } else ready = false;
        }
        if (ready) {
          const av = this.stage.pitchers[this.pitcherIndex()];
          av.startDelivery();
          // The pitcher carries a real shoe through the swing.
          this.heldShoe = createShoeMesh(this.currentPlayer()!.loadout, this.stage.envMap);
          this.heldShoe.position.set(0, -0.06, 0.02);
          this.heldShoe.rotation.set(Math.PI / 2, 0, 0);
          av.hand.add(this.heldShoe);
          this.setPhase('turn-ai');
        }
        break;
      }
      case 'net-wait': {
        // A friend's shoe has stopped here; wait for where it stopped on their device.
        this.stepPhysics(dt);
        const on = this.online;
        const n = this.thrown?.net;
        if (!on || n === undefined || on.snaps.has(n)) this.onSettled();
        else if (this.phaseT > 25) {
          this.netForce = true;
          this.onSettled();
        }
        break;
      }
      case 'turn-ai': {
        const av = this.stage.pitchers[this.pitcherIndex()];
        if (av.deliveryTime >= Pitcher.RELEASE_AT || !av.delivering) {
          const from = new THREE.Vector3();
          this.heldShoe?.getWorldPosition(from);
          if (this.heldShoe) av.hand.remove(this.heldShoe);
          const shoe = this.release(this.currentPlayer()!, this.pendingAiError ?? ZERO_ERROR);
          if (this.heldShoe) {
            const off = from.sub(shoe.plan.state.position);
            if (off.length() < 1) this.stage.setShoeVisualOffset(shoe.id, off);
          }
          this.heldShoe = null;
          this.pendingAiError = null;
        }
        break;
      }
      case 'flight':
        this.updateFlight(dt);
        break;
      case 'settled':
        this.stepPhysics(dt);
        if (this.phaseT > (this.isAiTurnFast() ? 0.9 : this.replayable ? 2.8 : 1.6)) this.afterShoe();
        break;
      case 'replay':
        this.updateReplay(dt);
        break;
      case 'summary':
        if (this.session?.kind === 'practice' && this.phaseT > 2.2) this.continueAfterSummary();
        // Online games keep moving so everyone in the room stays together.
        else if (this.session?.kind === 'online' && this.phaseT > 5) this.continueAfterSummary();
        break;
      case 'walk':
        if (this.phaseT > 1.7) this.beginTurn();
        break;
      case 'wait':
        break;
      case 'gameover':
        this.updateMenu();
        break;
    }
    if (this.phase !== 'flight') {
      this.timeScale += (1 - this.timeScale) * Math.min(1, dt * 4);
    }
    this.stage.syncShoes(this.physics, dt);
  }

  private isAiTurnFast() {
    const p = this.currentPlayer();
    return this.data.settings.fastAi && !!p && !p.isHuman && !p.remote;
  }

  private updateMenu() {
    // Phones: menus sit below the scene, so lift it. Wide screens: menus sit
    // beside it (title menu on the left, shop panel on the right).
    const shop = this.menuKind === 'shop';
    const W = window.innerWidth;
    const fy = layout.wide ? 0 : shop ? 0.31 : 0.15;
    const fx = !layout.wide ? 0 : shop ? (488 * layout.scale) / (2 * W) : -(460 * layout.scale + 0.06 * W) / (2 * W);
    const key = `${fy},${fx.toFixed(4)}`;
    if (this.viewShift !== key) {
      this.viewShift = key;
      this.stage.setViewShift(fy, fx);
    }
    if (this.menuKind === 'shop' && this.shopShoe) {
      const t = performance.now() / 1000;
      this.shopShoe.rotation.set(-0.7 + Math.sin(t * 0.7) * 0.1, t * 0.6, 0, 'YXZ');
      this.shopShoe.position.y = 0.34 + Math.sin(t * 1.3) * 0.01;
      const z = stakeZ(1);
      this.stage.rig.set({ pos: new THREE.Vector3(0.1, 0.8, z - 2.3), look: new THREE.Vector3(0, 0.34, z - 0.85), fov: 26 }, false, 3);
    } else {
      this.stage.rig.set(this.stage.menuShot(performance.now() / 1000), false, 2);
    }
  }

  private stepPhysics(dt: number) {
    this.simAcc += dt * this.timeScale;
    let n = 0;
    while (this.simAcc >= PHYSICS_DT && n < 40 * this.warp) {
      const ev = this.physics.step();
      this.simClock += PHYSICS_DT;
      for (const e of ev) {
        this.onContact(e);
        if (this.phase === 'flight') this.recEvents.push({ t: this.simClock, e });
      }
      // Record the replay at 120 Hz of simulation time, independent of frame rate.
      if (this.phase === 'flight' && this.recStep++ % 4 === 0) this.recordFrame();
      this.simAcc -= PHYSICS_DT;
      n++;
    }
    if (n >= 40 * this.warp) this.simAcc = 0;
  }
  private recStep = 0;

  private recordFrame() {
    const poses = new Float32Array(this.recIds.length * 7);
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    this.recIds.forEach((id, i) => {
      const b = this.physics.shoes.get(id);
      if (!b) return;
      b.pose(p, q);
      poses.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w], i * 7);
    });
    this.recFrames.push({ t: this.simClock, poses });
  }

  private startReplay() {
    if (this.phase !== 'settled' || this.recFrames.length < 2) return;
    const first = this.recEvents.find((r) => r.e.shoeId === this.thrown?.id && r.e.kind !== 'ground');
    const tc = first ? first.t : this.recFrames[this.recFrames.length - 1].t - 1;
    this.replayT = Math.max(this.recFrames[0].t, tc - 0.5);
    this.replayEnd = Math.min(this.recFrames[this.recFrames.length - 1].t, tc + 2.2);
    this.replaySide = Math.random() < 0.5 ? 1 : -1;
    this.setPhase('replay');
    this.stage.replaying = true;
    this.ui.callout(null);
    this.ui.clearTags();
    this.ui.readout(null);
    this.ui.replayButton(null);
    this.ui.replayBadge(true);
    this.stage.rig.set(this.stage.replayShot(this.targetEnd(), this.replaySide, 0), true);
    this.applyReplayFrame();
  }

  private updateReplay(dt: number) {
    const prev = this.replayT;
    this.replayT += dt * 0.28;
    for (const r of this.recEvents) {
      if (r.t > prev && r.t <= this.replayT) {
        if (r.e.kind === 'stake') sfx.stake(r.e.speed, MODELS[(this.physics.shoes.get(r.e.shoeId)?.loadout ?? this.data.loadout).model].hardness);
        else if (r.e.kind === 'shoe') sfx.clink(r.e.speed);
        else if (r.e.kind === 'pit' && r.e.speed > 0.3) {
          sfx.thud(r.e.speed * 0.8, this.physics.pit);
          this.stage.particles.sandImpact(r.e.position, new THREE.Vector3(0, 0, this.targetEnd() === 1 ? 2 : -2), 2);
        }
      }
    }
    const k = (this.replayT - (this.replayEnd - 2.7)) / 2.7;
    this.stage.rig.set(this.stage.replayShot(this.targetEnd(), this.replaySide, Math.max(0, Math.min(1, k))), false, 3);
    this.applyReplayFrame();
    if (this.replayT >= this.replayEnd + 0.15) {
      this.stage.replaying = false;
      this.ui.replayBadge(false);
      this.replayable = false;
      this.setPhase('settled');
      this.phaseT = 0.6;
      this.showTags(this.provisional);
      this.stage.rig.set(this.stage.stakeShot(this.targetEnd()), false, 2);
    }
  }

  private applyReplayFrame() {
    const f = this.recFrames;
    let i = 0;
    while (i < f.length - 2 && f[i + 1].t < this.replayT) i++;
    const a = f[i], b = f[Math.min(f.length - 1, i + 1)];
    const u = b.t > a.t ? Math.max(0, Math.min(1, (this.replayT - a.t) / (b.t - a.t))) : 0;
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const qb = new THREE.Quaternion();
    this.recIds.forEach((id, j) => {
      const o = j * 7;
      p.set(a.poses[o], a.poses[o + 1], a.poses[o + 2]).lerp(new THREE.Vector3(b.poses[o], b.poses[o + 1], b.poses[o + 2]), u);
      q.set(a.poses[o + 3], a.poses[o + 4], a.poses[o + 5], a.poses[o + 6]);
      qb.set(b.poses[o + 3], b.poses[o + 4], b.poses[o + 5], b.poses[o + 6]);
      q.slerp(qb, u);
      this.stage.setShoePose(id, p, q);
    });
  }

  private updateFlight(dt: number) {
    const s = this.thrown!;
    const b = this.physics.shoes.get(s.id);
    // Slow motion through the whole flight so you can read how the shoe
    // is turning and where it will land, slowest as it reaches the stake.
    const z = stakeZ(this.targetEnd());
    const human = this.players![s.owner].isHuman;
    if (b && this.data.settings.slowmo && !this.isAiTurnFast() && !this.skipSlowmo) {
      const dz = Math.abs(b.pz - z);
      const near = dz < 1.2 && b.py < 0.8 && s.landedAt < 0;
      const cruise = human ? 0.32 : 0.45;
      if (s.landedAt < 0) this.timeScaleTarget = near ? 0.2 : cruise;
      else if (this.phaseT - s.landedAt > 1.4) this.timeScaleTarget = 1;
    } else this.timeScaleTarget = 1;
    this.timeScale += (this.timeScaleTarget - this.timeScale) * Math.min(1, dt * 8);
    this.stepPhysics(dt);
    if (b) {
      const pos = new THREE.Vector3(b.px, b.py, b.pz);
      const vel = new THREE.Vector3(b.vx, b.vy, b.vz);
      if (s.landedAt < 0) {
        // Hold the release angle for a beat, then ride with the shoe.
        if (b.age > (human ? 0.22 : 0.12)) this.stage.rig.set(this.stage.chaseShot(pos, vel, this.targetEnd(), this.chaseSide), false, b.age < 0.5 ? 4 : 9);
      } else this.stage.rig.set(this.stage.chaseShot(new THREE.Vector3(0, 0.1, z), new THREE.Vector3(0, 0, this.targetEnd() === 1 ? 1 : -1), this.targetEnd(), this.chaseSide), false, 3);
    }
    const done = this.physics.allAtRest() || this.phaseT > 18;
    if (done) {
      this.timeScaleTarget = 1;
      this.onSettled();
    }
  }

  private onContact(e: ContactEvent) {
    const shoe = this.live.find((l) => l.id === e.shoeId);
    if (!shoe) return;
    const pan = 0;
    const hard = MODELS[(this.physics.shoes.get(e.shoeId)?.loadout ?? this.data.loadout).model].hardness;
    if (shoe.firstContact < 0 && e.kind !== 'shoe') shoe.firstContact = this.phaseT;
    if ((e.kind === 'pit' || e.kind === 'stake' || e.kind === 'ground' || e.kind === 'board') && shoe === this.thrown && shoe.landedAt < 0) shoe.landedAt = this.phaseT;
    switch (e.kind) {
      case 'stake':
        shoe.stakeHits++;
        sfx.stake(e.speed, hard, pan);
        this.stage.particles.steelStrike(e.position, e.speed);
        if (e.speed > 2) this.stage.rig.shake = Math.min(1, e.speed / 8);
        if (this.data.settings.haptics && this.currentPlayer()?.isHuman) haptic(e.speed > 3 ? 30 : 12);
        break;
      case 'shoe':
        sfx.clink(e.speed, pan);
        this.stage.particles.steelStrike(e.position, e.speed * 0.8);
        break;
      case 'pit': {
        if (e.speed < 0.25) break;
        sfx.thud(e.speed, this.physics.pit, pan);
        const b = this.physics.shoes.get(e.shoeId)!;
        const v = new THREE.Vector3(b.vx, b.vy, b.vz);
        const energy = 0.5 * b.mass * e.speed * e.speed;
        this.stage.particles.sandImpact(e.position, v, energy * (this.physics.pit === 'sand' ? 1 : 0.4));
        const pit = this.stage.pits[e.end ?? (e.position.z > 0 ? 1 : 0)];
        const hv = Math.hypot(v.x, v.z) || 1;
        if (pit.contains(e.position.x, e.position.z)) pit.crater(e.position.x, e.position.z, energy * (this.physics.pit === 'sand' ? 1 : 0.35), v.x / hv, v.z / hv);
        break;
      }
      case 'board':
        sfx.knock(e.speed, pan);
        break;
      case 'backboard':
        sfx.knock(e.speed * 1.4, pan);
        // NHPA: a shoe that strikes the backboard is a foul shoe.
        shoe.foul = true;
        break;
      case 'ground':
        if (e.speed > 0.6) sfx.thud(e.speed * 0.4, 'clay', pan);
        break;
    }
  }

  // ------------------------------------------------------------- judging

  private judgeAll(): ShoeResult[] {
    const stake = this.physics.stakes[this.targetEnd()];
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    return this.live.map((l) => {
      const b = this.physics.shoes.get(l.id);
      if (!b) return { owner: l.owner, ringer: false, leaner: false, distance: Infinity, inCount: false, foul: true };
      b.pose(p, q);
      const out = Math.abs(p.x) > PIT.width / 2 + 0.06 || Math.abs(p.z - stake.base.z) > PIT.length / 2 + 0.06 || p.y < -0.5;
      return judgeShoe(l.owner, b.geom, p, q, stake, l.foul || out);
    });
  }

  private netForce = false;

  private onSettled() {
    const on = this.online;
    const thrown = this.thrown;
    if (on && thrown?.net !== undefined) {
      const owner = this.players![thrown.owner];
      if (owner.isHuman) this.sendSnap(thrown.net);
      else {
        const snap = on.snaps.get(thrown.net);
        if (!snap && !this.netForce) {
          if (this.phase !== 'net-wait') {
            this.setPhase('net-wait');
            this.ui.hint(`Waiting for ${owner.name}…`);
          }
          return;
        }
        if (snap) this.applySnap(snap);
      }
    }
    this.netForce = false;
    this.ui.hint(null);
    this.setPhase('settled');
    const results = this.judgeAll();
    const idx = this.live.length - 1;
    const r = results[idx];
    const before = this.provisional;
    this.provisional = results;
    const shoe = this.thrown!;
    const owner = shoe.owner;
    const isHuman = this.players![owner].isHuman;
    // Knock-offs: a ringer that was there before isn't any more.
    const knocked = before.some((b, i) => b.ringer && !results[i].ringer);
    const pairRinger = results.filter((x, i) => x.ringer && this.live[i].owner === owner && i >= idx - 1).length;
    let big = '', sub = '', plain = false, cheer = 0;
    if (r.foul) {
      big = 'Foul';
      sub = this.live[idx].foul ? 'Hit the backboard' : 'Outside the pit';
      plain = true;
      this.removeFoulShoe(idx);
    } else if (r.ringer) {
      const double = pairRinger === 2 && this.isSecondOfPair();
      const onTop = results.some((x, i) => i < idx && x.ringer && this.live[i].owner !== owner);
      big = double ? 'Double Ringer!' : 'Ringer!';
      sub = onTop ? 'On top!' : shoe.stakeHits === 0 ? 'Dead ringer' : '3 points';
      cheer = double ? 1.6 : 1;
      sfx.ringerChime(double);
      if (isHuman && this.data.settings.haptics) haptic(double ? [30, 60, 30, 60, 60] : [30, 50, 40]);
    } else if (r.leaner) {
      big = 'Leaner';
      sub = 'In count';
      plain = true;
      cheer = 0.5;
    } else if (r.inCount) {
      big = formatDistance(r.distance, this.data.settings.metric);
      sub = 'In count';
      plain = true;
      cheer = 0.25;
    } else {
      big = r.distance < 2 ? formatDistance(r.distance, this.data.settings.metric) : 'Wide';
      sub = 'Out of count';
      plain = true;
    }
    if (knocked) {
      sub = 'Knocked off!';
      cheer = Math.max(cheer, 0.8);
    }
    this.ui.callout(big, sub, plain, this.isAiTurnFast() ? 900 : 1600);
    this.replayable = !this.isAiTurnFast() && !r.foul && (r.ringer || r.leaner || knocked || shoe.stakeHits > 0) && this.recFrames.length > 30;
    if (this.replayable) this.ui.replayButton(() => this.startReplay());
    if (cheer > 0) {
      sfx.crowd(cheer);
      this.stage.env.crowd.cheer(cheer);
    }
    // Practice tallies & streaks.
    if (isHuman && !r.foul) {
      if (r.ringer) {
        this.ringerStreak++;
        this.data.career.longestRingerStreak = Math.max(this.data.career.longestRingerStreak, this.ringerStreak);
      } else this.ringerStreak = 0;
    }
    if (!this.match) {
      this.practice.shoes++;
      if (r.ringer) {
        this.practice.ringers++;
        this.practice.streak++;
      } else this.practice.streak = 0;
      if (r.inCount && !r.ringer) this.practice.inCount++;
      this.data.career.practiceShoes++;
      if (r.ringer) this.data.career.practiceRingers++;
      this.ui.updateScore(null, [this.data.name, ''], this.practice);
    }
    this.showTags(results);
    if (!this.match) this.persist();
  }

  private isSecondOfPair(): boolean {
    if (!this.match) return this.live.length % 2 === 0;
    return this.match.shoeOfPair === 1;
  }

  private removeFoulShoe(index: number) {
    const l = this.live[index];
    // Foul shoes are removed from play (kept in the list as foul for the record).
    this.physics.removeShoe(l.id);
    setTimeout(() => this.stage.removeShoe(l.id), 900);
  }

  private showTags(results: ShoeResult[]) {
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const tags: { text: string; pos: THREE.Vector3; cls: string }[] = [];
    results.forEach((r, i) => {
      const b = this.physics.shoes.get(this.live[i].id);
      if (!b || r.foul) return;
      b.pose(p, q);
      const text = r.ringer ? 'RINGER' : r.leaner ? 'LEANER' : r.inCount ? formatDistance(r.distance, this.data.settings.metric) : 'OUT';
      tags.push({ text, pos: p.clone().setY(p.y + 0.06), cls: `p${r.owner}${r.ringer ? ' ringer' : ''}` });
    });
    this.ui.setTags(tags);
  }

  /** After a shoe is judged: next shoe, or end of inning. */
  private afterShoe() {
    this.ui.readout(null);
    this.ui.replayButton(null);
    if (!this.match) {
      // Practice: pick up after each pair.
      if (this.live.length >= 2) {
        this.setPhase('summary');
        this.stage.rig.set(this.stage.resultShot(this.targetEnd()), false, 2.5);
        this.practice.pairs++;
      } else {
        this.cutNext = true;
        this.beginTurn();
      }
      return;
    }
    this.match.nextThrow();
    if (!this.match.inningComplete) {
      this.cutNext = true;
      this.beginTurn();
      return;
    }
    // Inning complete: final judging of all four shoes.
    const results = this.judgeAll();
    const end = this.targetEnd();
    const rec = this.match.finishInning(results);
    this.setPhase('summary');
    this.stage.rig.set(this.stage.resultShot(end), false, 2.5);
    const names: [string, string] = [this.players![0].name, this.players![1].name];
    this.ui.sheet(this.ui.inningSheet(rec, names, this.data.settings.metric, () => this.continueAfterSummary()));
    this.ui.updateScore(this.match, names);
    this.updateScoreboards();
    if (this.online && this.room?.isHost) this.room.updateScore(this.online.mid, this.roomOrderScores(), this.match.progressLabel());
    const pts = Math.max(...rec.score.points);
    if (rec.score.points[0] > 0 && this.match.config.mode === 'cancellation') this.stage.env.crowd.cheer(0.3 + pts * 0.1);
  }

  private continueAfterSummary() {
    if (this.phase !== 'summary') return;
    this.ui.sheet(null);
    this.ui.clearTags();
    this.provisional = [];
    // Pick up the shoes.
    for (const l of this.live) {
      this.physics.removeShoe(l.id);
      this.stage.removeShoe(l.id);
    }
    this.live = [];
    if (!this.match) {
      if (this.practice.pairs % 12 === 0) this.stage.rakePits();
      this.cutNext = true;
      this.beginTurn();
      return;
    }
    if (this.match.over) {
      this.finishMatch();
      return;
    }
    // Walk to the other end.
    this.setPhase('walk');
    const p = this.currentPlayer()!;
    const shot = p.isHuman
      ? this.stage.aimShot(this.pitchFrom(), this.cfg().distance, SIDE_FOR_HAND(p.hand), p.hand)
      : this.stage.broadcastShot(this.pitchFrom(), this.cfg().distance, SIDE_FOR_HAND(p.hand));
    const mid = new THREE.Vector3(1.6, 2.6, 0);
    this.stage.rig.set({ pos: mid, look: shot.look, fov: 50 }, false, 1.6);
    setTimeout(() => {
      if (this.phase === 'walk') this.stage.rig.set(shot, false, 2.2);
    }, 800);
    this.ui.updateScore(this.match, [this.players![0].name, this.players![1].name]);
  }

  // --------------------------------------------------------------- results

  private finishMatch() {
    const m = this.match!;
    this.setPhase('gameover');
    this.control.setEnabled(false);
    this.ui.showHud(false);
    this.stage.showViewShoe(null);
    const names: [string, string] = [this.players![0].name, this.players![1].name];
    const c = this.data.career;
    const st = m.stats[0];
    const on = this.online;
    // Watching a friends' game online doesn't count toward your career.
    if (!on || on.local !== null) {
      c.games++;
      if (m.winner === 0) c.wins++;
      c.shoes += st.shoes;
      c.ringers += st.ringers;
      c.doubles += st.doubles;
      c.inCount += st.inCount;
      c.countPoints += st.countPoints;
      if (st.shoes >= 20) c.bestRingerPct = Math.max(c.bestRingerPct, ringerPct(st));
    }
    if (on && this.room && m.winner !== null) {
      const w = m.winner, result = { mid: on.mid, winner: on.ids[w], loser: on.ids[1 - w], score: this.roomOrderScores() };
      if (this.room.isHost) this.room.finishMatch(result.mid, result.winner, result.loser, result.score);
      else if (on.local !== null) this.room.send({ k: 'result', ...result });
      this.persist();
      this.ui.gameOver(m, names, on.local, () => {
        this.endSession();
        if (this.room) this.ui.lobby();
        else this.ui.online();
      });
      return;
    }
    sfx.crowd(m.winner === 0 ? 1.4 : 0.6);
    this.stage.env.crowd.cheer(m.winner === 0 ? 1.4 : 0.5);
    let extra: string | undefined;
    const s = this.session;
    if (s?.kind === 'tournament' && this.data.tournament) {
      const t = this.data.tournament;
      const g = nextHumanGame(t);
      if (g && g.id === s.gameId) {
        recordHumanGame(t, g, { scores: m.scores, ringers: [m.stats[0].ringers, m.stats[1].ringers], shoes: [m.stats[0].shoes, m.stats[1].shoes] });
        advance(t);
        while (t.stage !== 'done' && !nextHumanGame(t) && !t.humanEliminated) advance(t);
        if (t.stage === 'done' && t.champion === HUMAN_ID) {
          c.titles++;
          extra = 'World Champion!';
        } else if (t.humanEliminated) extra = 'Eliminated';
        else extra = stageLabel(t);
      }
    }
    this.persist();
    this.ui.gameOver(m, names, 0, () => {
      const kind = this.session?.kind;
      this.endSession();
      if (kind === 'tournament') this.ui.tournamentHub();
      else this.ui.title();
    }, extra);
  }

  private updateScoreboards() {
    if (!this.match || !this.players) return;
    const sub = this.match.progressLabel();
    for (const sb of this.stage.env.scoreboards) sb.draw([this.players[0].name, this.players[1].name], this.match.scores, this.session?.kind === 'tournament' ? 'World Championship' : this.session?.kind === 'online' && this.room ? `Room ${this.room.code}` : 'Exhibition', sub);
  }

  // ---------------------------------------------------------------- decor

  /** Shoes resting around the stake for the title screen. */
  private placeDecor() {
    this.clearDecor();
    const z = stakeZ(1);
    const a = createShoeMesh(this.data.loadout, this.stage.envMap);
    a.position.set(0.004, 0.003, z + 0.05);
    a.rotation.y = 0.12;
    const b = createShoeMesh(factoryLoadout(this.data.loadout.model === 'legend' ? 'cadet' : 'legend', '2-10'), this.stage.envMap);
    b.position.set(-0.01, 0.017, z + 0.035);
    b.rotation.set(0.12, -0.35, 0.05);
    const c2 = createShoeMesh(factoryLoadout(this.data.loadout.model === 'bulldog' ? 'competition' : 'bulldog'), this.stage.envMap);
    c2.position.set(0.16, 0.002, z - 0.2);
    c2.rotation.y = 2.4;
    for (const m of [a, b, c2]) {
      this.stage.scene.add(m);
      this.decor.push(m);
    }
    for (const p of this.stage.pitchers) p.root.visible = false;
  }

  private clearDecor() {
    for (const d of this.decor) this.stage.scene.remove(d);
    this.decor = [];
  }
}
