import * as THREE from 'three';
import { BODY_MATS, BONE, BONES, buildSkeleton, probeSurface, type BodyMat, type BodyMesh } from './humanBody';

/**
 * A pitcher: the generated seamless body as a skinned mesh, dressed with a
 * fitted cap, wraparound sunglasses, a polo collar and placket, a belt
 * buckle and a watch, driven by a procedural underhand delivery —
 * set, backswing, step with the opposite foot, release beside the hip,
 * follow-through — and a relaxed idle while waiting.
 */

export interface PitcherLook {
  shirt: string;
  pants: string;
  skin: string;
  cap: string;
  shoes: string;
  sole: string;
  hair: string;
}

export const LOOKS: PitcherLook[] = [
  { shirt: '#1b4f93', pants: '#273246', skin: '#d6a07a', cap: '#13233d', shoes: '#f1f0eb', sole: '#cfc9bd', hair: '#3b2a1c' },
  { shirt: '#a3212a', pants: '#383b42', skin: '#9a6240', cap: '#1a1b1e', shoes: '#2b2c30', sole: '#e8e5de', hair: '#140e0a' },
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
    case 'sole': return new THREE.Color(look.sole);
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

type V3 = [number, number, number];

/** Moves a mesh built in world (bind-pose) coordinates into a bone's space. */
function onBone(bones: THREE.Bone[], bone: number, ...meshes: THREE.Object3D[]) {
  const h = BONES[bone].head;
  for (const m of meshes) {
    m.position.x -= h[0];
    m.position.y -= h[1];
    m.position.z -= h[2];
    m.castShadow = true;
    bones[bone].add(m);
  }
}

/** Fabric with sheen tinted by its own colour, matching the body's garments. */
function cloth(color: string, roughness = 0.75) {
  const c = new THREE.Color(color);
  const tint = c.clone().multiplyScalar(2.2);
  tint.setRGB(Math.min(1, tint.r), Math.min(1, tint.g), Math.min(1, tint.b));
  return new THREE.MeshPhysicalMaterial({ color: c, roughness, sheen: 0.35, sheenRoughness: 0.5, sheenColor: tint });
}

/** Six-panel cap: crown, a brim that follows the crown's front edge, seams and a button. */
function cap(look: PitcherLook): THREE.Group {
  const frame = new THREE.Group();
  frame.position.set(0, 1.701, -0.012);
  frame.rotation.x = -0.16;
  const mat = cloth(look.cap, 0.72);
  const R: V3 = [0.089, 0.089, 0.108];
  const LOW = 0.58 * Math.PI;
  const crown = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 28, 0, Math.PI * 2, 0, LOW), mat);
  crown.scale.set(...R);
  frame.add(crown);
  // Panel seams and the sweatband edge as slim raised lines.
  const seamMat = cloth(new THREE.Color(look.cap).multiplyScalar(0.78).getStyle(), 0.8);
  const edgeY = Math.cos(LOW), edgeR = Math.sin(LOW);
  for (let k = 0; k < 6; k++) {
    const phi = (k / 6) * Math.PI * 2 + Math.PI / 6;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const th = (i / 16) * LOW;
      pts.push(new THREE.Vector3(Math.sin(th) * Math.sin(phi) * R[0] * 1.012, Math.cos(th) * R[1] * 1.012, Math.sin(th) * Math.cos(phi) * R[2] * 1.012));
    }
    frame.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.0012, 4), seamMat));
  }
  // Brim: inner edge on the crown's rim, reaching forward, drooping at the sides.
  const shape = new THREE.Shape();
  const th0 = 0.17 * Math.PI, N = 40;
  const inner = (t: number) => new THREE.Vector2(Math.cos(t) * R[0] * edgeR, Math.sin(t) * R[2] * edgeR);
  for (let i = 0; i <= N; i++) {
    const t = th0 + (i / N) * (Math.PI - 2 * th0);
    const p = inner(t);
    if (i === 0) shape.moveTo(p.x, p.y);
    else shape.lineTo(p.x, p.y);
  }
  for (let i = N; i >= 0; i--) {
    const t = th0 + (i / N) * (Math.PI - 2 * th0);
    const p = inner(t);
    const reach = 0.072 * Math.pow(Math.sin(t), 1.6);
    shape.lineTo(p.x * 1.05, p.y + reach);
  }
  const brimGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0014, bevelSize: 0.0014, bevelSegments: 2, curveSegments: 4 });
  brimGeo.rotateX(Math.PI / 2);
  const bp = brimGeo.getAttribute('position');
  const z0 = R[2] * edgeR * 0.9;
  for (let i = 0; i < bp.count; i++) {
    const x = bp.getX(i), z = bp.getZ(i);
    bp.setY(i, bp.getY(i) + edgeY * R[1] + 0.003 - x * x * 2.4 - Math.max(0, z - z0) * 0.32);
  }
  brimGeo.computeVertexNormals();
  frame.add(new THREE.Mesh(brimGeo, mat));
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.0075, 16, 8), mat);
  button.scale.y = 0.55;
  button.position.y = R[1];
  frame.add(button);
  frame.traverse((o) => (o.castShadow = true));
  return frame;
}

