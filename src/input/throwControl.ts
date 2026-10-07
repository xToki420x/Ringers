import type { DeliveryError } from '../physics/throwModel';

/**
 * Touch delivery:
 *  1. Touch anywhere on the lower screen and PULL DOWN — the backswing.
 *     How far you pull sets power (watch the meter and its ideal zone).
 *  2. PUSH UP — the forward swing. Keep the stroke straight: sideways drift
 *     pulls the shoe off line, a wobbly stroke wobbles the shoe.
 *  3. LIFT your finger as it crosses the release line (where you first
 *     touched). Releasing on the line gives a perfect single flip; early
 *     under-rotates, late over-rotates.
 */

export type Difficulty = 'amateur' | 'pro' | 'world';

export const DIFFICULTY: Record<Difficulty, { name: string; assist: number; zone: number; band: number; blurb: string }> = {
  amateur: { name: 'Amateur', assist: 0.4, zone: 0.05, band: 0.045, blurb: 'Generous timing and a wide power zone.' },
  pro: { name: 'Pro', assist: 0.72, zone: 0.03, band: 0.03, blurb: 'Tournament feel. Small mistakes show.' },
  world: { name: 'World Class', assist: 1.0, zone: 0.02, band: 0.02, blurb: 'Raw physics. Every pixel counts.' },
};

/** Power-meter value that produces the ideal speed. */
export const P_IDEAL = 0.78;
/** Speed change across the full meter. */
const POWER_RANGE = 0.3;

export interface Gesture {
  power: number;
  error: DeliveryError;
  /** Diagnostics for the post-throw readout. */
  flipFactor: number;
  drift: number;
  wobbly: boolean;
}

type Phase = 'idle' | 'pull' | 'push';

export interface ThrowControlHooks {
  /** Swing −1 (full back) … +1 (release) for the held shoe / avatar. */
  onSwing(swing: number, power: number): void;
  onThrow(g: Gesture): void;
  onCancel(): void;
}

export class ThrowControl {
  private phase: Phase = 'idle';
  private pointerId = -1;
  private ax = 0;
  private ay = 0;
  private lowY = 0;
  private lowX = 0;
  private power = 0;
  private path: { x: number; y: number; t: number }[] = [];
  private ctx: CanvasRenderingContext2D;
  private enabled = false;
  difficulty: Difficulty = 'pro';
  showGuides = true;
  private dpr = 1;
  private hintPulse = 0;

