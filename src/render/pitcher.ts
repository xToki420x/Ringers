import * as THREE from 'three';
import { BODY_MATS, BONE, BONES, buildSkeleton, type BodyMat, type BodyMesh } from './humanBody';

/**
 * A pitcher: the generated seamless body as a skinned mesh, dressed with a
 * cap and wraparound sunglasses, driven by a procedural underhand delivery —
 * set, backswing, step with the opposite foot, release beside the hip,
 * follow-through — and a relaxed idle while waiting.
 */

export interface PitcherLook {
  shirt: string;
  pants: string;
  skin: string;
  cap: string;
  shoes: string;
  hair: string;
}

export const LOOKS: PitcherLook[] = [
  { shirt: '#14427e', pants: '#22324d', skin: '#d39a72', cap: '#0c1b33', shoes: '#efeee9', hair: '#2e2116' },
  { shirt: '#9e1b22', pants: '#33363c', skin: '#a2673f', cap: '#16181b', shoes: '#262626', hair: '#120d09' },
];

/** Surface response per garment: roughness, sheen. */
const SURF: Record<BodyMat, [number, number]> = {
  skin: [0.5, 0.18],
  shirt: [0.82, 0.35],
  pants: [0.88, 0.3],
  belt: [0.34, 0],
  shoe: [0.38, 0.05],
  sole: [0.85, 0],
  hair: [0.5, 0.7],
};

function albedo(m: BodyMat, look: PitcherLook): THREE.Color {
  switch (m) {
    case 'skin': return new THREE.Color(look.skin);
    case 'shirt': return new THREE.Color(look.shirt);
    case 'pants': return new THREE.Color(look.pants);
    case 'belt': return new THREE.Color('#3a2416');
    case 'shoe': return new THREE.Color(look.shoes);
    case 'sole': return new THREE.Color('#a8794a');
    case 'hair': return new THREE.Color(look.hair);
  }
}

/** One draw call for the whole body: per-vertex albedo, roughness and cloth sheen. */
function dressedBody(body: BodyMesh, look: PitcherLook): { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalMaterial } {
  const src = body.geometry;
  const geo = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'skinIndex', 'skinWeight']) geo.setAttribute(name, src.getAttribute(name));
  geo.setIndex(src.getIndex());
  const ao = src.getAttribute('color');
  const n = ao.count;
  const col = new Float32Array(n * 3);
  const surf = new Float32Array(n * 2);
  const alb = BODY_MATS.map((m) => albedo(m, look));
  const tmp = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = body.vmats[i * 2], b = body.vmats[i * 2 + 1], w = body.vmatW[i];
    tmp.copy(alb[b]).lerp(alb[a], w).multiplyScalar(ao.getX(i));
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
    const sa = SURF[BODY_MATS[a]], sb = SURF[BODY_MATS[b]];
    surf[i * 2] = sb[0] + (sa[0] - sb[0]) * w;
    surf[i * 2 + 1] = sb[1] + (sa[1] - sb[1]) * w;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
  geo.boundingSphere = src.boundingSphere;
  const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.7, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(1, 1, 1), specularIntensity: 0.6 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vSurf.x;')
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor = sheenColor * vSurf.y * clamp(vColor.rgb * 2.2, 0.0, 1.0);\n#endif',
      );
  };
  return { geometry: geo, material };
}