/** Wraparound sunglasses: two lenses curved around the face, frame, bridge and temples. */
function sunglasses(): THREE.Group {
  const g = new THREE.Group();
  const WR = 0.1, ZC = 0.006, YC = 1.656;
  const wrap = (u: number, y: number) => {
    const a = u / WR;
    return new THREE.Vector3(WR * Math.sin(a), y, ZC + WR * Math.cos(a) - (y - YC) * (y - YC) * 1.2);
  };
  const lensMat = new THREE.MeshPhysicalMaterial({ color: '#07090c', metalness: 0.6, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.7, iridescenceIOR: 1.8, side: THREE.DoubleSide });
  const frameMat = new THREE.MeshPhysicalMaterial({ color: '#15171a', roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.2 });
  for (const s of [1, -1]) {
    const uc = s * 0.034;
    // Lens outline in (arc length, height): a soft trapezoid, deeper at the outside, clear of the nose.
    const outline: THREE.Vector2[] = [];
    const M = 48;
    for (let i = 0; i < M; i++) {
      const t = (i / M) * Math.PI * 2;
      const c = Math.cos(t), sn = Math.sin(t);
      const ex = Math.sign(c) * Math.pow(Math.abs(c), 0.62);
      const ey = Math.sign(sn) * Math.pow(Math.abs(sn), 0.7);
      const outer = s * ex > 0 ? 1 : 0;
      const hh = 0.0165 + 0.003 * outer * Math.max(0, -ey);
      let y = YC + ey * hh + 0.002 * s * ex;
      const u = uc + ex * 0.0275;
      if (s * ex < -0.4 && ey < 0) y += 0.006 * (-ey) * (-s * ex - 0.4); // nose cut
      outline.push(new THREE.Vector2(u, y));
    }
    const geo = new THREE.ShapeGeometry(new THREE.Shape(outline), 8);
    const lp = geo.getAttribute('position');
    for (let i = 0; i < lp.count; i++) {
      const v = wrap(lp.getX(i), lp.getY(i));
      lp.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, lensMat));
    const ring = outline.map((p) => wrap(p.x, p.y).multiplyScalar(1).add(new THREE.Vector3(0, 0, 0.0008)));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ring, true), 64, 0.0019, 6, true), frameMat));
    // End piece and temple: round the side of the face, over the ear.
    const temple = new THREE.CatmullRomCurve3([
      wrap(s * 0.061, YC + 0.009),
      new THREE.Vector3(s * 0.079, YC + 0.01, 0.06),
      new THREE.Vector3(s * 0.088, YC + 0.014, 0.02),
      new THREE.Vector3(s * 0.088, YC + 0.018, -0.02),
      new THREE.Vector3(s * 0.082, YC + 0.004, -0.045),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(temple, 24, 0.0017, 6), frameMat));
  }
  const bridge = new THREE.CatmullRomCurve3([wrap(-0.009, YC + 0.012), wrap(0, YC + 0.009), wrap(0.009, YC + 0.012)]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(bridge, 8, 0.0019, 6), frameMat));
  return g;
}

