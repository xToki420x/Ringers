import type { CharacterId } from '../render/characters';
import type { Grip, Loadout } from '../core/equipment';
import type { MatchConfig } from '../game/match';
import type { DeliveryError } from '../physics/throwModel';
import { MqttLink } from './mqtt';

/**
 * Online rooms. Whoever creates a room is its host and keeps the room's
 * state (who is in it, the queue, the game settings, the current match);
 * everyone else joins with the room's five-letter code.
 *
 * Two pitchers play at a time and everyone else in the room watches the
 * same game live; the winner stays on and the next person in the queue
 * steps up — the way a backyard pit works.
 *
 * Messages go through two public MQTT relays at once (whichever answers is
 * used, duplicates are dropped), so rooms work from any phone or PC on any
 * network without a game server of our own.
 */

export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
export const MAX_MEMBERS = 8;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HEARTBEAT_MS = 5000;
/** A member silent this long has left (phones can stall a while in the background). */
const MEMBER_TIMEOUT_MS = 45000;
/** A room whose host has been silent this long is gone. */
const ROOM_STALE_MS = 30000;

export interface Member {
  id: string;
  name: string;
  hand: 1 | -1;
  grip: Grip;
  loadout: Loadout;
  character?: CharacterId;
}

export interface RoomMatch {
  id: string;
  players: [string, string];
  first: string;
  score?: [number, number];
  label?: string;
}

export interface RoomState {
  v: 1;
  code: string;
  host: string;
  /** Host clock when last published (rooms nobody has heard from are dead). */
  t: number;
  members: Member[];
  /** Play order: the first two play, the winner stays, the loser goes to the back. */
  queue: string[];
  cfg: MatchConfig;
  status: 'lobby' | 'playing';
  match?: RoomMatch;
  last?: { winner: string; loser: string; score: [number, number]; forfeit?: boolean };
}

export interface ThrowMsg {
  k: 'throw';
  mid: string;
  /** Throw number within the match (0, 1, 2 …). */
  n: number;
  err: DeliveryError;
}

/** Where every shoe came to rest after throw `n`, from the pitcher's own simulation. */
export interface SnapMsg {
  k: 'snap';
  mid: string;
  n: number;
  /** Per live shoe: centre-of-mass position and orientation [px,py,pz,qx,qy,qz,qw], or null if removed. */
  bodies: (number[] | null)[];
  fouls: boolean[];
}

type Msg =
  | { k: 'hello'; m: Member }
  | { k: 'state'; st: RoomState }
  | { k: 'ping' }
  | { k: 'bye' }
  | { k: 'closed' }
  | { k: 'full'; to: string }
  | { k: 'forfeit'; mid: string; loser: string }
  | { k: 'result'; mid: string; winner: string; loser: string; score: [number, number] }
  | ThrowMsg
  | SnapMsg;

type Envelope = Msg & { f: string; s: number };

export interface RoomEvents {
  state(s: RoomState): void;
  throwMsg(m: ThrowMsg, from: string): void;
  snap(m: SnapMsg, from: string): void;
  forfeit(mid: string, loser: string): void;
  /** A player's game finished (the host records it). */
  result(mid: string, winner: string, loser: string, score: [number, number]): void;
  /** The room is gone (host left, room full, connection lost for good). */
  closed(reason: string): void;
  /** Connection quality changed (true = at least one relay connected). */
  link(ok: boolean): void;
}

export function newCode(): string {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(5));
  for (const v of r) s += CODE_CHARS[v % CODE_CHARS.length];
  return s;
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').slice(0, 5);
}

export const validCode = (c: string) => c.length === 5 && [...c].every((ch) => CODE_CHARS.includes(ch));

function brokers(): string[] {
  // Test hook: ?relay=ws://localhost:8883 points rooms at a local relay.
  const override = new URLSearchParams(location.search).get('relay');
  return override ? override.split(',') : BROKERS;
}

export class Room {
  state: RoomState | null = null;
  readonly isHost: boolean;
  private links: MqttLink[] = [];
  private seq = 0;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private lastHeard = new Map<string, number>();
  private timer = 0;
  private gone = false;
  /** Match id already under way when we joined (we watch the next one). */
  lateFor: string | null = null;

  private constructor(
    readonly code: string,
    readonly me: Member,
    host: boolean,
    private readonly on: RoomEvents,
  ) {
    this.isHost = host;
  }

  private get base() {
    return `ringers/v1/r/${this.code.toLowerCase()}`;
  }

