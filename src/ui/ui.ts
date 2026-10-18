import * as THREE from 'three';
import { COLOR_PRESETS, FINISHES, GRIPS, MODELS, WEIGHTS, hsvToCss, sameLoadout, shoeRatings, shoeTraits, type FinishId, type Grip, type Hsv, type Loadout, type ModelId, type WeightId } from '../core/equipment';
import { shoeGeometry } from '../core/shoeShape';
import { formatDistance, type InningScore, type ShoeResult } from '../core/scoring';
import { DIFFICULTY, type Difficulty } from '../input/throwControl';
import type { InningRecord, Match, PlayerStats } from '../game/match';
import { ringerPct } from '../game/match';
import { EXHIBITION_OPPONENTS } from '../game/roster';
import type { SaveData } from '../game/save';
import { HUMAN_ID, humanPool, nextHumanGame, opponentOf, poolStandings, stageLabel, type Tournament } from '../game/tournament';
import { h, icons, meter, seg, svg, toggle, topbar } from './dom';
import { canFullscreen, layout, tapWord, toggleFullscreen } from './layout';
import { MAX_MEMBERS, normalizeCode, validCode, type Room, type RoomState } from '../net/room';
import type { MatchConfig } from '../game/match';
import { VENUE_IDS, VENUES, venueOf, type VenueId } from '../render/venues';

export interface UIActions {
  data: SaveData;
  persist(): void;
  tap(kind?: 'tap' | 'confirm' | 'back'): void;
  startQuickMatch(): void;
  startPractice(): void;
  startTournamentGame(): void;
  newTournament(): void;
  simulateTournament(): void;
  abandonTournament(): void;
  previewLoadout(l: Loadout | null): void;
  setLoadout(l: Loadout): void;
  applySettings(): void;
  resetData(): void;
  resume(): void;
  quitToMenu(): void;
  toggleZoom(): boolean;
  pause(): void;
  setMenuBackdrop(kind: 'orbit' | 'shop'): void;
  previewVenue(id: VenueId): void;
  room: Room | null;
  inviteCode: string;
  onlineCreate(): Promise<void>;
  onlineJoin(code: string): Promise<void>;
  onlineLeave(): void;
  onlineStart(): void;
  onlineConfig(cfg: MatchConfig): void;
  onlineUpdateMe(): void;
}

/** Link that opens the game straight to a room (the public web version). */
export function inviteUrl(code: string): string {
  const here = location.protocol.startsWith('http') && (location.hostname.endsWith('github.io') || location.hostname === 'localhost');
  const base = here ? `${location.origin}${location.pathname}` : 'https://xtoki420x.github.io/Ringers/';
  return `${base}?room=${code}`;
}

const IN_PER_M = 1 / 0.0254;

/** Layer for dialogs and toasts (scaled with the interface on big screens). */
const overlayRoot = () => document.getElementById('overlay') ?? document.getElementById('app')!;

export class UI {
  readonly screens = document.getElementById('screens')!;
  readonly hud = document.getElementById('hud')!;
  readonly labels = document.getElementById('labels')!;
  private calloutEl: HTMLElement;
  private hintEl: HTMLElement;
  private replayEl: HTMLElement;
  private badgeEl: HTMLElement;
  private readoutEl: HTMLElement;
  private sheetEl: HTMLElement | null = null;
  private pcards: [HTMLElement, HTMLElement];
  private centerEl: HTMLElement;
  private zoomBtn: HTMLElement;
  private tags: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private calloutTimer = 0;
  current = '';

  constructor(private readonly a: UIActions) {
    this.pcards = [h('div', { class: 'pcard p0' }), h('div', { class: 'pcard right p1' })];
    this.centerEl = h('div', { class: 'center-info' });
    this.calloutEl = h('div', { class: 'callout' });
    this.hintEl = h('div', { class: 'hint' });
    this.readoutEl = h('div', { class: 'readout' });
    this.replayEl = h('button', { class: 'replay-btn hidden' }, svg(icons.play), 'Instant replay');
    this.badgeEl = h('div', { class: 'replay-badge hidden' }, h('i'), 'Replay');
    this.zoomBtn = h('button', { class: 'iconbtn', 'aria-label': 'Zoom', onclick: () => this.zoomBtn.classList.toggle('on', this.a.toggleZoom()) }, svg(icons.zoom));
    this.hud.append(
      h('div', { class: 'scorebar' }, this.pcards[0], this.centerEl, this.pcards[1]),
      h('div', { class: 'hud-buttons' }, h('button', { class: 'iconbtn', 'aria-label': 'Pause', onclick: () => this.a.pause() }, svg(icons.pause)), this.zoomBtn),
      this.calloutEl,
      this.readoutEl,
      this.replayEl,
      this.badgeEl,
      this.hintEl,
    );
    this.showHud(false);
  }

  // ------------------------------------------------------------ plumbing

  /** Keyboard shortcuts for menus and dialogs. Returns true when the key was used. */
  key(k: string): boolean {
    const overlay = overlayRoot();
    const modals = overlay.querySelectorAll<HTMLElement>('.modal');
    const modal = modals[modals.length - 1];
    const primary = modal?.querySelector<HTMLButtonElement>('.btn.primary');
    if (k === 'Escape') {
      // Pause menu: resume. Confirmations: cancel.
      if (modal) {
        if (modal.dataset.kind === 'pause' || modal.dataset.kind === 'ask') {
          primary?.click();
          return true;
        }
        return false;
      }
      const back = this.screens.querySelector<HTMLButtonElement>('.topbar .back');
      if (back) {
        back.click();
        return true;
      }
      return false;
    }
    if (k === 'Enter' && primary) {
      primary.click();
      return true;
    }
    if ((k === 'z' || k === 'Z') && !this.screens.childElementCount && this.zoomBtn.style.visibility !== 'hidden') {
      this.zoomBtn.click();
      return true;
    }
    if ((k === 'r' || k === 'R') && !this.replayEl.classList.contains('hidden')) {
      this.replayEl.click();
      return true;
    }
    return false;
  }

  private mount(name: string, el: HTMLElement) {
    if (name !== 'lobby') this.lobbyBody = null;
    this.current = name;
    this.screens.replaceChildren(el);
  }

  clearScreens() {
    this.lobbyBody = null;
    this.current = '';
    this.screens.replaceChildren();
  }

  /** In-game confirmation dialog (browser confirm() is unavailable in embedded views). */
  ask(question: string, action: string, onYes: () => void) {
    const modal = h('div', { class: 'modal', 'data-kind': 'ask' }, h('div', { class: 'panel', style: 'display:grid;gap:10px;text-align:center' },
      h('div', { style: 'font:600 18px var(--head);letter-spacing:.04em;margin:4px 0 6px' }, question),
      h('button', { class: 'btn center', style: 'color:var(--red)', onclick: () => { modal.remove(); this.a.tap('confirm'); onYes(); } }, action),
      h('button', { class: 'btn primary center', onclick: () => { modal.remove(); this.a.tap('back'); } }, 'Cancel'),
    ));
    overlayRoot().append(modal);
  }

  toast(text: string, ms = 2200) {
    const t = h('div', { class: 'toast' }, text);
    overlayRoot().append(t);
    setTimeout(() => t.remove(), ms);
  }

  loading(progress: number, msg: string) {
    const bar = document.querySelector('#loading .bar i') as HTMLElement | null;
    const m = document.querySelector('#loading .msg') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (m) m.textContent = msg;
  }