/** Polo collar fitted to the shoulders, with an open placket and two buttons. */
function poloCollar(look: PitcherLook, bones: THREE.Bone[]) {
  // A shade darker than the shirt's albedo to sit with the body's baked occlusion.
  const mat = cloth(new THREE.Color(look.shirt).multiplyScalar(0.82).getStyle(), 0.8);
  mat.side = THREE.DoubleSide;
  const gap = 0.42, A = 36;
  // Profile from the neckline: up the stand, fold over, down onto the shoulders.
  const prof: [number, number][] = [[0.066, 1.448], [0.062, 1.47], [0.062, 1.486], [0.068, 1.492], [0.076, 1.484]];
  const pos: number[] = [];
  const idx: number[] = [];
  const K = prof.length + 2;
  for (let a = 0; a <= A; a++) {
    const phi = gap + (a / A) * (Math.PI * 2 - 2 * gap);
    const sx = Math.sin(phi), cz = Math.cos(phi) * 0.95;
    for (const [r, y] of prof) pos.push(r * sx, y, r * cz - 0.004);
    for (const r of [0.088, 0.1]) {
      const hit = probeSurface([r * sx, 1.53, r * cz - 0.004], [0, -1, 0]);
      pos.push(r * sx, (hit ? hit.y : 1.45) + 0.0035, r * cz - 0.004);
    }
    if (a > 0)
      for (let k = 0; k < K - 1; k++) {
        const i0 = (a - 1) * K + k, i1 = a * K + k;
        idx.push(i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
      }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const collar = new THREE.Mesh(geo, mat);
  // Placket strip and buttons, laid on the chest.
  const strip: number[] = [];
  const sIdx: number[] = [];
  const ys = [1.452, 1.43, 1.41, 1.39, 1.372];
  ys.forEach((y, i) => {
    for (const x of [-0.013, 0.013]) {
      const hit = probeSurface([x, y, 0.4], [0, 0, -1]);
      strip.push(x, y, (hit ? hit.z : 0.09) + 0.0022);
    }
    if (i > 0) sIdx.push(i * 2 - 2, i * 2, i * 2 - 1, i * 2, i * 2 + 1, i * 2 - 1);
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute(strip, 3));
  pg.setIndex(sIdx);
  pg.computeVertexNormals();
  const placket = new THREE.Mesh(pg, mat);
  const btnMat = new THREE.MeshPhysicalMaterial({ color: '#f3efe6', roughness: 0.25, clearcoat: 0.8 });
  const parts: THREE.Object3D[] = [collar, placket];
  for (const y of [1.432, 1.398]) {
    const hit = probeSurface([0, y, 0.4], [0, 0, -1]);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.0048, 0.0048, 0.0025, 14), btnMat);
    b.rotation.x = Math.PI / 2;
    b.position.set(0, y, (hit ? hit.z : 0.09) + 0.0035);
    parts.push(b);
  }
  onBone(bones, BONE.chest, ...parts);
}

function trims(look: PitcherLook, bones: THREE.Bone[]) {
  const head = BONES[BONE.head].head;
  const capFrame = cap(look);
  capFrame.position.x -= head[0];
  capFrame.position.y -= head[1];
  capFrame.position.z -= head[2];
  bones[BONE.head].add(capFrame);
  onBone(bones, BONE.head, sunglasses());
  poloCollar(look, bones);
  // Belt buckle.
  const metal = new THREE.MeshPhysicalMaterial({ color: '#c9c3b4', metalness: 1, roughness: 0.28 });
  const hit = probeSurface([0, 0.965, 0.4], [0, 0, -1]);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.032, 0.006), metal);
  buckle.position.set(0, 0.965, (hit ? hit.z : 0.1) + 0.002);
  onBone(bones, BONE.hips, buckle);
  // Watch on the left wrist.
  const fa = BONES[BONE.forearmL];
  const at = new THREE.Vector3(...fa.head).lerp(new THREE.Vector3(...fa.tail), 0.86);
  const axis = new THREE.Vector3(...fa.tail).sub(new THREE.Vector3(...fa.head)).normalize();
  const watch = new THREE.Group();
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.0055, 8, 32), new THREE.MeshPhysicalMaterial({ color: '#1c1d20', roughness: 0.6 }));
  strap.scale.set(0.78, 1, 1);
  watch.add(strap);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.008, 24), metal);
  face.rotation.z = Math.PI / 2;
  face.position.x = 0.026;
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.011, 24), new THREE.MeshPhysicalMaterial({ color: '#10161c', roughness: 0.05, clearcoat: 1 }));
  glass.rotation.y = Math.PI / 2;
  glass.position.x = 0.0305;
  watch.add(face, glass);
  watch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  watch.position.copy(at);
  watch.traverse((o) => (o.castShadow = true));
  onBone(bones, BONE.forearmL, watch);
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
    trims(look, bones);
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