  constructor(
    private readonly el: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly hooks: ThrowControlHooks,
  ) {
    this.ctx = canvas.getContext('2d')!;
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.cancel);
    this.resize();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
    this.draw();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.el.style.pointerEvents = on ? 'auto' : 'none';
    if (!on) this.reset();
    this.draw();
  }

  private get H() {
    return window.innerHeight;
  }
  private get W() {
    return window.innerWidth;
  }

  private reset() {
    this.phase = 'idle';
    this.pointerId = -1;
    this.path = [];
    this.power = 0;
  }

  private down = (e: PointerEvent) => {
    if (!this.enabled || this.phase !== 'idle') return;
    if (e.clientY < this.H * 0.28) return; // top of screen is for HUD/aim
    this.pointerId = e.pointerId;
    this.el.setPointerCapture?.(e.pointerId);
    this.ax = e.clientX;
    this.ay = e.clientY;
    this.lowY = e.clientY;
    this.lowX = e.clientX;
    this.power = 0;
    this.path = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    this.phase = 'pull';
    this.hooks.onSwing(0, 0);
    this.draw();
    e.preventDefault();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId || this.phase === 'idle') return;
    const x = e.clientX, y = e.clientY;
    const full = this.H * 0.36;
    if (this.phase === 'pull') {
      if (y > this.lowY) {
        this.lowY = y;
        this.lowX = x;
      }
      this.power = Math.min(1.15, Math.max(0, (this.lowY - this.ay) / full));
      if (this.lowY - y > 14 && this.power > 0.08) {
        this.phase = 'push';
        this.path = [{ x: this.lowX, y: this.lowY, t: performance.now() }];
      }
      this.hooks.onSwing(-Math.min(1, this.power / 1.0), this.power);
    } else {
      this.path.push({ x, y, t: performance.now() });
      const travel = (this.lowY - y) / Math.max(1, this.lowY - this.ay);
      this.hooks.onSwing(Math.max(-1, Math.min(1, -1 + travel)), this.power);
      // Auto-release if the finger runs off the top of the pad.
      if (y < this.H * 0.12) this.release(x, y);
    }
    this.draw();
    e.preventDefault();
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    if (this.phase === 'push') this.release(e.clientX, e.clientY);
    else {
      this.reset();
      this.hooks.onCancel();
      this.draw();
    }
  };

  private cancel = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.reset();
    this.hooks.onCancel();
    this.draw();
  };

  private release(x: number, y: number) {
    if (this.phase !== 'push') return;
    const H = this.H, W = this.W;
    const assist = DIFFICULTY[this.difficulty].assist;
    // Timing: distance of the release point from the release line (the first touch).
    const rel = (this.ay - y) / H; // + late, − early
    // Lateral drift of the forward stroke.
    const drift = (x - this.lowX) / W;
    // Wobble: how far the stroke strays from a straight line.
    let maxDev = 0;
    let signedDev = 0;
    const x0 = this.lowX, y0 = this.lowY;
    const lx = x - x0, ly = y - y0;
    const L = Math.hypot(lx, ly) || 1;
    for (const p of this.path) {
      const d = ((p.x - x0) * ly - (p.y - y0) * lx) / L;
      if (Math.abs(d) > Math.abs(maxDev)) maxDev = d;
      signedDev += d;
    }
    signedDev /= Math.max(1, this.path.length);
    const dev = Math.abs(maxDev) / W;
    const noise = () => (Math.random() - 0.5) * 2;
    const err: DeliveryError = {
      power: (this.power - P_IDEAL) * POWER_RANGE * assist + noise() * 0.0015 * assist,
      yaw: -drift * 0.032 * assist + noise() * 0.0004 * assist,
      rotation: rel * 1.5 * assist + noise() * 0.01 * assist,
      tilt: (signedDev / W) * 2.2 * assist,
      wobble: Math.max(0, dev - 0.006) * 14 * assist,
      wobbleDir: Math.random() * Math.PI * 2,
      arc: rel * 0.06 * assist,
    };
    const g: Gesture = { power: this.power, error: err, flipFactor: 1 + err.rotation, drift, wobbly: dev > 0.03 };
    this.reset();
    this.hooks.onSwing(1, g.power);
    this.hooks.onThrow(g);
    this.draw();
  }

  /** Repaint the guides (call each frame while enabled for the pulse animation). */
  draw(dt = 0) {
    const ctx = this.ctx;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.enabled) return;
    this.hintPulse += dt;
    const W = this.W, H = this.H;
    const diff = DIFFICULTY[this.difficulty];
    const full = H * 0.36;

    // Power meter on the side.
    const mx = W - 30, my0 = H * 0.3, my1 = H * 0.82;
    const mh = my1 - my0;
    const pToY = (p: number) => my1 - (p / 1.15) * mh;
    ctx.fillStyle = 'rgba(8,12,18,0.55)';
    roundRect(ctx, mx - 11, my0 - 8, 22, mh + 16, 11);
    ctx.fill();
    const zoneTop = pToY(P_IDEAL + diff.zone), zoneBot = pToY(P_IDEAL - diff.zone);
    if (this.showGuides) {
      ctx.fillStyle = 'rgba(80,220,120,0.35)';
      ctx.fillRect(mx - 9, zoneTop, 18, zoneBot - zoneTop);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(mx - 14, pToY(P_IDEAL));
    ctx.lineTo(mx + 14, pToY(P_IDEAL));
    ctx.stroke();
    const p = this.power;
    const grad = ctx.createLinearGradient(0, my1, 0, my0);
    grad.addColorStop(0, '#ffd166');
    grad.addColorStop(0.68, '#ff9f1c');
    grad.addColorStop(1, '#ef476f');
    ctx.fillStyle = grad;
    ctx.fillRect(mx - 6, pToY(p), 12, my1 - pToY(p));
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '600 10px Oswald, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('POWER', mx, my1 + 22);

    if (this.phase === 'idle') {
      // Gesture hint.
      const t = (this.hintPulse % 2.4) / 2.4;
      const cx = W / 2, cy = H * 0.62;
      const yOff = t < 0.45 ? (t / 0.45) * full * 0.75 : t < 0.8 ? full * 0.75 * (1 - (t - 0.45) / 0.35) - ((t - 0.45) / 0.35) * 10 : -10;
      ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy + yOff, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(cx, cy - 14);
      ctx.lineTo(cx, cy + full * 0.75);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      return;
    }

    const bandH = diff.band * H;
    // Release line (where the touch began).
    ctx.fillStyle = this.phase === 'push' ? 'rgba(80,220,120,0.32)' : 'rgba(80,220,120,0.16)';
    ctx.fillRect(0, this.ay - bandH, W - 50, bandH * 2);
    ctx.strokeStyle = 'rgba(120,255,160,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, this.ay);
    ctx.lineTo(W - 50, this.ay);
    ctx.stroke();
    ctx.fillStyle = 'rgba(200,255,215,0.95)';
    ctx.font = '600 12px Oswald, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('RELEASE', 10, this.ay - bandH - 6);

    // Straight-stroke guide.
    if (this.showGuides) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([3, 6]);
      ctx.beginPath();
      ctx.moveTo(this.phase === 'push' ? this.lowX : this.ax, this.lowY);
      ctx.lineTo(this.phase === 'push' ? this.lowX : this.ax, this.ay - bandH * 3);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Pull band.
    ctx.strokeStyle = 'rgba(255,209,102,0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(this.ax, this.ay);
    ctx.lineTo(this.lowX, this.lowY);
    ctx.stroke();
    // Stroke trail.
    if (this.path.length > 1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(this.path[0].x, this.path[0].y);
      for (const q of this.path) ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(this.ax, this.ay, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
