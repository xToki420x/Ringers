/**
 * All game audio is synthesised with WebAudio — no sample files.
 *  - Stake clang: modal synthesis of a struck steel rod (inharmonic partials
 *    with individual decays), brightness and level scale with impact speed;
 *    softer shoes damp the high partials.
 *  - Shoe-on-shoe clink, sand/clay thump, board knock.
 *  - Swing whoosh, crowd applause and cheers, ambient park wind and
 *    distant clangs from other courts.
 */

export type Hardness = 'soft' | 'medium' | 'hard';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private noise!: AudioBuffer;
  private reverb!: ConvolverNode;
  private ambientStarted = false;
  private volume = 0.8;
  private lastPlay = new Map<string, number>();

  /** Must be called from a user gesture (iOS). */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.5;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(1.6, 2.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.18;
    this.sfxBus.connect(this.master);
    this.sfxBus.connect(this.reverb);
    this.reverb.connect(wet);
    wet.connect(this.master);
    this.ambBus.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend() {
    void this.ctx?.suspend();
  }

  resume() {
    void this.ctx?.resume();
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    if ((this.lastPlay.get(key) ?? 0) + ms > now) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  private pan(x: number): StereoPannerNode | GainNode {
    const ctx = this.ctx!;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, x));
      return p;
    }
    return ctx.createGain();
  }

  /** Struck steel: inharmonic partials of a free bar with exponential decays. */
  private steel(fund: number, level: number, decay: number, brightness: number, panX = 0, dest?: AudioNode) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const out = ctx.createGain();
    out.gain.value = level;
    const p = this.pan(panX);
    out.connect(p);
    p.connect(dest ?? this.sfxBus);
    const ratios = [1, 2.756, 5.404, 8.933, 13.34, 18.64];
    ratios.forEach((r, i) => {
      if (fund * r > ctx.sampleRate * 0.45) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fund * r * (1 + (Math.random() - 0.5) * 0.006);
      const g = ctx.createGain();
      const amp = Math.pow(brightness, i) * (i === 0 ? 0.6 : 0.5);
      const dk = decay / (1 + i * 0.8);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dk);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + dk + 0.05);
    });
    // Strike transient.
    this.noiseBurst(0.012, 3500, 0.5 * level * brightness, 'highpass', panX, dest);
  }

  private noiseBurst(dur: number, freq: number, level: number, type: BiquadFilterType, panX = 0, dest?: AudioNode, q = 0.7) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = this.pan(panX);
    src.connect(f);
    f.connect(g);
    g.connect(p);
    p.connect(dest ?? this.sfxBus);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  /** Shoe hits the stake. */
  stake(speed: number, hardness: Hardness, panX = 0) {
    if (!this.ctx || !this.throttle('stake', 60)) return;
    const v = Math.min(1, speed / 8);
    const damp = hardness === 'soft' ? 0.45 : hardness === 'medium' ? 0.7 : 1;
    this.steel(392 + Math.random() * 20, 0.25 + v * 0.75, 0.6 + 1.6 * damp, 0.35 + 0.35 * damp * v, panX);
    // The shoe itself rings too, higher.
    this.steel(1180 + Math.random() * 80, 0.12 + v * 0.3, 0.25 + 0.5 * damp, 0.3, panX);
  }

  /** Shoe on shoe. */
  clink(speed: number, panX = 0) {
    if (!this.ctx || !this.throttle('clink', 50)) return;
    const v = Math.min(1, speed / 6);
    this.steel(980 + Math.random() * 160, 0.12 + v * 0.45, 0.35, 0.45, panX);
  }

  /** Shoe lands in the pit. */
  thud(speed: number, kind: 'sand' | 'clay', panX = 0) {
    if (!this.ctx || !this.throttle('thud', 70)) return;
    const ctx = this.ctx;
    const v = Math.min(1, speed / 9);
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(kind === 'clay' ? 90 : 120, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 + v * 0.6, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const p = this.pan(panX);
    o.connect(g);
    g.connect(p);
    p.connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.25);
    this.noiseBurst(kind === 'sand' ? 0.22 : 0.1, kind === 'sand' ? 1800 : 600, 0.25 + v * 0.45, kind === 'sand' ? 'bandpass' : 'lowpass', panX);
  }

  /** Wooden board or backboard. */
  knock(speed: number, panX = 0) {
    if (!this.ctx || !this.throttle('knock', 60)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = Math.min(1, speed / 6);
    for (const f of [180, 410, 730]) {
      const o = ctx.createOscillator();
      o.frequency.value = f * (1 + (Math.random() - 0.5) * 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime((0.25 + v * 0.4) / (f / 180), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      const p = this.pan(panX);
      o.connect(g);
      g.connect(p);
      p.connect(this.sfxBus);
      o.start(t);
      o.stop(t + 0.2);
    }
  }

  whoosh(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(1500, t + 0.18);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * strength, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.5);
  }

  /** Crowd reaction: 0.3 polite, 1 ringer, 1.6 double ringer. */
  crowd(intensity: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const dur = 1.2 + intensity * 1.6;
    // Applause: many tiny filtered clicks.
    const claps = Math.floor(40 + intensity * 160);
    for (let i = 0; i < claps; i++) {
      const at = t0 + Math.random() * dur * Math.random();
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900 + Math.random() * 1800;
      f.Q.value = 1.5;
      const g = ctx.createGain();
      const lvl = (0.02 + Math.random() * 0.03) * Math.min(1.2, 0.4 + intensity * 0.6);
      g.gain.setValueAtTime(lvl, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.03 + Math.random() * 0.02);
      const p = this.pan((Math.random() - 0.5) * 1.6);
      src.connect(f);
      f.connect(g);
      g.connect(p);
      p.connect(this.sfxBus);
      src.start(at, Math.random() * 1.8);
      src.stop(at + 0.08);
    }
    if (intensity >= 0.9) {
      // Cheer: formant-filtered noise swell.
      for (const [fq, q] of [[650, 4], [1100, 5], [2400, 6]] as const) {
        const src = ctx.createBufferSource();
        src.buffer = this.noise;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = fq;
        f.Q.value = q;
        const g = ctx.createGain();
        const peak = 0.05 * Math.min(1.6, intensity);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(f);
        f.connect(g);
        g.connect(this.sfxBus);
        src.start(t0);
        src.stop(t0 + dur + 0.1);
      }
    }
  }

  /** Short UI tick / confirm. */
  ui(kind: 'tap' | 'confirm' | 'back' = 'tap') {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = kind === 'confirm' ? 880 : kind === 'back' ? 330 : 620;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }

  /** Bright chime layered on a ringer. */
  ringerChime(double = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const notes = double ? [784, 988, 1175, 1568] : [784, 1175];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g);
      g.connect(this.sfxBus);
      o.start(t);
      o.stop(t + 0.7);
    });
  }

  private startAmbient() {
    if (!this.ctx || this.ambientStarted) return;
    this.ambientStarted = true;
    const ctx = this.ctx;
    // Soft wind through the trees.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lg = ctx.createGain();
    lg.gain.value = 0.025;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(f);
    f.connect(g);
    g.connect(this.ambBus);
    src.start();
    lfo.start();
    // Distant ringers on other courts.
    const distant = () => {
      if (!this.ctx) return;
      const far = ctx.createBiquadFilter();
      far.type = 'lowpass';
      far.frequency.value = 2200;
      const fg = ctx.createGain();
      fg.gain.value = 0.25;
      far.connect(fg);
      fg.connect(this.ambBus);
      this.steel(380 + Math.random() * 60, 0.12 + Math.random() * 0.12, 1.2, 0.4, (Math.random() - 0.5) * 1.8, far);
      setTimeout(distant, 2500 + Math.random() * 6000);
    };
    setTimeout(distant, 3000);
  }

  setAmbient(on: boolean) {
    if (this.ctx) this.ambBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.3);
  }
}

export const sfx = new Sfx();

export function haptic(pattern: number | number[]) {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