/** Cap (crown, brim, button) and sunglasses, in head-bone space. */
function accessories(look: PitcherLook): THREE.Group {
  const g = new THREE.Group();
  const head = BONES[BONE.head].head;
  const cx = 0, cy = 1.668 - head[1], cz = 0.008 - head[2];
  const capMat = new THREE.MeshPhysicalMaterial({ color: look.cap, roughness: 0.72, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color(look.cap).lerp(new THREE.Color(1, 1, 1), 0.35) });
  const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.52), capMat);
  crown.scale.set(0.088, 0.085, 0.102);
  crown.position.set(cx, cy + 0.008, cz - 0.004);
  crown.rotation.x = -0.12;
  // Curved brim from an extruded, bevelled half-ellipse.
  const shape = new THREE.Shape();
  shape.moveTo(-0.08, 0);
  shape.absellipse(0, 0, 0.08, 0.075, Math.PI, 0, true);
  shape.lineTo(-0.08, 0);
  const brimGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 3, curveSegments: 40 });
  const bp = brimGeo.getAttribute('position');
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), y = bp.getY(i);
    bp.setZ(i, bp.getZ(i) - (x * x) * 2.2 - y * 0.05);
  }
  brimGeo.computeVertexNormals();
  const brim = new THREE.Mesh(brimGeo, capMat);
  brim.rotation.x = Math.PI / 2 - 0.2;
  brim.position.set(cx, cy + 0.02, cz + 0.07);
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.009, 16, 8), capMat);
  button.position.set(cx, cy + 0.093, cz - 0.012);
  // Wraparound sunglasses.
  const lensMat = new THREE.MeshPhysicalMaterial({ color: '#0b0d10', metalness: 0.8, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.6, iridescenceIOR: 1.8 });
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.086, 0.038, 48, 1, true, -1.2, 2.4), lensMat);
  lens.position.set(cx, cy - 0.02, cz - 0.004);
  lens.material.side = THREE.DoubleSide;
  const frameMat = new THREE.MeshPhysicalMaterial({ color: '#111', roughness: 0.3, clearcoat: 0.6 });
  for (const s of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.006, 0.085), frameMat);
    arm.position.set(cx + s * 0.083, cy - 0.012, cz - 0.04);
    g.add(arm);
  }
  for (const m of [crown, brim, button, lens]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export class Pitcher {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  private readonly b: THREE.Bone[];
  private readonly bind: THREE.Vector3[];
  /** Attachment point in the throwing hand. */
  hand: THREE.Object3D;
  private readonly hands: [THREE.Object3D, THREE.Object3D];
  private t = -1;
  private idleT = Math.random() * 10;
  private arm: 0 | 1 = 1;

  /** Seconds into the delivery at which the shoe leaves the hand. */
  static readonly RELEASE_AT = 0.62;
  static readonly DURATION = 1.6;

  constructor(body: BodyMesh, look: PitcherLook) {
    const { bones, skeleton } = buildSkeleton();
    this.b = bones;
    this.bind = bones.map((x) => x.position.clone());
    const dressed = dressedBody(body, look);
    this.mesh = new THREE.SkinnedMesh(dressed.geometry, dressed.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.add(bones[0]);
    this.mesh.bind(skeleton);
    this.root.add(this.mesh);
    bones[BONE.head].add(accessories(look));
    // Hand attachment points at the palm (index 0 = left hand, 1 = right hand).
    const mk = (bone: number, sx: number) => {
      const o = new THREE.Object3D();
      o.position.set(sx * 0.004, -0.05, 0.01);
      bones[bone].add(o);
      return o;
    };
    this.hands = [mk(BONE.handL, 1), mk(BONE.handR, -1)];
    this.hand = this.hands[1];
  }

  setHand(hand: 1 | -1) {
    this.arm = hand === 1 ? 1 : 0;
    this.hand = this.hands[this.arm];
  }

  startDelivery(at = 0) {
    this.t = at;
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

  private bone(name: string) {
    return this.b[BONE[name]];
  }

  private pose() {
    const right = this.arm === 1;
    const A = right ? 'R' : 'L';
    const O = right ? 'L' : 'R';
    const side = right ? 1 : -1;
    const ease = (x: number) => x * x * (3 - 2 * x);
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    // Idle: gentle breathing and weight shift.
    let armSwing = Math.sin(this.idleT * 1.1) * 0.025; // + = forward
    let lean = 0.03 + Math.sin(this.idleT * 0.7) * 0.01;
    let crouch = 0;
    let step = 0;
    let follow = 0;
    let twist = Math.sin(this.idleT * 0.45) * 0.03;
    let wrist = 0;
    if (this.t >= 0) {
      const t = this.t;
      // 0–0.12 set, 0.12–0.5 backswing, 0.5–0.62 forward swing, release, follow-through, relax.
      const back = ease(clamp((t - 0.12) / 0.38));
      const fwd = ease(clamp((t - 0.5) / 0.14));
      const thru = ease(clamp((t - 0.62) / 0.32));
      const relax = ease(clamp((t - 1.05) / 0.55));
      armSwing = (-1.2 * back * (1 - fwd) + 0.32 * fwd + 0.95 * thru) * (1 - relax);
      lean = 0.03 + 0.42 * back * (1 - relax * 0.9);
      crouch = 0.14 * back * (1 - relax);
      step = ease(clamp((t - 0.36) / 0.24)) * (1 - relax * 0.7);
      follow = thru * (1 - relax);
      twist = side * (-0.2 * back * (1 - fwd) + 0.14 * follow);
      wrist = -0.5 * back * (1 - fwd) + 0.3 * thru * (1 - relax);
    }
    const hips = this.b[BONE.hips];
    hips.position.copy(this.bind[BONE.hips]);
    hips.position.y -= crouch * 0.5;
    hips.position.z += step * 0.12;
    hips.rotation.set(0, twist * 0.4, 0);
    this.bone('spine').rotation.set(lean * 0.45, twist * 0.3, 0);
    this.bone('chest').rotation.set(lean * 0.5, twist * 0.5, 0);
    this.bone('neck').rotation.set(-lean * 0.4, -twist * 0.4, 0);
    this.bone('head').rotation.set(-lean * 0.5, -twist * 0.3, 0);
    // Pitching arm swings in the sagittal plane (rotation about X; positive = back).
    this.bone(`upperArm${A}`).rotation.set(-armSwing, 0, side * 0.04 * (1 - Math.abs(armSwing)));
    this.bone(`forearm${A}`).rotation.set(-0.12 - Math.max(0, armSwing) * 0.3, 0, 0);
    this.bone(`hand${A}`).rotation.set(wrist, 0, 0);
    // Balance arm comes forward and out.
    const bal = crouch * 5;
    this.bone(`upperArm${O}`).rotation.set(-0.2 - 0.5 * bal * (1 - step * 0.3), 0, -side * (0.08 + 0.25 * bal));
    this.bone(`forearm${O}`).rotation.set(-0.45 - 0.3 * bal, 0, 0);
    this.bone(`hand${O}`).rotation.set(-0.1, 0, 0);
    // Step with the opposite foot; trailing knee bends; feet stay flat.
    const hipO = -0.42 * step - crouch * 1.25;
    const kneeO = 0.22 * step + crouch * 2.3;
    const hipA = 0.18 * step - crouch * 1.15;
    const kneeA = crouch * 2.2 + 0.16 * step;
    this.bone(`thigh${O}`).rotation.set(hipO, 0, 0);
    this.bone(`shin${O}`).rotation.set(kneeO, 0, 0);
    this.bone(`foot${O}`).rotation.set(-(hipO + kneeO) - lean * 0.0, 0, 0);
    this.bone(`thigh${A}`).rotation.set(hipA, 0, 0);
    this.bone(`shin${A}`).rotation.set(kneeA, 0, 0);
    this.bone(`foot${A}`).rotation.set(-(hipA + kneeA) + follow * 0.35, 0, 0);
  }
}
