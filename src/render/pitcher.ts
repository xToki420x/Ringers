import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * A procedurally modelled pitcher with an animated underhand delivery:
 * set, backswing, step with the opposite foot, release beside the hip and a
 * follow-through, plus a relaxed idle sway while waiting.
 */

export interface PitcherLook {
  shirt: string;
  trim: string;
  pants: string;
  skin: string;
  cap: string;
  shoes: string;
}

export const LOOKS: PitcherLook[] = [
  { shirt: '#1f4e8c', trim: '#f2c14e', pants: '#2a3442', skin: '#e3b07c', cap: '#13294b', shoes: '#f2f2f2' },
  { shirt: '#a3262a', trim: '#ffffff', pants: '#3b3a36', skin: '#b97a4a', cap: '#1b1f24', shoes: '#3a2a1e' },
];

function lathe(points: [number, number][], segs = 20): THREE.LatheGeometry {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segs);
}

function tube(len: number, r0: number, r1: number, mat: THREE.Material, segs = 14): THREE.Mesh {
  // A tapered limb with rounded ends, hanging down from its joint.
  // Lathe profiles run bottom to top so faces point outward.
  const g = lathe([
    [0.0001, -len],
    [r1 * 0.7, -len + r1 * 0.3],
    [r1, -len + r1],
    [((r0 + r1) / 2) * 1.02, -len / 2],
    [r0, -r0],
    [r0 * 0.7, -r0 * 0.3],
    [0.0001, 0.0],
  ], segs);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

export class Pitcher {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private shoulder: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private elbow: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private hip: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private knee: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private hands: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  /** The throwing hand (follows handedness). */
  hand: THREE.Group;
  private t = -1;
  private idleT = Math.random() * 10;
  private arm: 0 | 1 = 1;

  static readonly RELEASE_AT = 0.62;
  static readonly DURATION = 1.5;

  constructor(look: PitcherLook) {
    const mat = (c: string, r = 0.8) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
    const shirt = mat(look.shirt, 0.75), trim = mat(look.trim, 0.6), pants = mat(look.pants, 0.9), skin = mat(look.skin, 0.55), cap = mat(look.cap, 0.7), shoes = mat(look.shoes, 0.5);
    this.root.add(this.hips);
    this.hips.position.y = 0.94;

    // Pelvis & belt.
    const pelvis = new THREE.Mesh(lathe([[0.0001, -0.12], [0.12, -0.11], [0.155, -0.04], [0.16, 0.04], [0.0001, 0.05]]), pants);
    pelvis.scale.z = 0.72;
    pelvis.castShadow = true;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.158, 0.018, 6, 24), mat('#2a1d14', 0.5));
    belt.rotation.x = Math.PI / 2;
    belt.scale.y = 0.72;
    belt.position.y = 0.04;
    this.hips.add(pelvis, belt);

    // Torso: waist to shoulders.
    this.hips.add(this.torso);
    this.torso.position.y = 0.05;
    const chest = new THREE.Mesh(lathe([[0.0001, 0], [0.15, 0.01], [0.165, 0.18], [0.19, 0.36], [0.17, 0.47], [0.1, 0.53], [0.0001, 0.54]], 24), shirt);
    chest.scale.z = 0.66;
    chest.castShadow = true;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.014, 6, 18), trim);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.53;
    this.torso.add(chest, collar);

    // Head, neck, cap.
    this.torso.add(this.head);
    this.head.position.y = 0.55;
    const neck = tube(0.09, 0.048, 0.05, skin, 10);
    neck.rotation.x = Math.PI;
    this.head.add(neck);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), skin);
    skull.scale.set(0.9, 1.08, 1);
    skull.position.y = 0.16;
    skull.castShadow = true;
    const ears = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), skin);
    ears.scale.set(0.5, 1, 1);
    ears.position.set(0.09, 0.15, 0);
    const ear2 = ears.clone();
    ear2.position.x = -0.09;
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), skin);
    nose.position.set(0, 0.14, 0.098);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.104, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    crown.scale.set(0.95, 0.85, 1.02);
    crown.position.y = 0.19;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.01, 20, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.scale.set(0.95, 1, 1.55);
    brim.position.set(0, 0.195, 0.035);
    brim.rotation.x = 0.12;
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), trim);
    button.position.y = 0.278;
    this.head.add(skull, ears, ear2, nose, crown, brim, button);

    // Arms. Index 1 is the right arm (−X when facing +Z).
    for (const s of [0, 1] as const) {
      const sx = s === 1 ? -1 : 1;
      const sh = this.shoulder[s];
      sh.position.set(sx * 0.2, 0.46, 0);
      this.torso.add(sh);
      const delt = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 10), shirt);
      delt.castShadow = true;
      sh.add(delt);
      const upper = tube(0.29, 0.058, 0.046, shirt);
      sh.add(upper);
      const el = this.elbow[s];
      el.position.y = -0.28;
      sh.add(el);
      el.add(tube(0.25, 0.044, 0.034, skin));
      const hand = this.hands[s];
      hand.position.y = -0.255;
      el.add(hand);
      const palm = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.09, 0.03, 2, 0.012), skin);
      palm.position.y = -0.04;
      palm.castShadow = true;
      hand.add(palm);
    }
    this.hand = this.hands[1];

    // Legs.
    for (const s of [0, 1] as const) {
      const sx = s === 1 ? -1 : 1;
      const h = this.hip[s];
      h.position.set(sx * 0.09, -0.06, 0);
      this.hips.add(h);
      h.add(tube(0.45, 0.085, 0.06, pants));
      const k = this.knee[s];
      k.position.y = -0.43;
      h.add(k);
      k.add(tube(0.43, 0.062, 0.05, pants));
      const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.075, 0.27, 2, 0.025), shoes);
      shoe.position.set(0, -0.44, 0.055);
      shoe.castShadow = true;
      const sole = new THREE.Mesh(new RoundedBoxGeometry(0.104, 0.02, 0.275, 1, 0.008), mat('#2b2b2b', 0.9));
      sole.position.set(0, -0.475, 0.055);
      k.add(shoe, sole);
    }
  }

  setHand(hand: 1 | -1) {
    this.arm = hand === 1 ? 1 : 0;
    this.hand = this.hands[this.arm];
  }

  startDelivery() {
    this.t = 0;
  }

  get delivering() {
    return this.t >= 0;
  }

  get deliveryTime() {
    return this.t;
  }

  update(dt: number) {
    this.idleT += dt;
    if (this.t >= 0) {
      this.t += dt;
      if (this.t > Pitcher.DURATION) this.t = -1;
    }
    this.pose();
  }

  private pose() {
    const A = this.arm, O = (1 - A) as 0 | 1;
    const side = A === 1 ? 1 : -1;
    const ease = (x: number) => x * x * (3 - 2 * x);
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    let armSwing = Math.sin(this.idleT * 1.1) * 0.03; // + = forward
    let lean = 0.04 + Math.sin(this.idleT * 0.7) * 0.01;
    let crouch = 0;
    let step = 0;
    let follow = 0;
    let twist = Math.sin(this.idleT * 0.5) * 0.03;
    if (this.t >= 0) {
      const t = this.t;
      // 0–0.15 set, 0.15–0.5 backswing, 0.5–0.62 forward swing, release, follow-through, relax.
      const back = ease(clamp((t - 0.12) / 0.38));
      const fwd = ease(clamp((t - 0.5) / 0.14));
      const thru = ease(clamp((t - 0.62) / 0.3));
      const relax = ease(clamp((t - 1.0) / 0.5));
      armSwing = (-1.25 * back * (1 - fwd) + 0.3 * fwd + 0.85 * thru) * (1 - relax);
      lean = 0.04 + 0.4 * back * (1 - relax * 0.9);
      crouch = 0.13 * back * (1 - relax);
      step = ease(clamp((t - 0.38) / 0.24)) * (1 - relax * 0.7);
      follow = thru * (1 - relax);
      twist = side * (-0.18 * back * (1 - fwd) + 0.12 * follow);
    }
    this.torso.rotation.set(lean, twist, 0);
    this.hips.position.y = 0.94 - crouch * 0.55;
    this.hips.position.z = step * 0.12;
    this.head.rotation.x = -lean * 0.85;
    // Pitching arm swings in the sagittal plane (rotation about X; positive = back).
    this.shoulder[A].rotation.set(-armSwing, 0, side * -0.05);
    this.elbow[A].rotation.x = -0.12 - Math.max(0, armSwing) * 0.25;
    this.hands[A].rotation.x = -0.3 * Math.max(0, armSwing);
    // Balance arm comes forward for balance.
    this.shoulder[O].rotation.set(-0.25 - 0.35 * crouch * 5 * (1 - step * 0.3), 0, -side * (0.12 + crouch));
    this.elbow[O].rotation.x = -0.55;
    // Step with the opposite foot; trailing knee bends.
    this.hip[O].rotation.x = -0.42 * step - crouch * 1.2;
    this.knee[O].rotation.x = 0.2 * step + crouch * 2.2;
    this.hip[A].rotation.x = 0.18 * step - crouch * 1.1;
    this.knee[A].rotation.x = crouch * 2.1 + 0.15 * step;
  }
}