  /** Create a room with a fresh code and become its host. */
  static async create(me: Member, cfg: MatchConfig, on: RoomEvents): Promise<Room> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = new Room(newCode(), me, true, on);
      await room.open();
      // Make sure the code isn't somebody else's live room.
      const existing = await room.waitForState(1500);
      if (existing && Date.now() - existing.t < ROOM_STALE_MS) {
        room.shutdown();
        continue;
      }
      room.state = { v: 1, code: room.code, host: me.id, t: Date.now(), members: [me], queue: [me.id], cfg, status: 'lobby' };
      room.publishState();
      room.startHeartbeat();
      return room;
    }
    throw new Error('Could not create a room. Try again.');
  }

  /** Join a friend's room by code. */
  static async join(code: string, me: Member, on: RoomEvents): Promise<Room> {
    const room = new Room(code, me, false, on);
    await room.open();
    const s = await room.waitForState(7000);
    if (!s || Date.now() - s.t > ROOM_STALE_MS + 15000) {
      room.shutdown();
      throw new Error(`No room ${code} is open right now. Check the code with your friend.`);
    }
    if (s.status === 'playing' && s.match) room.lateFor = s.match.id;
    room.state = s;
    room.send({ k: 'hello', m: me });
    room.startHeartbeat();
    return room;
  }

  private async open() {
    const urls = brokers();
    const will = JSON.stringify({ f: this.me.id, s: -1, k: 'bye' });
    this.links = urls.map((u) => new MqttLink(u, `rg-${this.me.id}-${Math.random().toString(36).slice(2, 7)}`, { topic: `${this.base}/e`, payload: will }));
    const attempts = this.links.map((l) =>
      l.connect().then(() => {
        this.wire(l);
        return l;
      }),
    );
    try {
      await Promise.any(attempts);
    } catch {
      this.shutdown();
      throw new Error('Could not reach the online service. Check your internet connection.');
    }
    this.on.link(true);
  }

  private wire(l: MqttLink) {
    l.onMessage = (topic, payload) => this.receive(topic, payload);
    l.onDown = () => this.reconnect(l);
    l.subscribe(`${this.base}/e`);
    l.subscribe(`${this.base}/s`);
  }

  private async reconnect(l: MqttLink) {
    if (this.gone) return;
    if (!this.links.some((x) => x.connected)) this.on.link(false);
    for (let delay = 1000; !this.gone; delay = Math.min(15000, delay * 2)) {
      await new Promise((r) => setTimeout(r, delay));
      if (this.gone) return;
      try {
        await l.connect();
        this.wire(l);
        this.on.link(true);
        if (this.isHost) this.publishState();
        else this.send({ k: 'hello', m: this.me });
        return;
      } catch {
        /* keep trying */
      }
    }
  }

  private waitForState(ms: number): Promise<RoomState | null> {
    return new Promise((resolve) => {
      if (this.state) return resolve(this.state);
      const t = window.setTimeout(() => {
        this.pendingState = null;
        resolve(null);
      }, ms);
      this.pendingState = (s) => {
        window.clearTimeout(t);
        this.pendingState = null;
        resolve(s);
      };
    });
  }
  private pendingState: ((s: RoomState) => void) | null = null;

  private receive(topic: string, payload: string) {
    if (this.gone || !payload) return;
    let m: Envelope;
    try {
      m = JSON.parse(payload) as Envelope;
    } catch {
      return;
    }
    if (!m || typeof m.k !== 'string' || typeof m.f !== 'string') return;
    if (topic.endsWith('/s')) {
      if (m.k !== 'state' || !m.st || m.st.code !== this.code) return;
      this.acceptState(m.st, m.f);
      return;
    }
    if (m.f === this.me.id) return;
    // The same message arrives once per relay: keep the first.
    if (m.s >= 0) {
      const key = `${m.f}:${m.s}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      this.seenOrder.push(key);
      if (this.seenOrder.length > 600) this.seen.delete(this.seenOrder.shift()!);
    }
    this.lastHeard.set(m.f, Date.now());
    switch (m.k) {
      case 'state':
        if (m.st?.code === this.code) this.acceptState(m.st, m.f);
        break;
      case 'hello':
        if (this.isHost) this.admit(m.m);
        break;
      case 'ping':
        break;
      case 'bye':
        if (this.state && m.f === this.state.host && !this.isHost) this.close('The host left, so the room has closed.');
        else if (this.isHost) this.dropMember(m.f);
        break;
      case 'closed':
        if (!this.isHost) this.close('The host closed the room.');
        break;
      case 'full':
        if (m.to === this.me.id) this.close(`Room ${this.code} is full (${MAX_MEMBERS} people).`);
        break;
      case 'forfeit':
        this.on.forfeit(m.mid, m.loser);
        break;
      case 'result':
        if (this.isHost) this.on.result(m.mid, m.winner, m.loser, m.score);
        break;
      case 'throw':
        this.on.throwMsg(m, m.f);
        break;
      case 'snap':
        this.on.snap(m, m.f);
        break;
    }
  }

  private acceptState(s: RoomState, from: string) {
    if (this.pendingState) this.pendingState(s);
    if (this.isHost) return; // the host is the source of truth
    if (from !== s.host) return;
    if (this.state && s.t < this.state.t) return;
    this.state = s;
    this.lastHeard.set(s.host, Date.now());
    if (!s.members.some((x) => x.id === this.me.id)) {
      // Not admitted yet (or dropped after a long stall): ask again.
      this.send({ k: 'hello', m: this.me });
    }
    this.on.state(s);
  }

  // ------------------------------------------------------------ host

  private admit(m: Member) {
    const s = this.state;
    if (!s) return;
    const i = s.members.findIndex((x) => x.id === m.id);
    if (i >= 0) s.members[i] = m;
    else {
      if (s.members.length >= MAX_MEMBERS) {
        this.send({ k: 'full', to: m.id });
        return;
      }
      s.members.push(m);
      s.queue.push(m.id);
    }
    this.publishState();
  }

  private dropMember(id: string) {
    const s = this.state;
    if (!s || id === s.host || !s.members.some((x) => x.id === id)) return;
    s.members = s.members.filter((x) => x.id !== id);
    s.queue = s.queue.filter((x) => x !== id);
    this.lastHeard.delete(id);
    if (s.status === 'playing' && s.match && s.match.players.includes(id)) {
      const mid = s.match.id;
      this.send({ k: 'forfeit', mid, loser: id });
      this.on.forfeit(mid, id);
    }
    this.publishState();
  }

  /** Host: change the game settings. */
  setConfig(cfg: MatchConfig) {
    if (!this.isHost || !this.state) return;
    this.state.cfg = cfg;
    this.publishState();
  }

  /** Host: start a match between the first two in the queue. */
  startMatch() {
    const s = this.state;
    if (!this.isHost || !s || s.queue.length < 2) return;
    const players: [string, string] = [s.queue[0], s.queue[1]];
    s.status = 'playing';
    s.match = { id: Math.random().toString(36).slice(2, 10), players, first: players[crypto.getRandomValues(new Uint8Array(1))[0] & 1] };
    this.publishState();
  }

  /** Host: live score for the lobby. */
  updateScore(mid: string, score: [number, number], label: string) {
    const s = this.state;
    if (!this.isHost || !s?.match || s.match.id !== mid) return;
    s.match.score = score;
    s.match.label = label;
    this.publishState();
  }

  /** Host: a match ended. The winner stays on; the loser goes to the back of the queue. */
  finishMatch(mid: string, winner: string, loser: string, score: [number, number], forfeit = false) {
    const s = this.state;
    if (!this.isHost || !s?.match || s.match.id !== mid) return;
    s.status = 'lobby';
    s.match = undefined;
    s.last = { winner, loser, score, forfeit };
    s.queue = [winner, ...s.queue.filter((x) => x !== winner && x !== loser), ...(s.members.some((m) => m.id === loser) ? [loser] : [])];
    this.publishState();
  }

  private publishState() {
    if (!this.state) return;
    this.state.t = Date.now();
    const env = JSON.stringify({ f: this.me.id, s: -1, k: 'state', st: this.state });
    for (const l of this.links) if (l.connected) l.publish(`${this.base}/s`, env, true);
    this.on.state(this.state);
  }

  // ------------------------------------------------------------ everyone

  send(msg: Msg) {
    const env = JSON.stringify({ ...msg, f: this.me.id, s: this.seq++ });
    for (const l of this.links) if (l.connected) l.publish(`${this.base}/e`, env);
  }

  /** Update my own name or shoes while in the lobby. */
  updateMe(m: Member) {
    Object.assign(this.me, m);
    if (this.isHost) this.admit(this.me);
    else this.send({ k: 'hello', m: this.me });
  }

  private startHeartbeat() {
    this.timer = window.setInterval(() => {
      if (this.gone) return;
      const now = Date.now();
      if (this.isHost) {
        for (const m of this.state?.members ?? []) {
          if (m.id === this.me.id) continue;
          const heard = this.lastHeard.get(m.id) ?? now;
          if (!this.lastHeard.has(m.id)) this.lastHeard.set(m.id, now);
          if (now - heard > MEMBER_TIMEOUT_MS) this.dropMember(m.id);
        }
        this.publishState();
      } else {
        this.send({ k: 'ping' });
        const heard = this.lastHeard.get(this.state?.host ?? '') ?? now;
        if (!this.lastHeard.has(this.state?.host ?? '')) this.lastHeard.set(this.state?.host ?? '', now);
        if (now - heard > MEMBER_TIMEOUT_MS) this.close('Lost touch with the host.');
      }
    }, HEARTBEAT_MS);
  }

  /** Leave the room (the host leaving closes it for everyone). */
  leave() {
    if (this.gone) return;
    if (this.isHost) {
      this.send({ k: 'closed' });
      for (const l of this.links) if (l.connected) l.publish(`${this.base}/s`, '', true);
    } else this.send({ k: 'bye' });
    this.shutdown();
  }

  private close(reason: string) {
    if (this.gone) return;
    this.shutdown();
    this.on.closed(reason);
  }

  private shutdown() {
    this.gone = true;
    window.clearInterval(this.timer);
    // Give the last messages a moment to leave before closing the sockets.
    const links = this.links;
    setTimeout(() => links.forEach((l) => l.close()), 300);
  }

  member(id: string): Member | undefined {
    return this.state?.members.find((m) => m.id === id);
  }
}