  hideLoading() {
    const l = document.getElementById('loading');
    if (!l) return;
    l.style.opacity = '0';
    setTimeout(() => l.remove(), 650);
  }

  // ------------------------------------------------------------- screens

  title() {
    this.a.setMenuBackdrop('orbit');
    const t = this.a.data.tournament;
    const btn = (label: string, icon: string, onclick: () => void, extra?: string, primary = false) =>
      h('button', { class: `btn${primary ? ' primary' : ''}`, onclick: () => { this.a.tap(); onclick(); } }, svg(icon), label, extra ? h('small', null, extra) : null);
    this.mount(
      'title',
      h(
        'div',
        { class: 'screen clear title-screen' },
        h('div', { class: 'title-wrap' }, h('div', { class: 'logo' }, 'RINGERS'), h('div', { class: 'logo-sub' }, 'Championship Horseshoes')),
        h(
          'div',
          { class: 'menu' },
          btn('Quick Match', icons.play, () => this.quickMatch(), 'vs. the tour', true),
          btn(t ? 'Championship' : 'World Championship', icons.trophy, () => this.tournamentHub(), t ? stageLabel(t) : '64-pitcher field'),
          btn('Play Online', icons.users, () => this.online(), 'rooms with friends'),
          btn('Practice', icons.target, () => this.a.startPractice(), 'free pitching'),
          btn('Pro Shop', icons.bag, () => this.shop(), 'models · weights · colors'),
          btn('Career', icons.chart, () => this.career()),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
            h('button', { class: 'btn center', onclick: () => { this.a.tap(); this.settings(() => this.title()); } }, svg(icons.gear), 'Settings'),
            h('button', { class: 'btn center', onclick: () => { this.a.tap(); this.tutorial(); } }, svg(icons.help), 'How to Pitch'),
          ),
        ),
      ),
    );
  }

  quickMatch() {
    const q = this.a.data.quick;
    const cards = h('div', { class: 'cards' });
    const renderCards = () =>
      cards.replaceChildren(
        ...EXHIBITION_OPPONENTS.map((o, i) =>
          h(
            'div',
            { class: `card${q.opponent === i ? ' on' : ''}`, onclick: () => { q.opponent = i; this.a.tap(); renderCards(); } },
            h('div', { class: 'nm' }, o.name),
            h('div', { class: 'sub' }, o.hometown),
            h('div', { class: 'rt' }, `${o.rating.toFixed(0)}%`, h('span', null, 'ringers')),
            meter(o.rating),
            h('div', { class: 'sub', style: 'margin-top:8px' }, `${GRIPS[o.grip].short} · ${MODELS[o.loadout.model].name}`),
          ),
        ),
      );
    renderCards();
    const formats = [
      { value: 'c21', label: 'To 21', sub: 'Cancellation' },
      { value: 'c40', label: 'To 40', sub: 'NHPA cancel' },
      { value: 'a20', label: '20 Shoes', sub: 'Count-all' },
      { value: 'a40', label: '40 Shoes', sub: 'NHPA count-all' },
    ];
    const fmt = `${q.mode === 'cancellation' ? 'c' : 'a'}${q.target}`;
    this.mount(
      'quick',
      h(
        'div',
        { class: 'screen dim' },
        topbar('Quick Match', () => { this.a.tap('back'); this.title(); }),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Opponent'), cards),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Venue'), this.venuePicker(q.venue, (v) => this.a.previewVenue(v))),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Game'), seg(formats, fmt, (v) => {
          q.mode = v[0] === 'c' ? 'cancellation' : 'countall';
          q.target = Number(v.slice(1));
        })),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Distance'), seg([
          { value: 40, label: '40 ft', sub: 'Men / Open' },
          { value: 30, label: '30 ft', sub: 'Women · Elders · Juniors' },
        ], q.distance, (v) => (q.distance = v as 40 | 30))),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Pit fill'), seg([
          { value: 'sand', label: 'Sand', sub: 'Shoes dig & stop' },
          { value: 'clay', label: 'Blue Clay', sub: 'Shoes stick dead' },
        ], q.pit, (v) => (q.pit = v as 'sand' | 'clay'))),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Time of day'), seg([
          { value: 'morning', label: 'Morning' },
          { value: 'afternoon', label: 'Afternoon' },
          { value: 'sunset', label: 'Sunset' },
          { value: 'night', label: 'Lights' },
        ], q.time, (v) => (q.time = v as typeof q.time))),
        this.gripSection(),
        h('button', { class: 'btn primary center', style: 'margin-top:auto', onclick: () => { this.a.tap('confirm'); this.a.persist(); this.a.startQuickMatch(); } }, svg(icons.play), 'Pitch'),
      ),
    );
  }

  /** Venue cards: name, number of courts and a line about the place. */
  private venuePicker(value: VenueId, pick: (v: VenueId) => void): HTMLElement {
    const cards = h('div', { class: 'cards venues' });
    const render = (on: VenueId) =>
      cards.replaceChildren(
        ...VENUE_IDS.map((id) => {
          const v = VENUES[id];
          return h(
            'div',
            { class: `card venue${on === id ? ' on' : ''}`, onclick: () => { this.a.tap(); pick(id); render(id); } },
            h('div', { class: 'nm' }, v.name),
            h('div', { class: 'courts' }, v.courts === 1 ? '1 court' : `${v.courts} courts`),
            h('div', { class: 'sub' }, v.blurb),
          );
        }),
      );
    render(value);
    return cards;
  }

  private gripSection(): HTMLElement {
    const d = this.a.data;
    return h('div', { class: 'section' }, h('div', { class: 'label' }, 'Your delivery'), seg(
      (Object.keys(GRIPS) as Grip[]).map((g) => ({ value: g, label: GRIPS[g].short, sub: g === 'flip' ? 'single flip' : 'turn' })),
      d.grip,
      (v) => { d.grip = v as Grip; this.a.persist(); },
    ));
  }

  shop(back: () => void = () => this.title()) {
    this.a.setMenuBackdrop('shop');
    const d = this.a.data;
    const l: Loadout = { ...d.loadout, color: [...d.loadout.color] };
    const panel = h('div', { class: 'shop-panel' });
    let equipBtn: HTMLButtonElement;
    const refreshEquip = () => {
      const equipped = sameLoadout(d.loadout, l);
      equipBtn.className = `btn ${equipped ? '' : 'primary'} center`;
      equipBtn.disabled = equipped;
      equipBtn.textContent = equipped ? 'Equipped' : 'Equip these shoes';
    };
    const colorSection = (): HTMLElement => {
      const swatch = h('div', { class: 'color-now' });
      const hex = h('span', { class: 'color-hex' });
      const sliders: { input: HTMLInputElement; track: (c: Hsv) => string; get: (c: Hsv) => number; set: (c: Hsv, v: number) => void }[] = [
        {
          input: h('input', { type: 'range', min: '0', max: '360', step: '1', 'aria-label': 'Hue' }),
          track: () => `linear-gradient(90deg,${[0, 60, 120, 180, 240, 300, 360].map((hue) => hsvToCss([hue, 0.85, 0.95])).join(',')})`,
          get: (c) => c[0],
          set: (c, v) => (c[0] = v % 360),
        },
        {
          input: h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Color strength' }),
          track: (c) => `linear-gradient(90deg,${hsvToCss([c[0], 0, Math.max(0.4, c[2])])},${hsvToCss([c[0], 1, Math.max(0.4, c[2])])})`,
          get: (c) => Math.round(c[1] * 100),
          set: (c, v) => (c[1] = v / 100),
        },
        {
          input: h('input', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Brightness' }),
          track: (c) => `linear-gradient(90deg,#000,${hsvToCss([c[0], c[1], 1])})`,
          get: (c) => Math.round(c[2] * 100),
          set: (c, v) => (c[2] = v / 100),
        },
      ];
      const presets = COLOR_PRESETS.map((p) =>
        h('div', {
          class: 'swatch sm',
          title: p.name,
          style: `background:${hsvToCss(p.color)}`,
          onclick: () => {
            l.color = [...p.color];
            l.finish = p.finish ?? (FINISHES[l.finish].metalness > 0.5 ? 'gloss' : l.finish);
            this.a.tap();
            render();
          },
        }),
      );
      const sync = () => {
        const css = hsvToCss(l.color);
        swatch.style.background = css;
        hex.textContent = css.toUpperCase();
        for (const s of sliders) {
          s.input.value = String(s.get(l.color));
          s.input.style.setProperty('--track', s.track(l.color));
          s.input.style.setProperty('--thumb', css);
        }
        presets.forEach((el, i) => el.classList.toggle('on', COLOR_PRESETS[i].color.every((v, k) => Math.abs(v - l.color[k]) < 1e-6)));
      };
      for (const s of sliders)
        s.input.addEventListener('input', () => {
          s.set(l.color, Number(s.input.value));
          sync();
          this.a.previewLoadout(l);
          refreshEquip();
        });
      sync();
      const row = (name: string, input: HTMLElement) => h('label', { class: 'slider-row' }, h('span', null, name), input);
      return h('div', { class: 'color-box' },
        h('div', { class: 'label color-label' }, 'Color', swatch, hex),
        h('div', { class: 'swatches presets' }, ...presets),
        row('Hue', sliders[0].input),
        row('Strength', sliders[1].input),
        row('Bright', sliders[2].input),
      );
    };
    const render = () => {
      const model = MODELS[l.model];
      this.a.previewLoadout(l);
      const g = shoeGeometry(l.model);
      const r = shoeRatings(l);
      const t = shoeTraits(l);
      equipBtn = h('button', {
        onclick: () => { d.loadout = { ...l, color: [...l.color] }; this.a.setLoadout(d.loadout); this.a.tap('confirm'); this.toast('Equipped'); refreshEquip(); },
      });
      panel.replaceChildren(
        h('div', { class: 'brand-head' }, h('div', { class: 'bn' }, model.name), h('div', { class: 'hd' }, `${model.hardness} steel`)),
        h('div', { class: 'tagline' }, model.tagline),
        h('div', { class: 'label' }, 'Model'),
        h('div', { class: 'chips', style: 'margin-bottom:12px' }, ...(Object.keys(MODELS) as ModelId[]).map((m) =>
          h('button', {
            class: m === l.model ? 'on' : '',
            onclick: () => {
              if (m === l.model) return;
              // A new model arrives in its factory colours.
              l.model = m;
              l.finish = MODELS[m].finish;
              l.color = [...MODELS[m].color];
              this.a.tap();
              render();
            },
          }, MODELS[m].name),
        )),
        h('div', { class: 'label' }, 'Weight'),
        h('div', { class: 'chips', style: 'margin-bottom:12px' }, ...(Object.keys(WEIGHTS) as WeightId[]).map((w) =>
          h('button', { class: w === l.weight ? 'on' : '', onclick: () => { l.weight = w; this.a.tap(); render(); } }, WEIGHTS[w].label),
        )),
        colorSection(),
        h('div', { class: 'label' }, 'Finish'),
        h('div', { class: 'chips', style: 'margin-bottom:6px' }, ...(Object.keys(FINISHES) as FinishId[]).map((f) =>
          h('button', { class: f === l.finish ? 'on' : '', onclick: () => { l.finish = f; this.a.tap(); this.a.previewLoadout(l); render(); } }, FINISHES[f].name),
        )),
        h('div', { class: 'bars' },
          ...([['Catch', r.catch], ['Hold', r.hold], ['Stability', r.stability], ['Deadness', r.deadness], ['Control', r.control]] as [string, number][]).flatMap(([k, v]) => [
            h('span', null, k), meter(v), h('span', { style: 'color:var(--muted);font-variant-numeric:tabular-nums' }, String(v)),
          ]),
        ),
        h('div', { class: 'spec', html: `<b>${(g.width * IN_PER_M).toFixed(2)}″</b> wide · <b>${(g.length * IN_PER_M).toFixed(2)}″</b> long · <b>${(g.opening * IN_PER_M).toFixed(2)}″</b> opening · <b>${WEIGHTS[l.weight].label}</b> · restitution <b>${t.restitution.toFixed(2)}</b> · NHPA legal ✓` }),
        equipBtn,
      );
      refreshEquip();
    };
    render();
    this.mount('shop', h('div', { class: 'screen shop-screen', style: 'background:linear-gradient(180deg,rgba(8,11,16,.5),rgba(8,11,16,0) 18%)' },
      topbar('Pro Shop', () => { this.a.tap('back'); this.a.previewLoadout(null); back(); }),
      panel,
    ));
  }

  // ------------------------------------------------------------- online

  /** Create a room or join one with a code. */
  online(message?: string) {
    this.a.setMenuBackdrop('orbit');
    const d = this.a.data;
    const field = 'background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:12px 14px;font:inherit;width:100%';
    const name = h('input', { value: d.name === 'You' ? '' : d.name, maxlength: '16', placeholder: 'Your name', autocomplete: 'nickname', style: field }) as HTMLInputElement;
    const code = h('input', { value: normalizeCode(this.a.inviteCode), maxlength: '5', placeholder: 'CODE', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', class: 'code-input', style: field }) as HTMLInputElement;
    code.addEventListener('input', () => (code.value = normalizeCode(code.value)));
    const msg = h('div', { class: 'net-msg' }, message ?? '');
    const createBtn = h('button', { class: 'btn primary center' }, svg(icons.users), 'Create a room') as HTMLButtonElement;
    const joinBtn = h('button', { class: 'btn center' }, 'Join') as HTMLButtonElement;
    const busy = (on: boolean, text = '') => {
      createBtn.disabled = joinBtn.disabled = on;
      msg.textContent = text;
      msg.classList.toggle('busy', on);
    };
    const named = () => {
      const n = name.value.trim();
      if (!n) {
        msg.textContent = 'Enter your name so your friends know who you are.';
        name.focus();
        return false;
      }
      d.name = n;
      this.a.persist();
      return true;
    };
    createBtn.onclick = async () => {
      if (!named()) return;
      this.a.tap('confirm');
      busy(true, 'Opening a room…');
      try {
        await this.a.onlineCreate();
      } catch (e) {
        busy(false, (e as Error).message);
      }
    };
    const join = async () => {
      if (!named()) return;
      const c = normalizeCode(code.value);
      if (!validCode(c)) {
        msg.textContent = 'Room codes are 5 letters and numbers.';
        code.focus();
        return;
      }
      this.a.tap('confirm');
      busy(true, `Looking for room ${c}…`);
      try {
        await this.a.onlineJoin(c);
      } catch (e) {
        busy(false, (e as Error).message);
      }
    };
    joinBtn.onclick = join;
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    this.mount('online', h('div', { class: 'screen dim' },
      topbar('Play Online', () => { this.a.tap('back'); this.title(); }),
      h('div', { class: 'section' }, h('div', { class: 'label' }, 'Your name'), name),
      h('div', { class: 'panel', style: 'display:grid;gap:10px;margin-bottom:16px' },
        h('div', { style: 'font:600 15px var(--head);letter-spacing:.06em;text-transform:uppercase' }, 'Host a game'),
        h('div', { style: 'color:var(--muted);font-size:13px;line-height:1.45' }, 'Get a room code to send your friends. You pick the game; they join from their phone or PC.'),
        createBtn,
      ),
      h('div', { class: 'panel', style: 'display:grid;gap:10px;margin-bottom:12px' },
        h('div', { style: 'font:600 15px var(--head);letter-spacing:.06em;text-transform:uppercase' }, 'Join a friend'),
        h('div', { style: 'display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center' }, code, joinBtn),
      ),
      msg,
      h('p', { style: 'color:var(--muted);font-size:12px;line-height:1.5;text-align:center;margin-top:10px' }, `Rooms hold up to ${MAX_MEMBERS} people. Two pitch at a time while everyone else watches live — the winner stays on and the next in line steps up.`),
    ));
    if (this.a.inviteCode && d.name !== 'You') code.focus();
    else if (d.name === 'You') name.focus();
  }

  private lobbyKey = '';
  private lobbyBody: HTMLElement | null = null;

  /** The room: code to share, who's here, the game, and the start button. */
  lobby() {
    const r = this.a.room;
    const st = r?.state;
    if (!r || !st) {
      this.online();
      return;
    }
    // Room updates arrive every few seconds; only redraw when something changed,
    // and redraw in place (no screen fade) so the lobby never blinks.
    const key = JSON.stringify({ ...st, t: 0 }) + (r.lateFor ?? '');
    if (this.current === 'lobby' && this.lobbyBody && key === this.lobbyKey) return;
    this.lobbyKey = key;
    const body = this.lobbyContent(r, st);
    if (this.current === 'lobby' && this.lobbyBody) {
      this.lobbyBody.replaceChildren(...body);
      return;
    }
    this.a.setMenuBackdrop('orbit');
    this.lobbyBody = h('div', { class: 'lobby-body' }, ...body);
    this.mount('lobby', h('div', { class: 'screen dim' },
      topbar(`Room ${r.code}`, () => {
        this.a.tap('back');
        this.ask(r.isHost ? 'Close the room for everyone?' : 'Leave the room?', r.isHost ? 'Close room' : 'Leave', () => {
          this.a.onlineLeave();
          this.online();
        });
      }),
      this.lobbyBody,
    ));
  }

  private lobbyContent(r: Room, st: RoomState): HTMLElement[] {
    const me = r.me.id;
    const nameOf = (id: string) => st.members.find((m) => m.id === id)?.name ?? '—';
    const url = inviteUrl(r.code);
    const text = `Join my Ringers horseshoe room! Code: ${r.code}`;
    const share = async () => {
      this.a.tap();
      const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
      if (nav.share && layout.coarse) {
        try {
          await nav.share({ title: 'Ringers', text, url });
          return;
        } catch {
          /* cancelled: fall back to copying */
        }
      }
      try {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        this.toast('Invite copied — paste it to your friends');
      } catch {
        this.toast(`Room code: ${r.code}`);
      }
    };
    const playing = st.status === 'playing' && st.match;
    const out: HTMLElement[] = [
      h('div', { class: 'panel room-card' },
        h('div', { class: 'label', style: 'text-align:center;margin-bottom:6px' }, 'Room code'),
        h('div', { class: 'room-code' }, ...[...r.code].map((ch) => h('span', null, ch))),
        h('div', { style: 'color:var(--muted);font-size:12px;text-align:center;margin:8px 0 12px' }, 'Friends tap Play Online → Join and enter this code, or open the invite link.'),
        h('button', { class: 'btn primary center', onclick: share }, svg(layout.coarse ? icons.share : icons.copy), layout.coarse ? 'Invite friends' : 'Copy invite'),
      ),
    ];
    if (playing) {
      const m = st.match!;
      out.push(h('div', { class: 'panel now-playing' },
        h('div', { class: 'label' }, 'Now pitching'),
        h('div', { class: 'np-line' }, h('b', null, nameOf(m.players[0])), m.score ? h('span', { class: 'np-score' }, `${m.score[0]} – ${m.score[1]}`) : h('span', { class: 'np-score' }, 'vs'), h('b', null, nameOf(m.players[1]))),
        m.label ? h('div', { style: 'color:var(--muted);font-size:12px;text-align:center' }, m.label) : null,
        r.lateFor === m.id ? h('div', { style: 'color:var(--gold);font-size:12px;text-align:center;margin-top:6px' }, 'You joined mid-game — you’ll watch the next one live.') : null,
      ));
    } else if (st.last) {
      const l = st.last;
      out.push(h('div', { class: 'last-result' }, `${nameOf(l.winner)} beat ${nameOf(l.loser)} ${Math.max(...l.score)}–${Math.min(...l.score)}${l.forfeit ? ' (forfeit)' : ''} · winner stays on`));
    }
    out.push(h('div', { class: 'label', style: 'margin-top:14px' }, `In the room · ${st.members.length}/${MAX_MEMBERS}`));
    out.push(h('div', { class: 'panel members' }, ...st.queue.map((id, i) => {
      const m = st.members.find((x) => x.id === id);
      if (!m) return h('div');
      const pitching = playing && st.match!.players.includes(id);
      const status = pitching ? 'Pitching' : i < 2 ? 'Up next' : `${i - 1}${i - 1 === 1 ? 'st' : i - 1 === 2 ? 'nd' : i - 1 === 3 ? 'rd' : 'th'} in line`;
      const [hh, ss, vv] = m.loadout.color ?? [0, 0, 0.5];
      return h('div', { class: `member${id === me ? ' me' : ''}` },
        h('i', { class: 'dot', style: `background:hsl(${hh},${Math.round(ss * 100)}%,${Math.round(vv * 50)}%)` }),
        h('span', { class: 'nm' }, m.name, id === me ? h('small', null, ' (you)') : null, id === st.host ? h('small', { class: 'host' }, ' host') : null),
        h('span', { class: `st${pitching ? ' on' : ''}` }, status),
      );
    })));
    const cfg = st.cfg;
    const fmtLabel = `${VENUES[venueOf(cfg.venue)].name} · ${cfg.mode === 'cancellation' ? `Cancellation to ${cfg.target}` : `Count-all, ${cfg.target} shoes`} · ${cfg.distance} ft · ${cfg.pit === 'sand' ? 'sand' : 'blue clay'} · ${cfg.time}`;
    if (r.isHost && !playing) {
      const set = (patch: Partial<MatchConfig>) => this.a.onlineConfig({ ...cfg, ...patch });
      out.push(
        h('div', { class: 'label', style: 'margin-top:14px' }, 'Venue'),
        this.venuePicker(venueOf(cfg.venue), (v) => set({ venue: v })),
        h('div', { class: 'label', style: 'margin-top:14px' }, 'Game'),
        seg([
          { value: 'c21', label: 'To 21', sub: 'Cancellation' },
          { value: 'c40', label: 'To 40', sub: 'NHPA cancel' },
          { value: 'a20', label: '20 Shoes', sub: 'Count-all' },
          { value: 'a40', label: '40 Shoes', sub: 'NHPA count-all' },
        ], `${cfg.mode === 'cancellation' ? 'c' : 'a'}${cfg.target}`, (v) => set({ mode: v[0] === 'c' ? 'cancellation' : 'countall', target: Number(v.slice(1)) })),
        h('div', { style: 'height:8px' }),
        seg([{ value: 40, label: '40 ft' }, { value: 30, label: '30 ft' }], cfg.distance, (v) => set({ distance: v as 40 | 30 })),
        h('div', { style: 'height:8px' }),
        seg([{ value: 'sand', label: 'Sand' }, { value: 'clay', label: 'Blue Clay' }], cfg.pit, (v) => set({ pit: v as 'sand' | 'clay' })),
        h('div', { style: 'height:8px' }),
        seg([{ value: 'morning', label: 'Morning' }, { value: 'afternoon', label: 'Afternoon' }, { value: 'sunset', label: 'Sunset' }, { value: 'night', label: 'Night' }], cfg.time, (v) => set({ time: v as MatchConfig['time'] })),
      );
    } else out.push(h('div', { class: 'label', style: 'margin-top:14px' }, 'Game'), h('div', { class: 'panel', style: 'font-size:13px;color:var(--muted)' }, fmtLabel));
    const canStart = r.isHost && !playing && st.queue.length >= 2;
    const startLabel = playing ? 'Match in progress' : st.queue.length < 2 ? 'Waiting for friends to join…' : r.isHost ? `Start: ${nameOf(st.queue[0])} vs ${nameOf(st.queue[1])}` : 'Waiting for the host to start';
    out.push(
      h('button', { class: `btn ${canStart ? 'primary' : ''} center`, style: 'margin-top:16px', disabled: canStart ? undefined : true, onclick: () => { this.a.tap('confirm'); this.a.onlineStart(); } }, startLabel),
      h('button', { class: 'btn center', style: 'margin-top:10px', onclick: () => { this.a.tap(); this.shop(() => { this.a.onlineUpdateMe(); this.lobbyBody = null; this.lobby(); }); } }, svg(icons.bag), 'My shoes'),
    );
    return out;
  }

  private connEl: HTMLElement | null = null;
  /** Small "Reconnecting…" badge while the online link is down. */
  connection(ok: boolean) {
    if (ok) {
      this.connEl?.remove();
      this.connEl = null;
    } else if (!this.connEl) {
      this.connEl = h('div', { class: 'conn-badge' }, 'Reconnecting…');
      overlayRoot().append(this.connEl);
    }
  }

  career() {
    const c = this.a.data.career;
    const pct = c.shoes ? (100 * c.ringers) / c.shoes : 0;
    const stat = (v: string, k: string) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'k' }, k));
    this.mount('career', h('div', { class: 'screen dim' },
      topbar('Career', () => { this.a.tap('back'); this.title(); }),
      h('div', { class: 'stats' },
        stat(`${pct.toFixed(1)}%`, 'Ringer percentage'),
        stat(String(c.games ? `${c.wins}–${c.games - c.wins}` : '0–0'), 'Won – lost'),
        stat(String(c.ringers), 'Ringers'),
        stat(String(c.doubles), 'Double ringers'),
        stat(c.shoes ? (c.countPoints / c.shoes).toFixed(2) : '0.00', 'Points per shoe'),
        stat(`${c.bestRingerPct.toFixed(1)}%`, 'Best game'),
        stat(String(c.longestRingerStreak), 'Longest ringer streak'),
        stat(String(c.titles), 'Championships'),
        stat(String(c.shoes), 'Shoes pitched'),
        stat(c.practiceShoes ? `${((100 * c.practiceRingers) / c.practiceShoes).toFixed(1)}%` : '—', 'Practice ringer %'),
      ),
      h('p', { style: 'color:var(--muted);font-size:12px;margin-top:16px;line-height:1.5' }, 'Ringer percentage is the stat pitchers are classed by. The world’s best pitch above 80%; a solid league pitcher sits between 30% and 50%.'),
    ));
  }

  settings(back: () => void) {
    const d = this.a.data;
    const s = d.settings;
    const row = (t: string, desc: string, ctl: HTMLElement) => h('div', { class: 'row' }, h('div', null, h('div', { class: 't' }, t), h('div', { class: 'd' }, desc)), ctl);
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volume) }) as HTMLInputElement;
    vol.addEventListener('input', () => { s.volume = Number(vol.value); this.a.applySettings(); });
    vol.addEventListener('change', () => this.a.persist());
    const name = h('input', { value: d.name, maxlength: '16', style: 'background:rgba(255,255,255,.06);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:8px 10px;width:140px;font:inherit' }) as HTMLInputElement;
    name.addEventListener('change', () => { d.name = name.value.trim() || 'You'; this.a.persist(); });
    const save = () => { this.a.applySettings(); this.a.persist(); };
    this.mount('settings', h('div', { class: 'screen dim' },
      topbar('Settings', () => { this.a.tap('back'); back(); }),
      h('div', { class: 'section' }, h('div', { class: 'label' }, 'Difficulty'), seg(
        (Object.keys(DIFFICULTY) as Difficulty[]).map((k) => ({ value: k, label: DIFFICULTY[k].name, sub: DIFFICULTY[k].blurb })),
        s.difficulty,
        (v) => { s.difficulty = v as Difficulty; save(); },
      )),
      h('div', { class: 'section' }, h('div', { class: 'label' }, 'Graphics'), seg([
        { value: 'low', label: 'Battery' }, { value: 'medium', label: 'Balanced' }, { value: 'high', label: 'Ultra' },
      ], s.quality, (v) => { s.quality = v as typeof s.quality; save(); this.toast('Applies on next launch'); })),
      h('div', { class: 'panel' },
        row('Name', 'Shown on the scoreboard', name),
        row('Pitching hand', 'Mirrors your delivery', seg([{ value: 1, label: 'Right' }, { value: -1, label: 'Left' }], s.hand, (v) => { s.hand = v as 1 | -1; save(); })),
        row('Volume', 'Effects and crowd', vol),
        layout.coarse ? row('Haptics', 'Vibration on release and ringers', toggle(s.haptics, (v) => { s.haptics = v; save(); })) : null,
        row('Aim guides', 'Power zone and stroke guide', toggle(s.guides, (v) => { s.guides = v; save(); })),
        row('Slow motion', 'Slow down shoes arriving at the stake', toggle(s.slowmo, (v) => { s.slowmo = v; save(); })),
        row('Quick opponent turns', 'Skip the broadcast camera for AI shoes', toggle(s.fastAi, (v) => { s.fastAi = v; save(); })),
        row('Metric units', 'Measure in centimetres', toggle(s.metric, (v) => { s.metric = v; save(); })),
      ),
      h('button', { class: 'btn center', style: 'margin-top:16px;color:var(--red)', onclick: () => {
        this.ask('Erase all progress, stats and settings?', 'Reset', () => { this.a.resetData(); this.toast('Progress reset'); back(); });
      } }, 'Reset progress'),
      !layout.coarse && canFullscreen() ? h('button', { class: 'btn center', style: 'margin-top:10px', onclick: () => { this.a.tap(); toggleFullscreen(); } }, 'Full screen (F)') : null,
      !layout.coarse
        ? h('div', { class: 'panel keys' },
            ...([
              ['Mouse', 'Press on the lower screen, drag down, then up, and let go on the line'],
              ['Space', 'Speed up a slow-motion flight'],
              ['Z', 'Zoom the aim view'],
              ['R', 'Instant replay'],
              ['F', 'Full screen'],
              ['Esc', 'Pause · back · cancel'],
              ['Enter', 'Confirm'],
            ] as [string, string][]).flatMap(([k, v]) => [h('kbd', null, k), h('span', null, v)]))
        : null,
      h('p', { style: 'color:var(--muted);font-size:11px;text-align:center;margin-top:14px' }, 'Ringers · Court, stake and shoe dimensions follow NHPA rules.'),
    ));
  }

  tutorial(onDone?: () => void) {
    let step = 0;
    const steps = [
      { t: 'Pull back', p: `${layout.coarse ? 'Touch the lower screen' : 'Press the mouse button on the lower screen'} and drag DOWN. That’s your backswing — the further you pull, the more power. Stop in the green zone on the power meter.`, anim: 'pull' },
      { t: 'Swing through', p: `${layout.coarse ? 'Push' : 'Move the mouse'} UP in a straight line. Drifting sideways pulls the shoe off line; a wobbly stroke makes it wobble in the air.`, anim: 'push' },
      { t: 'Release for one flip', p: `${layout.coarse ? 'Lift your finger' : 'Let go of the button'} as it crosses the green RELEASE line where you first ${layout.coarse ? 'touched' : 'clicked'}. On the line = one perfect flip, landing flat and open. Early under-rotates; late over-rotates.`, anim: 'release' },
      { t: 'Score', p: 'Ringer = 3 points. Any shoe within 6″ of the stake = 1. In cancellation games ringers cancel and only one pitcher scores each inning. Leaners count as 1.', anim: '' },
    ];
    const modal = h('div', { class: 'modal' });
    const render = () => {
      const s = steps[step];
      modal.replaceChildren(h('div', { class: 'panel tut' },
        s.anim ? h('div', { class: 'tut-anim' }, h('div', { class: 'line' }), h('div', { class: 'finger' })) : h('div', { style: 'font-size:54px;margin:10px 0;color:var(--gold)', html: icons.shoe.replace('<svg', '<svg width="64" height="64"') }),
        h('h3', null, s.t),
        h('p', null, s.p),
        h('div', { class: 'dots' }, ...steps.map((_, i) => h('i', { class: i === step ? 'on' : '' }))),
        h('button', { class: 'btn primary center', onclick: () => {
          this.a.tap();
          if (step < steps.length - 1) { step++; render(); } else { modal.remove(); this.a.data.seenTutorial = true; this.a.persist(); onDone?.(); }
        } }, step < steps.length - 1 ? 'Next' : 'Let’s pitch'),
      ));
    };
    render();
    overlayRoot().append(modal);
  }

  // -------------------------------------------------------- tournament

  tournamentHub(tab: 'pool' | 'bracket' | 'field' = 'pool') {
    this.a.setMenuBackdrop('orbit');
    const d = this.a.data;
    const t = d.tournament;
    if (!t) {
      this.mount('tournament', h('div', { class: 'screen dim' },
        topbar('World Championship', () => { this.a.tap('back'); this.title(); }),
        h('div', { class: 'panel', style: 'margin-bottom:14px' },
          h('div', { style: 'font:700 22px var(--head);text-transform:uppercase' }, 'The full field'),
          h('p', { style: 'color:var(--muted);font-size:14px;line-height:1.5' }, '64 pitchers. Sixteen round-robin pools of four — win your pool or finish second to reach the 32-pitcher championship bracket. Five more wins and the title is yours.'),
          h('p', { style: 'color:var(--muted);font-size:13px;line-height:1.5' }, 'Games are NHPA count-all: every ringer is 3, every shoe in count is 1.'),
        ),
        h('div', { class: 'section' }, h('div', { class: 'label' }, 'Game length'), seg([
          { value: 20, label: '20 shoes', sub: '10 innings' },
          { value: 40, label: '40 shoes', sub: 'Regulation' },
        ], d.quick.target === 40 && d.quick.mode === 'countall' ? 40 : 20, (v) => { d.quick.mode = 'countall'; d.quick.target = v as number; })),
        this.gripSection(),
        h('button', { class: 'btn primary center', style: 'margin-top:auto', onclick: () => { this.a.tap('confirm'); this.a.newTournament(); } }, svg(icons.trophy), 'Enter the championship'),
      ));
      return;
    }
    const next = nextHumanGame(t);
    const body = h('div');
    const tabs = h('div', { class: 'tabs' }, ...(['pool', 'bracket', 'field'] as const).map((k) =>
      h('button', { class: k === tab ? 'on' : '', onclick: () => { this.a.tap(); this.tournamentHub(k); } }, k === 'pool' ? 'My pool' : k === 'bracket' ? 'Bracket' : 'Field'),
    ));
    if (tab === 'pool') body.append(this.poolView(t));
    else if (tab === 'bracket') body.append(this.bracketView(t));
    else body.append(this.fieldView(t));
    let cta: HTMLElement;
    if (t.stage === 'done') {
      const champ = t.entrants[t.champion!];
      cta = h('div', { class: 'panel', style: 'text-align:center;margin-bottom:12px' },
        h('div', { style: 'color:var(--gold);font:700 14px var(--head);letter-spacing:.2em' }, 'CHAMPION'),
        h('div', { style: 'font:700 30px var(--head);text-transform:uppercase;margin:6px 0' }, champ.name),
        h('button', { class: 'btn primary center', onclick: () => { this.a.tap('confirm'); this.a.abandonTournament(); this.tournamentHub(); } }, 'New championship'),
      );
    } else if (next) {
      const opp = opponentOf(t, next);
      cta = h('div', { class: 'panel', style: 'margin-bottom:12px' },
        h('div', { class: 'label' }, stageLabel(t)),
        h('div', { class: 'vs' },
          h('div', null, h('div', { class: 'who', style: 'color:var(--p0)' }, d.name), h('div', { class: 'meta' }, `Seed ${t.entrants[HUMAN_ID].seed}`)),
          h('div', { class: 'x' }, 'VS'),
          h('div', null, h('div', { class: 'who', style: 'color:var(--p1)' }, opp.name), h('div', { class: 'meta' }, `${opp.rating.toFixed(0)}% ringers · seed ${opp.seed}`)),
        ),
        h('button', { class: 'btn primary center', onclick: () => { this.a.tap('confirm'); this.a.startTournamentGame(); } }, svg(icons.play), 'Pitch'),
      );
    } else {
      cta = h('div', { class: 'panel', style: 'margin-bottom:12px;text-align:center' },
        h('p', { style: 'margin:0 0 10px;color:var(--muted)' }, t.humanEliminated ? 'You’re out — but the championship goes on.' : 'Waiting on the rest of the round.'),
        h('button', { class: 'btn primary center', onclick: () => { this.a.tap(); this.a.simulateTournament(); } }, t.humanEliminated ? 'Simulate to the final' : 'Continue'),
      );
    }
    this.mount('tournament', h('div', { class: 'screen dim' },
      topbar(t.name, () => { this.a.tap('back'); this.title(); }),
      cta,
      tabs,
      body,
      h('button', { class: 'btn center', style: 'margin-top:18px;color:var(--muted)', onclick: () => {
        this.ask('Withdraw from this championship?', 'Withdraw', () => { this.a.abandonTournament(); this.tournamentHub(); });
      } }, 'Withdraw'),
    ));
  }

  private poolView(t: Tournament): HTMLElement {
    const pool = humanPool(t)!;
    const st = poolStandings(t, pool);
    const rows = st.map((s, i) => {
      const e = t.entrants[s.id];
      return h('tr', { class: `${s.id === HUMAN_ID ? 'me' : ''}${i < 2 && t.stage !== 'pools' ? ' adv' : ''}` },
        h('td', null, e.name), h('td', { class: 'n' }, `${s.wins}-${s.losses}`), h('td', { class: 'n' }, String(s.pointsFor - s.pointsAgainst)),
        h('td', { class: 'n' }, s.shoes ? `${((100 * s.ringers) / s.shoes).toFixed(0)}%` : '—'));
    });
    const games = pool.rounds.flatMap((r, ri) => r.map((g) => this.gameCard(t, g, `Round ${ri + 1}`)));
    return h('div', null,
      h('div', { class: 'panel' }, h('div', { class: 'label' }, pool.name),
        h('table', { class: 'std' }, h('thead', null, h('tr', null, h('th', null, 'Pitcher'), h('th', { class: 'n' }, 'W-L'), h('th', { class: 'n' }, '+/-'), h('th', { class: 'n' }, 'R%'))), h('tbody', null, ...rows))),
      h('div', { class: 'round-title' }, 'Pool games'),
      ...games,
    );
  }

  private gameCard(t: Tournament, g: Tournament['pools'][number]['rounds'][number][number], label?: string): HTMLElement {
    const A = t.entrants[g.a], B = t.entrants[g.b];
    const line = (e: typeof A, score: number, won: boolean) =>
      h('div', { class: `ln${won ? ' w' : ''}${e.id === HUMAN_ID ? ' me' : ''}` }, h('span', null, e.name), h('span', null, g.played ? String(score) : ''));
    return h('div', { class: 'match' }, label ? h('div', { style: 'font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px' }, label) : null,
      line(A, g.scoreA, g.winner === g.a), line(B, g.scoreB, g.winner === g.b));
  }

  private bracketView(t: Tournament): HTMLElement {
    if (!t.bracket.length) return h('div', { class: 'panel', style: 'color:var(--muted);font-size:14px' }, 'The 32-pitcher bracket is drawn once pool play finishes: pool winners meet runners-up from the other half of the draw.');
    return h('div', null, ...t.bracket.flatMap((r) => [h('div', { class: 'round-title' }, r.name), ...r.games.map((g) => this.gameCard(t, g))]));
  }

  private fieldView(t: Tournament): HTMLElement {
    const list = Object.values(t.entrants).sort((x, y) => x.seed - y.seed);
    return h('div', { class: 'panel' }, h('table', { class: 'std' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Pitcher'), h('th', null, 'Home'), h('th', { class: 'n' }, 'R%'))),
      h('tbody', null, ...list.map((e) => h('tr', { class: e.isHuman ? 'me' : '' }, h('td', null, String(e.seed)), h('td', null, e.name), h('td', { style: 'color:var(--muted);font-size:11px' }, e.hometown), h('td', { class: 'n' }, e.isHuman ? '—' : e.rating.toFixed(0))))),
    ));
  }

  // ------------------------------------------------------------- in game

  showHud(on: boolean) {
    this.hud.style.display = on ? '' : 'none';
    if (!on) {
      this.callout(null);
      this.sheet(null);
      this.clearTags();
    }
  }

  setPractice(on: boolean) {
    this.pcards[1].style.visibility = on ? 'hidden' : '';
  }

  updateScore(m: Match | null, names: [string, string], practice?: { shoes: number; ringers: number; inCount: number; streak: number }) {
    const pip = (live: boolean) => h('span', { class: `pip${live ? ' live' : ''}`, html: icons.shoe });
    if (!m) {
      const p = practice!;
      this.pcards[0].className = 'pcard p0 active';
      this.pcards[0].replaceChildren(
        h('div', { class: 'pname' }, names[0]),
        h('div', { class: 'pstat' }, `${p.shoes} shoes · ${p.shoes ? ((100 * p.ringers) / p.shoes).toFixed(0) : 0}% R`),
        h('div', { class: 'pscore' }, String(p.ringers)),
      );
      this.centerEl.replaceChildren(h('b', null, 'Practice'), h('span', null, p.streak > 1 ? `${p.streak} in a row` : 'Ringers'));
      return;
    }
    for (const i of [0, 1] as const) {
      const st: PlayerStats = m.stats[i];
      const thrown = m.order[0] === i ? Math.min(2, m.throwIndex) : Math.max(0, m.throwIndex - 2);
      const left = 2 - thrown;
      this.pcards[i].className = `pcard ${i === 0 ? '' : 'right '}p${i}${!m.over && m.pitcher === i ? ' active' : ''}`;
      this.pcards[i].replaceChildren(
        h('div', { class: 'pname' }, names[i]),
        h('div', { class: 'pstat' }, h('span', { class: 'pips' }, pip(left >= 1), pip(left >= 2)), `${ringerPct(st).toFixed(0)}% R`),
        h('div', { class: 'pscore' }, String(m.scores[i])),
      );
    }
    const label = m.progressLabel();
    const [a, b] = label.split(' · ');
    this.centerEl.replaceChildren(h('b', null, a), b ? h('span', null, b) : h('span', null, m.config.mode === 'countall' ? 'Count-all' : 'Cancellation'));
  }

  hint(text: string | null) {
    this.hintEl.textContent = text ?? '';
    this.hintEl.style.opacity = text ? '1' : '0';
  }

  readout(chips: { text: string; tone: 'good' | 'warn' | 'bad' | '' }[] | null) {
    if (!chips) {
      this.readoutEl.style.opacity = '0';
      return;
    }
    this.readoutEl.replaceChildren(...chips.map((c) => h('span', { class: `chip ${c.tone}` }, c.text)));
    this.readoutEl.style.opacity = '1';
  }

  replayButton(onClick: (() => void) | null) {
    this.replayEl.classList.toggle('hidden', !onClick);
    this.replayEl.onclick = onClick
      ? (e) => {
          e.stopPropagation();
          this.a.tap();
          onClick();
        }
      : null;
  }

  replayBadge(on: boolean) {
    this.badgeEl.classList.toggle('hidden', !on);
  }

  callout(big: string | null, sub?: string, plain = false, ms = 1800) {
    clearTimeout(this.calloutTimer);
    if (!big) {
      this.calloutEl.replaceChildren();
      return;
    }
    this.calloutEl.replaceChildren(h('div', { class: `big${plain ? ' plain' : ''}` }, big), ...(sub ? [h('div', { class: 'sub' }, sub)] : []));
    this.calloutTimer = window.setTimeout(() => this.calloutEl.replaceChildren(), ms);
  }

  zoomState(on: boolean, visible: boolean) {
    this.zoomBtn.classList.toggle('on', on);
    this.zoomBtn.style.visibility = visible ? 'visible' : 'hidden';
  }

  sheet(content: HTMLElement | null) {
    this.sheetEl?.remove();
    this.sheetEl = null;
    if (content) {
      this.sheetEl = content;
      this.hud.append(content);
    }
  }

  inningSheet(rec: InningRecord, names: [string, string], metric: boolean, onContinue: () => void, practice = false): HTMLElement {
    const rows = rec.shoes.map((s) => this.shoeRow(s, names, metric));
    const score: InningScore = rec.score;
    const p0 = score.points[0], p1 = score.points[1];
    const who: 0 | 1 | -1 = p0 > 0 ? 0 : p1 > 0 ? 1 : -1;
    const el = h('div', { class: 'sheet', onclick: onContinue },
      h('h3', null, practice ? 'Your pair' : `Inning ${rec.inning}`),
      ...rows,
      practice
        ? null
        : h('div', { class: 'call' }, h('span', null, score.call),
          rec.score.call === 'Count-all'
            ? h('span', { class: 'pts' }, h('span', { style: 'color:var(--p0)' }, `+${p0}`), ' · ', h('span', { style: 'color:var(--p1)' }, `+${p1}`))
            : h('span', { class: 'pts', style: `color:var(--p${who < 0 ? 0 : who})` }, who === -1 ? '0' : `${names[who].split(' ')[0]} +${Math.max(p0, p1)}`)),
      h('div', { style: 'text-align:center;color:var(--muted);font-size:11px;margin-top:10px;letter-spacing:.1em;text-transform:uppercase' }, `${tapWord()} to continue`),
    );
    return el;
  }

  private shoeRow(s: ShoeResult, names: [string, string], metric: boolean): HTMLElement {
    let res: string, cls: string;
    if (s.foul) { res = 'Foul'; cls = 'out'; }
    else if (s.ringer) { res = 'Ringer'; cls = 'ringer'; }
    else if (s.leaner) { res = 'Leaner'; cls = 'count'; }
    else if (s.inCount) { res = formatDistance(s.distance, metric); cls = 'count'; }
    else { res = `Out · ${formatDistance(s.distance, metric)}`; cls = 'out'; }
    return h('div', { class: 'shoe-row' }, h('span', { class: `dot p${s.owner}` }), h('span', null, names[s.owner]), h('span', { class: `res ${cls}` }, res));
  }

  gameOver(m: Match, names: [string, string], humanIndex: number | null, onContinue: () => void, extra?: string) {
    const won = humanIndex !== null && m.winner === humanIndex;
    const st = m.stats;
    const r = (k: string, a: string, b: string) => h('tr', null, h('td', null, k), h('td', { class: 'n', style: 'color:var(--p0)' }, a), h('td', { class: 'n', style: 'color:var(--p1)' }, b));
    const pps = (s: PlayerStats) => (s.shoes ? (s.countPoints / s.shoes).toFixed(2) : '0.00');
    this.mount('gameover', h('div', { class: 'screen dim', style: 'justify-content:center' },
      h('div', { style: 'text-align:center;margin-bottom:16px' },
        h('div', { class: 'logo', style: 'font-size:clamp(48px,15vw,84px)' }, humanIndex === null ? 'FINAL' : won ? 'VICTORY' : 'DEFEAT'),
        h('div', { style: 'font:600 15px var(--head);letter-spacing:.2em;color:var(--muted);text-transform:uppercase;margin-top:8px' }, `${names[m.winner!]} ${names[m.winner!] === 'You' ? 'win' : 'wins'} ${Math.max(...m.scores)}–${Math.min(...m.scores)}`),
        extra ? h('div', { style: 'margin-top:8px;color:var(--gold);font:600 14px var(--head);letter-spacing:.1em;text-transform:uppercase' }, extra) : null,
      ),
      h('div', { class: 'panel', style: 'margin-bottom:16px' }, h('table', { class: 'std' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', { class: 'n' }, names[0]), h('th', { class: 'n' }, names[1]))),
        h('tbody', null,
          r('Score', String(m.scores[0]), String(m.scores[1])),
          r('Ringer %', `${ringerPct(st[0]).toFixed(1)}%`, `${ringerPct(st[1]).toFixed(1)}%`),
          r('Ringers', String(st[0].ringers), String(st[1].ringers)),
          r('Double ringers', String(st[0].doubles), String(st[1].doubles)),
          r('Shoes in count', String(st[0].inCount), String(st[1].inCount)),
          r('Points per shoe', pps(st[0]), pps(st[1])),
          r('Shoes pitched', String(st[0].shoes), String(st[1].shoes)),
        ),
      )),
      h('button', { class: 'btn primary center', onclick: () => { this.a.tap('confirm'); onContinue(); } }, 'Continue'),
    ));
  }

  pauseMenu(inPractice: boolean) {
    const modal = h('div', { class: 'modal', 'data-kind': 'pause' }, h('div', { class: 'panel', style: 'display:grid;gap:10px' },
      h('div', { style: 'font:700 24px var(--head);text-transform:uppercase;text-align:center;margin-bottom:4px' }, 'Paused'),
      h('button', { class: 'btn primary center', onclick: () => { modal.remove(); this.a.resume(); } }, 'Resume'),
      h('button', { class: 'btn center', onclick: () => { modal.remove(); this.tutorial(() => this.a.resume()); } }, 'How to pitch'),
      h('button', { class: 'btn center', onclick: () => {
        modal.remove();
        this.settings(() => { this.clearScreens(); this.a.resume(); });
      } }, 'Settings'),
      h('button', { class: 'btn center', style: 'color:var(--red)', onclick: () => { modal.remove(); this.a.quitToMenu(); } }, inPractice ? 'End practice' : 'Quit match'),
    ));
    overlayRoot().append(modal);
  }

  versus(names: [string, string], subs: [string, string], title: string) {
    const el = h('div', { class: 'screen', style: 'justify-content:center;pointer-events:none;background:radial-gradient(circle at 50% 50%,rgba(8,11,16,.6),rgba(8,11,16,0) 70%)' },
      h('div', { style: 'text-align:center;font:600 13px var(--head);letter-spacing:.3em;color:var(--gold);text-transform:uppercase;margin-bottom:14px' }, title),
      h('div', { class: 'vs' },
        h('div', null, h('div', { class: 'who', style: 'color:var(--p0);font-size:26px' }, names[0]), h('div', { class: 'meta' }, subs[0])),
        h('div', { class: 'x', style: 'font-size:22px' }, 'VS'),
        h('div', null, h('div', { class: 'who', style: 'color:var(--p1);font-size:26px' }, names[1]), h('div', { class: 'meta' }, subs[1])),
      ),
    );
    this.mount('versus', el);
  }

  // ---------------------------------------------------------------- tags

  setTags(tags: { text: string; pos: THREE.Vector3; cls: string }[]) {
    this.clearTags();
    for (const t of tags) {
      const el = h('div', { class: `tag ${t.cls}` }, t.text);
      this.labels.append(el);
      this.tags.push({ el, pos: t.pos.clone() });
    }
  }

  clearTags() {
    for (const t of this.tags) t.el.remove();
    this.tags = [];
  }

  updateTags(camera: THREE.Camera) {
    if (!this.tags.length) return;
    const v = new THREE.Vector3();
    const W = window.innerWidth, H = window.innerHeight;
    for (const t of this.tags) {
      v.copy(t.pos).project(camera);
      const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      t.el.style.opacity = vis ? '1' : '0';
      t.el.style.left = `${((v.x + 1) / 2) * W}px`;
      t.el.style.top = `${((1 - v.y) / 2) * H}px`;
    }
  }
}
